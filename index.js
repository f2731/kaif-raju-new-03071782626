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
// AUTO FORWARD CONFIGURATION
// -----------------------------------------------------------------------------
function getSourceJids() {
    return process.env.SOURCE_JIDS ? process.env.SOURCE_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
}

function getTargetJids() {
    return process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
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
                msgContent.documentMessage?.caption ||
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
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam kisi aisay message کو reply karein jis mein WhatsApp group ka link ho!' }, { quoted: wasi_msg });
                        return;
                    }

                    const res = await wasi_sock.groupAcceptInvite(match[1]);
                    await wasi_sock.sendMessage(rawFrom, { text: `✅ Kamyabi se group join kar liya gaya hai! (ID: ${res})` }, { quoted: wasi_msg });
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Group join karne mein nakami: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }

            // 5. MANUAL FORWARD COMMAND (!forward) - UPDATED FOR DOCUMENTS & MEDIA
            if (msgText.toLowerCase().startsWith('!forward')) {
                try {
                    const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    if (!quotedMsg) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam us message ko reply karke !forward likhen jo aap bhejwana chahte hain!' }, { quoted: wasi_msg });
                        return;
                    }

                    let forwardContent = JSON.parse(JSON.stringify(quotedMsg));
                    if (forwardContent.viewOnceMessageV2) {
                        forwardContent = forwardContent.viewOnceMessageV2.message;
                    } else if (forwardContent.viewOnceMessage) {
                        forwardContent = forwardContent.viewOnceMessage.message;
                    } else if (forwardContent.documentWithCaptionMessage) {
                        forwardContent = forwardContent.documentWithCaptionMessage.message;
                    }

                    const args = msgText.split(' ');
                    let targetList = [];

                    if (args.length > 1 && args[1].includes('@')) {
                        targetList = [args[1].trim()];
                    } else {
                        targetList = getTargetJids();
                    }

                    if (targetList.length === 0) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Koi target JID configure nahi hai!' }, { quoted: wasi_msg });
                        return;
                    }

                    let successCount = 0;
                    for (const targetJid of targetList) {
                        try {
                            let finalPayload = JSON.parse(JSON.stringify(forwardContent));
                            
                            const messageTypes = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];
                            for (const type of messageTypes) {
                                if (finalPayload[type]?.contextInfo) {
                                    delete finalPayload[type].contextInfo.forwardingScore;
                                    delete finalPayload[type].contextInfo.isForwarded;
                                    finalPayload[type].contextInfo.participant = "Raju Boss +923071782626";
                                }
                            }

                            await wasi_sock.relayMessage(targetJid, finalPayload, { messageId: wasi_msg.key.id });
                            successCount++;
                        } catch (mediaErr) {
                            console.error(`Forward error for ${targetJid}:`, mediaErr.message);
                        }
                        await new Promise(resolve => setTimeout(resolve, 800));
                    }

                    if (successCount > 0) {
                        await wasi_sock.sendMessage(rawFrom, { text: '✅ Message (Document/Media) kamyabi se forward kar diya gaya hai!' }, { quoted: wasi_msg });
                    } else {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Message forward nahi ho saka. Console log check karein.' }, { quoted: wasi_msg });
                    }
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Forward karne mein nakami: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }
             
            // =========================================================================
            // ⚡ FORWARD TYPE FILTERING LOGIC (VIDEO, IMAGE, DOCUMENT & ALBUM ALLOWED)
            // =========================================================================
            const sourceList = getSourceJids().map(id => cleanJid(id));
            if (sourceList.length > 0 && sourceList[0] !== '' && !sourceList.some(src => cleanFrom.includes(src))) return;

            const targetList = getTargetJids().map(id => id.trim()).filter(Boolean);
            if (targetList.length === 0) return;

            const allowedTypes = (process.env.FORWARD_TYPES || 'video,image,document')
                .toLowerCase()
                .split(',')
                .map(t => t.trim());

            const isVideo = !!(msgContent.videoMessage || msgContent.ephemeralMessage?.message?.videoMessage || msgContent.viewOnceMessage?.message?.videoMessage || msgContent.viewOnceMessageV2?.message?.videoMessage);
            const isImage = !!(msgContent.imageMessage || msgContent.ephemeralMessage?.message?.imageMessage || msgContent.viewOnceMessage?.message?.imageMessage || msgContent.viewOnceMessageV2?.message?.imageMessage);
            const isDocument = !!(msgContent.documentMessage || msgContent.ephemeralMessage?.message?.documentMessage);
            const isText = !!(msgContent.conversation || msgContent.extendedTextMessage);
            const isSticker = !!(msgContent.stickerMessage);
            
            // البم اور ملٹی میڈیا پروٹیکشن
            const isAlbum = !!(msgContent.groupInviteMessage || msgContent.pollCreationMessage || msgContent.buttonsMessage || msgContent.templateMessage || msgContent.listMessage || msgContent.reactionMessage || msgContent.albumMessage || msgContent.imageMessage?.isViewOnce || msgContent.videoMessage?.contextInfo || msgContent.ephemeralMessage);

            let shouldForward = false;
            if (isVideo && allowedTypes.includes('video')) shouldForward = true;
            if (isImage && allowedTypes.includes('image')) shouldForward = true;
            if (isDocument && allowedTypes.includes('document')) shouldForward = true;
            if (isText && allowedTypes.includes('text')) shouldForward = true;
            if (isSticker && allowedTypes.includes('sticker')) shouldForward = true;
            if (isAlbum) shouldForward = true;

            if (shouldForward) {
                for (const targetJid of targetList) {
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            let cleanMessage = JSON.parse(JSON.stringify(wasi_msg.message));

                            const cleanContext = (obj) => {
                                if (!obj || typeof obj !== 'object') return;
                                if (obj.contextInfo) {
                                    delete obj.contextInfo.forwardingScore;
                                    delete obj.contextInfo.isForwarded;
                                    obj.contextInfo.participant = "Raju Boss +923071782626";
                                }
                                for (let key of Object.keys(obj)) {
                                    if (typeof obj[key] === 'object') {
                                        cleanContext(obj[key]);
                                    }
                                }
                            };
                            cleanContext(cleanMessage);

                            // البم اور بڑی فائلوں کے لیے براہ راست relayMessage استعمال کریں تاکہ سیکنڈوں میں جائے
                            await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });

                            console.log(`[+] Album/Media forwarded successfully to ${targetJid}`);
                            break;
                        } catch (err) {
                            console.error(`[!] Attempt ${attempt} failed for ${targetJid}:`, err.message);
                            if (attempt < 3) await new Promise(res => setTimeout(res, 2000));
                        }
                    }
                    
                    await new Promise(res => setTimeout(res, 1000));
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
        console.log(`🤖 Bot Commands active: !ping, !jid, !gjid, !join, !forward`);
    });
}

// -----------------------------------------------------------------------------
// MAIN STARTUP
// -----------------------------------------------------------------------------
async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
