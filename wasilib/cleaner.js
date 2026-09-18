/**
 * ⚡ KAIF-MD-V3 ⚡
 * Advanced Cleaner Utility & Text Replacement Engine
 * Developed by Kaif (ixxkaif)
 */
const fs = require('fs');
const path = require('path');

/**
 * Escapes literal text for safe regex creation
 */
function escapeRegex(string) {
    if (typeof string !== 'string') return '';
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
}

/**
 * Normalize stylish / fancy unicode fonts (e.g. 𝙺𝙰𝙸𝑭, 𝒦𝒜𝐼𝐹, 𝔎𝔞𝔦𝔣, 🅺🅰🅸🅵) to standard Latin text
 */
function normalizeFancyFont(str) {
    if (!str || typeof str !== 'string') return str;
    try {
        let normalized = str.normalize('NFKD');
        // Convert mathematical alphanumeric symbols (U+1D400 to U+1D7FF)
        normalized = normalized.replace(/[\uD835][\uDC00-\uDFFF]/g, (char) => {
            const cp = char.codePointAt(0);
            if (cp >= 0x1D400 && cp <= 0x1D419) return String.fromCharCode(0x41 + (cp - 0x1D400));
            if (cp >= 0x1D41A && cp <= 0x1D433) return String.fromCharCode(0x61 + (cp - 0x1D41A));
            if (cp >= 0x1D434 && cp <= 0x1D44D) return String.fromCharCode(0x41 + (cp - 0x1D434));
            if (cp >= 0x1D44E && cp <= 0x1D467) return String.fromCharCode(0x61 + (cp - 0x1D44E));
            if (cp >= 0x1D468 && cp <= 0x1D481) return String.fromCharCode(0x41 + (cp - 0x1D468));
            if (cp >= 0x1D482 && cp <= 0x1D49B) return String.fromCharCode(0x61 + (cp - 0x1D482));
            if (cp >= 0x1D4D0 && cp <= 0x1D4E9) return String.fromCharCode(0x41 + (cp - 0x1D4D0));
            if (cp >= 0x1D4EA && cp <= 0x1D503) return String.fromCharCode(0x61 + (cp - 0x1D4EA));
            if (cp >= 0x1D538 && cp <= 0x1D551) return String.fromCharCode(0x41 + (cp - 0x1D538));
            if (cp >= 0x1D56C && cp <= 0x1D585) return String.fromCharCode(0x41 + (cp - 0x1D56C));
            if (cp >= 0x1D586 && cp <= 0x1D59F) return String.fromCharCode(0x61 + (cp - 0x1D586));
            if (cp >= 0x1D5A0 && cp <= 0x1D5B9) return String.fromCharCode(0x41 + (cp - 0x1D5A0));
            if (cp >= 0x1D5BA && cp <= 0x1D5D3) return String.fromCharCode(0x61 + (cp - 0x1D5BA));
            if (cp >= 0x1D670 && cp <= 0x1D689) return String.fromCharCode(0x41 + (cp - 0x1D670));
            if (cp >= 0x1D68A && cp <= 0x1D6A3) return String.fromCharCode(0x61 + (cp - 0x1D68A));
            return char;
        });
        return normalized;
    } catch (e) {
        return str;
    }
}

/**
 * Smart Regex Pattern Compiler
 */
function parsePatterns(input) {
    if (!input) return [];

    let patternList = [];
    if (Array.isArray(input)) {
        patternList = input;
    } else if (typeof input === 'string') {
        patternList = input.split(',').map(p => p.trim()).filter(Boolean);
    } else if (input instanceof RegExp) {
        return [input];
    } else {
        return [];
    }

    const compiledList = [];

    patternList.forEach(item => {
        if (!item) return;

        if (item instanceof RegExp) {
            compiledList.push(item);
            return;
        }

        if (typeof item !== 'string') return;
        const trimmed = item.trim();
        if (!trimmed) return;

        // 1. Explicit RegExp format: /pattern/flags
        const slashMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
        if (slashMatch) {
            let flags = slashMatch[2] || '';
            if (!flags.includes('g')) flags += 'g';
            if (!flags.includes('u')) flags += 'u';
            if (!flags.includes('i')) flags += 'i';
            try {
                compiledList.push(new RegExp(slashMatch[1], flags));
                return;
            } catch (e) {
                console.error(`[Cleaner] Invalid slashed regex: ${trimmed}`, e.message);
            }
        }

        // 2. Check for explicit regex syntax tokens (\d, \w, \s, \S, \D, \W, .*, .+, ^, $, (?:, (?=)
        const hasExplicitRegexTokens = /\\[dwsDWS]|\.[\*\+]|^[\^\$]|^\(\?:|^\(\?=/i.test(trimmed);

        if (hasExplicitRegexTokens) {
            try {
                compiledList.push(new RegExp(trimmed, 'gui'));
                return;
            } catch (e) {}
        }

        // 3. Fallback to safe literal string escaping (handles "[", "]", "(", ")", "?", "*", "+", etc.)
        try {
            const escaped = escapeRegex(trimmed);
            compiledList.push(new RegExp(escaped, 'gui'));
        } catch (e) {
            console.error(`[Cleaner] Failed to compile regex for: ${trimmed}`, e.message);
        }
    });

    return compiledList;
}

/**
 * Dynamic environment regex list & replacement text
 */
function getEnvConfig() {
    const rawOld = process.env.OLD_TEXT_REGEX || '';
    const rawNew = process.env.NEW_TEXT !== undefined ? process.env.NEW_TEXT : '';
    return {
        regexList: parsePatterns(rawOld),
        replacementText: rawNew
    };
}

/**
 * Perform text replacement on a single string
 */
function replaceText(text, patterns = null, newText = null) {
    if (!text || typeof text !== 'string') return text;

    let envConfig = null;
    let activePatterns = [];

    if (patterns !== null && patterns !== undefined) {
        activePatterns = parsePatterns(patterns);
    } else {
        envConfig = getEnvConfig();
        activePatterns = envConfig.regexList;
    }

    if (!activePatterns || !activePatterns.length) return text;

    let targetReplacement = '';
    if (newText !== null && newText !== undefined) {
        targetReplacement = String(newText);
    } else {
        if (!envConfig) envConfig = getEnvConfig();
        targetReplacement = envConfig.replacementText;
    }

    const replacementList = targetReplacement.includes(',')
        ? targetReplacement.split(',').map(s => s.trim())
        : null;

    let result = text;

    // First pass: replace on raw text
    activePatterns.forEach((regex, idx) => {
        if (!regex) return;
        try {
            regex.lastIndex = 0;
            const currentReplacement = (replacementList && replacementList.length === activePatterns.length)
                ? replacementList[idx]
                : targetReplacement;
            result = result.replace(regex, currentReplacement);
        } catch (e) {
            console.error('[Cleaner] Replace error:', e.message);
        }
    });

    // Second pass: if fancy fonts exist, normalize and replace again
    const normalized = normalizeFancyFont(result);
    if (normalized !== result) {
        result = normalized;
        activePatterns.forEach((regex, idx) => {
            if (!regex) return;
            try {
                regex.lastIndex = 0;
                const currentReplacement = (replacementList && replacementList.length === activePatterns.length)
                    ? replacementList[idx]
                    : targetReplacement;
                result = result.replace(regex, currentReplacement);
            } catch (e) {}
        });
    }

    return result;
}

/**
 * Recursively restores Buffer instances converted to plain JSON objects by JSON.stringify
 */
function restoreBuffers(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
        return Buffer.from(obj.data);
    }
    for (const key of Object.keys(obj)) {
        if (obj[key] && typeof obj[key] === 'object') {
            obj[key] = restoreBuffers(obj[key]);
        }
    }
    return obj;
}

/**
 * Clean forwarded label, newsletter markers, and perform text replacement
 */
function processAndCleanMessage(message, customRegexList = null, customNewText = null) {
    try {
        if (!message) return message;

        let cleaned = JSON.parse(JSON.stringify(message));
        cleaned = restoreBuffers(cleaned);

        // Unwrap outer envelopes if present
        if (cleaned.ephemeralMessage) cleaned = cleaned.ephemeralMessage.message;
        if (cleaned.viewOnceMessageV2Extension) cleaned = cleaned.viewOnceMessageV2Extension.message;
        if (cleaned.viewOnceMessageV2) cleaned = cleaned.viewOnceMessageV2.message;
        if (cleaned.viewOnceMessage) cleaned = cleaned.viewOnceMessage.message;
        if (cleaned.documentWithCaptionMessage) cleaned = cleaned.documentWithCaptionMessage.message;
        if (cleaned.templateMessage?.hydratedTemplate) cleaned = cleaned.templateMessage.hydratedTemplate;

        const cleanContextInfo = (ctx) => {
            if (!ctx) return;
            delete ctx.isForwarded;
            delete ctx.forwardingScore;
            delete ctx.forwardedNewsletterMessageInfo;
            delete ctx.externalAdReply;
            delete ctx.newsletterJid;
            delete ctx.newsletterName;
            delete ctx.newsletterServerMessageId;
            ctx.isForwarded = false;
            ctx.forwardingScore = 0;

            if (ctx.quotedMessage) {
                ctx.quotedMessage = processAndCleanMessage(ctx.quotedMessage, customRegexList, customNewText);
            }
        };

        const targetBlocks = [
            'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 
            'documentMessage', 'stickerMessage', 'locationMessage', 'liveLocationMessage',
            'contactMessage', 'contactsArrayMessage', 'groupInviteMessage', 'pollCreationMessage',
            'ptvMessage', 'buttonsMessage', 'listMessage', 'templateMessage'
        ];

        targetBlocks.forEach(block => {
            if (cleaned[block]) {
                if (cleaned[block].contextInfo) {
                    cleanContextInfo(cleaned[block].contextInfo);
                }
                delete cleaned[block].isForwarded;
                delete cleaned[block].forwardingScore;
            }
        });

        if (cleaned.contextInfo) {
            cleanContextInfo(cleaned.contextInfo);
        }

        const applyClean = (txt) => replaceText(txt, customRegexList, customNewText);

        if (typeof cleaned.conversation === 'string') {
            cleaned.conversation = applyClean(cleaned.conversation);
        }
        if (cleaned.extendedTextMessage?.text) {
            cleaned.extendedTextMessage.text = applyClean(cleaned.extendedTextMessage.text);
        }
        if (cleaned.imageMessage?.caption) {
            cleaned.imageMessage.caption = applyClean(cleaned.imageMessage.caption);
        }
        if (cleaned.videoMessage?.caption) {
            cleaned.videoMessage.caption = applyClean(cleaned.videoMessage.caption);
        }
        if (cleaned.documentMessage?.caption) {
            cleaned.documentMessage.caption = applyClean(cleaned.documentMessage.caption);
        }
        if (cleaned.audioMessage?.caption) {
            cleaned.audioMessage.caption = applyClean(cleaned.audioMessage.caption);
        }
        if (cleaned.locationMessage?.comment) {
            cleaned.locationMessage.comment = applyClean(cleaned.locationMessage.comment);
        }
        if (cleaned.liveLocationMessage?.caption) {
            cleaned.liveLocationMessage.caption = applyClean(cleaned.liveLocationMessage.caption);
        }
        if (cleaned.groupInviteMessage?.caption) {
            cleaned.groupInviteMessage.caption = applyClean(cleaned.groupInviteMessage.caption);
        }
        if (cleaned.pollCreationMessage?.name) {
            cleaned.pollCreationMessage.name = applyClean(cleaned.pollCreationMessage.name);
        }

        return cleaned;
    } catch (e) {
        console.error('Cleaning Error:', e.message);
        return message;
    }
}

/**
 * Clean temporary media, cache, and junk files
 */
function cleanTempFiles(forceAll = false) {
    const tempDir = path.join(__dirname, '..', 'temp');
    let cleanedCount = 0;

    if (fs.existsSync(tempDir)) {
        try {
            const files = fs.readdirSync(tempDir);
            const now = Date.now();
            const maxAge = 24 * 60 * 60 * 1000;

            files.forEach(file => {
                const filePath = path.join(tempDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (forceAll || (now - stats.mtimeMs > maxAge)) {
                        fs.unlinkSync(filePath);
                        cleanedCount++;
                    }
                } catch (e) {}
            });
        } catch (e) {
            console.error('Temp directory clean error:', e.message);
        }
    }

    console.log(`⚡ Auto-Cleaner: Cleaned ${cleanedCount} temporary files.`);
    return { success: true, cleanedCount };
}

module.exports = {
    processAndCleanMessage,
    replaceText,
    parsePatterns,
    escapeRegex,
    normalizeFancyFont,
    cleanTempFiles
};
