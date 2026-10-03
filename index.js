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
// SESSION STATE & PERMANENT STORAGE FILE SETUP
// -----------------------------------------------------------------------------
const sessions = new Map();
const CONFIG_FILE = path.join(__dirname, 'posters_config.json');

// Load saved settings from disk so they survive bot restarts
let botConfig = {
    targetCustomPoster: null,
    sourceTargetPosterHash: null
};

function loadBotConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const data = fs.readFileSync(CONFIG_FILE, 'utf8');
            botConfig = JSON.parse(data);
            console.log('✅ Saved posters config loaded successfully!');
        }
    } catch (e) {
        console.error('❌ Error loading config file:', e.message);
    }
}

function saveBotConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Error saving config file:', e.message);
    }
}

// Load config on startup
loadBotConfig();

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
// CONFIGURATION HELPERS
// -----------------------------------------------------------------------------
function getSourceJids() {
    return process.env.SOURCE_JIDS ? process.env.SOURCE_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
}

function getTargetJids() {
    return process.env.TARGET_JIDS ? process.env.TARGET_JIDS.split(',').map(id => id.trim()).filter(Boolean) : [];
}

const OLD_TEXT_REGEX = process.env.OLD_TEXT_REGEX
    ? process.env.OLD_TEXT_REGEX.split(',').map(pattern => {
        try {
            return pattern.trim() ? new RegExp(pattern.trim(), 'gu') : null;
        } catch (e) {
            return null;
        }
      }).filter(regex => regex !== null)
    : [];

const NEW_TEXT = process.env.NEW_TEXT ? process.env.NEW_TEXT : '';

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
        if (existing.isConnected && existing.sock) return;

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

            // 3. !settarget COMMAND (Jo poster aapne target group mein bhejwana hai)
            if (msgText.toLowerCase() === '!settarget') {
                try {
                    const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    const targetImage = quotedMsg?.imageMessage || msgContent.imageMessage;

                    if (!targetImage) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam us naye poster ko reply karein jo aap apne target group mein bhejna chahte hain!' }, { quoted: wasi_msg });
                        return;
                    }

                    botConfig.targetCustomPoster = quotedMsg ? quotedMsg.imageMessage : msgContent.imageMessage;
                    saveBotConfig(); // Save permanently to file

                    await wasi_sock.sendMessage(rawFrom, { text: '✅ Aapka apna target poster kamyabi se save aur set ho gaya hai! (Restart par bhi khatam nahi hoga)' }, { quoted: wasi_msg });
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Error: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }

            // 4. !setsource COMMAND (Jis purane poster ko source group mein pehchan kar badalna hai)
            if (msgText.toLowerCase() === '!setsource') {
                try {
                    const quotedMsg = msgContent.extendedTextMessage?.contextInfo?.quotedMessage;
                    const sourceImage = quotedMsg?.imageMessage || msgContent.imageMessage;

                    if (!sourceImage || !sourceImage.fileSha256) {
                        await wasi_sock.sendMessage(rawFrom, { text: '❌ Bara-e-karam us purane/source poster (jise replace karna hai) ko reply karein!' }, { quoted: wasi_msg });
                        return;
                    }

                    // Poster ka unique digital fingerprint (Hash) save kar lenge
                    botConfig.sourceTargetPosterHash = Buffer.from(sourceImage.fileSha256).toString('hex');
                    saveBotConfig(); // Save permanently to file

                    await wasi_sock.sendMessage(rawFrom, { text: '✅ Source poster ki pehchan (Hash) permanently save ho gayi hai! Ab restart hone par bhi yeh yaad rahegi.' }, { quoted: wasi_msg });
                } catch (err) {
                    await wasi_sock.sendMessage(rawFrom, { text: `❌ Error: ${err.message}` }, { quoted: wasi_msg });
                }
                return;
            }
             
            // =========================================================================
            // ⚡ AUTO FORWARD & SMART POSTER REPLACEMENT LOGIC
            // =========================================================================
            const sourceList = getSourceJids().map(id => cleanJid(id));
            if (sourceList.length > 0 && sourceList[0] !== '' && !sourceList.some(src => cleanFrom.includes(src))) return;

            const targetList = getTargetJids().map(id => id.trim()).filter(Boolean);
            if (targetList.length === 0) return;

            let shouldForward = true;

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

                            // Text Replacements
                            if (cleanMessage.imageMessage?.caption) {
                                cleanMessage.imageMessage.caption = replaceCaption(cleanMessage.imageMessage.caption);
                            }
                            if (cleanMessage.conversation) {
                                cleanMessage.conversation = replaceCaption(cleanMessage.conversation);
                            }
                            if (cleanMessage.extendedTextMessage?.text) {
                                cleanMessage.extendedTextMessage.text = replaceCaption(cleanMessage.extendedTextMessage.text);
                            }

                            // 🔄 SMART POSTER REPLACEMENT CHECK
                            const incomingImage = cleanMessage.imageMessage || cleanMessage.ephemeralMessage?.message?.imageMessage;
                            if (incomingImage && incomingImage.fileSha256 && botConfig.targetCustomPoster && botConfig.sourceTargetPosterHash) {
                                const incomingHash = Buffer.from(incomingImage.fileSha256).toString('hex');
                                
                                // Agar source group wala poster wohi hai jo aapne !setsource se set kiya tha
                                if (incomingHash === botConfig.sourceTargetPosterHash) {
                                    // Toh usay aapke apne target poster se badal do!
                                    Object.keys(botConfig.targetCustomPoster).forEach(k => {
                                        incomingImage[k] = botConfig.targetCustomPoster[k];
                                    });
                                    console.log('[+] Target poster successfully replaced!');
                                }
                            }

                            await wasi_sock.relayMessage(targetJid, cleanMessage, { messageId: wasi_msg.key.id });

                            console.log(`[+] Successfully forwarded to ${targetJid}`);
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

// -----------------------------------------------------------------------------
// SERVER START
// -----------------------------------------------------------------------------
function wasi_startServer() {
    wasi_app.listen(wasi_port, () => {
        console.log(`🌐 Server running on port ${wasi_port}`);
        console.log(`🤖 Bot Commands active: !ping, !jid, !settarget, !setsource`);
    });
}

async function main() {
    if (config.mongoDbUrl) {
        await wasi_connectDatabase(config.mongoDbUrl);
    }

    const sessionId = config.sessionId || 'wasi_session';
    await startSession(sessionId);

    wasi_startServer();
}

main().catch(err => console.error('Main startup error:', err));
