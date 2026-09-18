const {
    fetchLatestWaWebVersion,
    makeCacheableSignalKeyStore,
    makeWASocket,
    Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const config = require('../wasi');
const { useMongoDBAuthState } = require('./mongoAuth');

async function wasi_connectSession(usePairingCode = false, customSessionId = null) {
    // -------------------------------------------------------------------------
    // Use MongoDB Auth State directly
    // This removes the dependency on the local file system which is ephemeral on Heroku.
    // -------------------------------------------------------------------------

    // Support multi-tenancy by using a custom session ID if provided
    const sessionId = customSessionId || config.sessionId || 'wasi_session';
    console.log(`🔌 Connecting to session: ${sessionId}`);

    const { state, saveCreds } = await useMongoDBAuthState(sessionId);

    let version;
    try {
        const v = await fetchLatestWaWebVersion();
        version = v.version;
    } catch (e) {
        version = [2, 3000, 1017531287];
    }

    const socketOptions = {
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            // Wrap keys with makeCacheableSignalKeyStore for better performance
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: Browsers.ubuntu('Chrome'),
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        retryRequestDelayMs: 5000,
        keepAliveIntervalMs: 10000,
        connectTimeoutMs: 60000,
    };

    const wasi_sock = makeWASocket(socketOptions);
    // Pairing Code Request Logic
    const phoneNumber = process.env.PHONE_NUMBER;
    if (phoneNumber && !wasi_sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
                let code = await wasi_sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;

                console.log(`\n=============================================`);
                console.log(`📌 YOUR PAIRING CODE FOR ${sessionId}: ${code}`);
                console.log(`=============================================\n`);
            } catch (err) {
                console.error('❌ Pairing Code Error:', err.message || err);
            }
        }, 6000);
    }
    
    return { wasi_sock, saveCreds };
}

async function wasi_clearSession(customSessionId = null) {
    const sessionId = customSessionId || config.sessionId || 'wasi_session';
    const { useMongoDBAuthState } = require('./mongoAuth');

    // Instantiate with the specific session ID to get the correct model
    const { clearState } = await useMongoDBAuthState(sessionId);
    if (clearState) {
        await clearState();
        console.log(`🗑️ Session cleared from MongoDB: ${sessionId}`);
    }
}

module.exports = { wasi_connectSession, wasi_clearSession };
