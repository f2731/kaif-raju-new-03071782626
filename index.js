require('dotenv').config();
const {
    DisconnectReason,
    jidNormalizedUser,
    proto
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const fs = require('fs');
const path = require('path');

const { wasi_connectSession, wasi_clearSession } = require('./wasilib/session');
const { wasi_connectDatabase } = require('./wasilib/database');

const config = require('./wasi');
const { cleanTempFiles } = require('./wasilib/cleaner');

// Load persistent config and merge with runtime config
const CONFIG_FILE = path.join(__dirname, 'botConfig.json');
try {
    if (fs.existsSync(CONFIG_FILE)) {
        const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
        Object.assign(config, savedConfig);
    }
} catch (e) {
    console.error('Failed to load botConfig.json:', e);
}

// Helper to save dynamic config state
function saveBotConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({
            sourceJids: config.sourceJids,
            targetJids: config.targetJids
        }, null, 2));
    } catch (e) {
        console.error('Failed to save botConfig.json:', e);
    }
}

const wasi_app = express();
const wasi_port = process.env.PORT || 3000;

const QRCode = require('qrcode');

// -----------------------------------------------------------------------------
// SESSION STATE
// -----------------------------------------------------------------------------
const sessions = new Map();

// Middleware
wasi_app.use(express.json());
wasi_app.use(express.static(path.join(__dirname, 'public')));

// Keep-Alive Route
wasi_app.get('/ping', (req, res) => res.status(200).send('pong'));
// Auto Clear Memory every 30 minutes
setInterval(() => {
    try {
        cleanTempFiles(true);
    } catch (e) {
        console.error('Auto clean error:', e.message);
    }
}, 30 * 60 * 1000);

// -----------------------------------------------------------------------------
// AUTO FORWARD CONFIGURATION (Heroku + Dynamic Config Merge)
// -----------------------------------------------------------------------------
function getSourceJids() {
    let envSources = process.env.SOURCE_JIDS ? process.env.SOURCE_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
    let savedSources = config.sourceJids || [];
    return Array.from(new Set([...envSources, ...savedSources]));
}

function getTargetJids() {
    let envTargets = process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
    let savedTargets = config.targetJids || [];
    return Array.from(new Set([...envTargets, ...savedTargets]));
}

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            console.error(`Invalid regex pattern: ${pattern}`, e);
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT
    ? process.env.NEW_TEXT
    : '';

// -----------------------------------------------------------------------------
// HELPER FUNCTIONS FOR MESSAGE CLEANING
// -----------------------------------------------------------------------------

function cleanForwardedLabel(message) {
    try {
        let cleanedMessage = JSON.parse(JSON.stringify(message));
        
        ['extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].forEach(msgType => {
            if (cleanedMessage[msgType]?.contextInfo) {
                cleanedMessage[msgType].contextInfo.isForwarded = false;
                if (cleanedMessage[msgType].contextInfo.forwardingScore) {
                    cleanedMessage[msgType].contextInfo.forwardingScore = 0;
                }
            }
        });
        
        return cleanedMessage;
    } catch (error) {
        console.error('Error cleaning forwarded label:', error);
        return message;
    }
}

function cleanNewsletterText(text) {
    if (!text) return text;
    
    const newsletterMarkers = [
        /📢\s*/g, /🔔\s*/g, /📰\s*/g, /🗞️\s*/g,
        /\[NEWSLETTER\]/gi, /\[BROADCAST\]/gi, /\[ANNOUNCEMENT\]/gi,
        /Newsletter:/gi, /Broadcast:/gi, /Announcement:/gi,
        /Forwarded many times/gi, /Forwarded message/gi, /This is a broadcast message/gi
    ];
    
    let cleanedText = text;
    newsletterMarkers.forEach(marker => {
        cleanedText = cleanedText.replace(marker, '');
    });
    
    return cleanedText.trim();
}

function replaceCaption(caption) {
    if (!caption) return caption;
    if (!OLD_TEXT_REGEX.length || !NEW_TEXT) return caption;
    
    let result = caption;
    OLD_TEXT_REGEX.forEach(regex => {
        result = result.replace(regex, NEW_TEXT);
    });
    return result;
}

// -----------------------------------------------------------------------------
// SESSION MANAGEMENT
// -----------------------------------------------------------------------------
async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const existing = sessions.get(sessionId);
        if (existing.isConnected && existing.sock) {
            console.log(`Session ${sessionId} is already connected.`);
            return;
        }

        if (existing.sock) {
            existing.sock.ev.removeAllListeners('connection.update');
            existing.sock.end(undefined);
            sessions.delete(sessionId);
        }
    }

    console.log(`🚀 Starting session: ${sessionId}`);

    const sessionState = {
        sock: null,
        isConnected: false,
        qr: null,
        reconnectAttempts: 0,
    };
    sessions.set(sessionId, sessionState);

    const { wasi_sock, saveCreds } = await wasi_connectSession(false, sessionId);
    sessionState.sock = wasi_sock;

    wasi_sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionState.qr = qr;
            sessionState.isConnected = false;
        }

        if (connection === 'close') {
            sessionState.isConnected = false;
            const statusCode = (lastDisconnect?.error instanceof Boom) ?
                lastDisconnect.error.output.statusCode : 500;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== 440;

            if (shouldReconnect) {
                setTimeout(() => { startSession(sessionId); }, 3000);
            } else {
                sessions.delete(sessionId);
                await wasi_clearSession(sessionId);
            }
        } else if (connection === 'open') {
            sessionState.isConnected = true;
            sessionState.qr = null;
            console.log(`✅ ${sessionId}: Connected to WhatsApp`);
        }
    });

    wasi_sock.ev.on('creds.update', saveCreds);

    const cleanJid = (id) => id ? id.split(':')[0].trim() : '';

    wasi_sock.ev.on('messages.upsert', async wasi_m => {
        try {
            const wasi_msg = wasi_m.messages[0];
            if (!wasi_msg || !wasi_msg.message) return;

            const rawFrom = wasi_msg.key.remoteJid;
            const cleanFrom = cleanJid(rawFrom);
            const msgContent = wasi_msg.message;

            const msgText = (
                msgContent.conversation || 
                msgContent.extendedTextMessage?.text || 
                msgContent.imageMessage?.caption || 
                msgContent.videoMessage?.caption || 
                ''
            ).trim();

            // 1. PING COMMAND
            if (msgText.toLowerCase() === '!ping') {
                await wasi_sock.sendMessage(rawFrom, { text: '⚡ Raju AutoForward Bot Online!' }, { quoted: wasi_msg });
                return;
            }

            // 2. JID COMMAND
            if (msgText.toLowerCase() === '!jid') {
                await wasi_sock.sendMessage(rawFrom, { text: `📍 JID: ${rawFrom}` }, { quoted: wasi_msg });
                return;
            }
            
            // 3. ALL GROUPS LIST
            if (msgText.toLowerCase() === '!gjid') {
                try {
                    const getGroups = await wasi_sock.groupFetchAllParticipating();
                    const groups = Object.values(getGroups);

                    if (groups.length === 0) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Koi group ya community nahi mili.' }, { quoted: wasi_msg });
                        return;
                    }

                    let txt = '📌 *Groups List:*\n\n';
                    groups.forEach((g, i) => {
                        const isComm = g.isCommunity || g.isCommunityAnnounce ? 'Community' : 'Group';
                        txt += `${i + 1}. 📲 *${g.subject}*\n👥 Members: ${g.participants ? g.participants.length : 'N/A'}\n🆔 : \`${g.id}\`\n📝 Type: ${isComm}\n__________________\n\n`;
                    });

                    await wasi_sock.sendMessage(rawFrom, { text: txt }, { quoted: wasi_msg });
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Error: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }

            // 4. JOIN GROUP COMMAND
            if (msgText.toLowerCase() === '!join') {
                try {
                    const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || quotedMsg?.imageMessage?.caption || '';
                    const match = quotedText.match(/chat\.whatsapp\.com\/([0-9A-Za-z]{20,24})/);
                    
                    if (!match) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam kisi aisay message ko reply karein jis mein WhatsApp group ka link ho!' }, { quoted: wasi_msg });
                        return;
                    }

                    const res = await wasi_sock.groupAcceptInvite(match[1]);
                    await wasi_sock.sendMessage(rawFrom, { text: `✅ Kamyabi se group join kar liya gaya hai! (ID: ${res})` }, { quoted: wasi_msg });
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Group join karne mein nakami: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }

            // =========================================================================
            // ⚙️ WHATSAPP DYNAMIC COMMANDS FOR MULTI-SOURCE & MULTI-TARGET MANAGEMENT
            // =========================================================================
            if (msgText.toLowerCase().startsWith('!addsource')) {
                const queryContent = msgText.slice(10).trim();
                const jidsToAdd = queryContent ? queryContent.split(/[\s,]+/).filter(Boolean) : [rawFrom];
                
                config.sourceJids = config.sourceJids || [];
                let addedCount = 0;
                let alreadyExists = 0;

                for (let jid of jidsToAdd) {
                    if (!config.sourceJids.includes(jid)) {
                        config.sourceJids.push(jid);
                        addedCount++;
                    } else {
                        alreadyExists++;
                    }
                }

                if (addedCount > 0) {
                    saveBotConfig();
                }

                await wasi_sock.sendMessage(rawFrom, { text: `✅ Successfully added ${addedCount} source JID(s).\n⚠️ Already existing: ${alreadyExists}` }, { quoted: wasi_msg });
                return;
            }

            if (msgText.toLowerCase().startsWith('!rmsource')) {
                const parts = msgText.split(' ');
                const targetJidToRm = parts[1] ? parts[1].trim() : rawFrom;
                
                config.sourceJids = config.sourceJids || [];
                config.sourceJids = config.sourceJids.filter(id => id !== targetJidToRm);
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: `🗑️ Removed source JID:\n\`${targetJidToRm}\`` }, { quoted: wasi_msg });
                return;
            }

            if (msgText.toLowerCase().startsWith('!addtarget')) {
                const queryContent = msgText.slice(10).trim();
                const jidsToAdd = queryContent ? queryContent.split(/[\s,]+/).filter(Boolean) : [rawFrom];
                
                config.targetJids = config.targetJids || [];
                let addedCount = 0;
                let alreadyExists = 0;

                for (let jid of jidsToAdd) {
                    if (!config.targetJids.includes(jid)) {
                        config.targetJids.push(jid);
                        addedCount++;
                    } else {
                        alreadyExists++;
                    }
                }

                if (addedCount > 0) {
                    saveBotConfig();
                }

                await wasi_sock.sendMessage(rawFrom, { text: `✅ Successfully added ${addedCount} target JID(s).\n⚠️ Already existing: ${alreadyExists}` }, { quoted: wasi_msg });
                return;
            }

            if (msgText.toLowerCase().startsWith('!rmtarget')) {
                const parts = msgText.split(' ');
                const targetJidToRm = parts[1] ? parts[1].trim() : rawFrom;
                
                config.targetJids = config.targetJids || [];
                config.targetJids = config.targetJids.filter(id => id !== targetJidToRm);
                saveBotConfig();
                await wasi_sock.sendMessage(rawFrom, { text: `🗑️ Removed target JID:\n\`${targetJidToRm}\`` }, { quoted: wasi_msg });
                return;
            }

            if (msgText.toLowerCase() === '!viewlists') {
                const sources = getSourceJids();
                const targets = getTargetJids();
                let listText = `📋 *Current Forwarding Setup:*\n\n`;
                listText += `📥 *Source JIDs (${sources.length}):*\n`;
                sources.forEach((s, i) => listText += `${i + 1}. \`${s}\`\n`);
                listText += `\n📤 *Target JIDs (${targets.length}):*\n`;
                targets.forEach((t, i) => listText += `${i + 1}. \`${t}\`\n`);

                await wasi_sock.sendMessage(rawFrom, { text: listText }, { quoted: wasi_msg });
                return;
            }
             
            // =========================================================================
            // FORWARDING LOGIC
            // =========================================================================
            const sourceList = getSourceJids().map(id => cleanJid(id));
            if (sourceList.length > 0 && !sourceList.some(src => cleanFrom.includes(src))) return;

            const targetList = getTargetJids().map(id => id.trim()).filter(Boolean);
            if (targetList.length === 0) return;

            const allowedTypes = (process.env.FORWARD_TYPES || 'video,image,document')
                .toLowerCase()
                .split(',')
                .map(t => t.trim());

            const isVideo = !!(msgContent.videoMessage);
            const isImage = !!(msgContent.imageMessage);
            const isText = !!(msgContent.conversation || msgContent.extendedTextMessage);
            const isDocument = !!(msgContent.documentMessage);
            const isSticker = !!(msgContent.stickerMessage);

            let shouldForward = false;
            if (isVideo && allowedTypes.includes('video')) shouldForward = true;
            if (isImage && allowedTypes.includes('image')) shouldForward = true;
            if (isText && allowedTypes.includes('text')) shouldForward = true;
            if (isDocument && allowedTypes.includes('document')) shouldForward = true;
            if (isSticker && allowedTypes.includes('sticker')) shouldForward = true;

            if (shouldForward) {
                for (const targetJid of targetList) {
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            let cleanMessage = JSON.parse(JSON.stringify(wasi_msg.message));

                            for (const type of Object.keys(cleanMessage)) {
                                if (cleanMessage[type]?.contextInfo) {
                                    delete cleanMessage[type].contextInfo.forwardingScore;
                                    delete cleanMessage[type].contextInfo.isForwarded;
                                    cleanMessage[type].contextInfo.participant = "Raju Boss +923071782626";
                                }
                            }

                            try {
                                await wasi_sock.sendMessage(targetJid, cleanMessage);
                            } catch (mediaErr) {
                                await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });
                            }

                            console.log(`[+] Message forwarded to ${targetJid}`);
                            break;
                        } catch (err) {
                            console.error(`[!] Attempt ${attempt} failed for ${targetJid}:`, err.message);
                            if (attempt < 3) await new Promise(res => setTimeout(res, 3000));
                        }
                    }
                    await new Promise(res => setTimeout(res, 1500));
                }
            }

        } catch (e) {
            console.error('❌ General Error:', e.message);
        }
    });
}

// ============================================================
// 🚀 ALL APIS
// ============================================================

wasi_app.get('/api/status', async (req, res) => {
    const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
    const session = sessions.get(sessionId);

    let qrDataUrl = null;
    let connected = false;
    let dbConnected = !!config.mongoDbUrl;

    if (session) {
        connected = session.isConnected;
        if (session.qr) {
            try {
                qrDataUrl = await QRCode.toDataURL(session.qr, { width: 256 });
            } catch (e) { }
        }
    }

    res.json({
        sessionId,
        connected,
        qr: qrDataUrl,
        dbConnected,
        dbConfigured: !!config.mongoDbUrl,
        phoneNumber: connected ? 'Connected ✅' : '-',
        lastActive: new Date().toISOString(),
        activeSessions: Array.from(sessions.keys())
    });
});

wasi_app.post('/api/restart', async (req, res) => {
    try {
        for (const [sessionId, session] of sessions) {
            if (session.sock) { try { session.sock.end(undefined); } catch (e) {} }
        }
        sessions.clear();
        setTimeout(() => { main().catch(err => console.error(err)); }, 1000);
        res.json({ success: true, message: 'Bot restarting...' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.post('/api/logout', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || config.sessionId || 'wasi_session';
        const session = sessions.get(sessionId);
        
        if (session && session.sock) {
            try { await session.sock.logout(); } catch (e) {}
            sessions.delete(sessionId);
            await wasi_clearSession(sessionId);
        }
        
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

wasi_app.get('/api/sessions', async (req, res) => {
    const sessionList = Array.from(sessions.keys()).map(id => ({
        sessionId: id,
        isConnected: sessions.get(id)?.isConnected || false
    }));
    res.json({ success: true, sessions: sessionList, total: sessionList.length });
});

wasi_app.get('/api/health', async (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        sessions: sessions.size
    });
});

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🤖 Bot Commands active: !ping, !jid, !gjid, !join, !addsource, !addtarget, !viewlists`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// ---------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
