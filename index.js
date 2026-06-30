const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const Database = require('better-sqlite3');
require('dotenv').config();

// قراءة الإعدادات من متغيرات السيرفر
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// حماية: إذا لم توجد المتغيرات، لا يبدأ البوت
if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error("❌ ERROR: Missing TG_TOKEN or TG_CHAT_ID in Environment Variables!");
    process.exit(1);
}

// ---------- إعداد قاعدة البيانات والتخزين على القرص ----------
const DATA_DIR = process.env.DATA_DIR || './.wwebjs_auth'; // نفس مسار الـ Volume عشان يفضل ثابت
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_PATH = path.join(DATA_DIR, 'messages.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        body TEXT,
        sender TEXT,
        time TEXT,
        media_path TEXT,
        media_mimetype TEXT,
        created_at INTEGER
    )
`);

const TEXT_LIMIT = 200;   // أقصى عدد رسايل نصية نحتفظ بيها
const MEDIA_LIMIT = 30;   // أقصى عدد ملفات ميديا نحتفظ بيها (تقليل استهلاك المساحة)

function saveMessage({ msg_id, body, sender, time, mediaPath, mediaMimetype }) {
    db.prepare(`
        INSERT OR REPLACE INTO messages (msg_id, body, sender, time, media_path, media_mimetype, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(msg_id, body, sender, time, mediaPath || null, mediaMimetype || null, Date.now());

    // تنظيف الرسايل النصية الزيادة (اللي مالهاش ميديا)
    const textRows = db.prepare(`SELECT msg_id FROM messages WHERE media_path IS NULL ORDER BY created_at DESC`).all();
    if (textRows.length > TEXT_LIMIT) {
        const toDelete = textRows.slice(TEXT_LIMIT).map(r => r.msg_id);
        const del = db.prepare(`DELETE FROM messages WHERE msg_id = ?`);
        toDelete.forEach(id => del.run(id));
    }

    // تنظيف ملفات الميديا الزيادة (مع حذف الملف الفعلي من القرص)
    const mediaRows = db.prepare(`SELECT msg_id, media_path FROM messages WHERE media_path IS NOT NULL ORDER BY created_at DESC`).all();
    if (mediaRows.length > MEDIA_LIMIT) {
        const toDelete = mediaRows.slice(MEDIA_LIMIT);
        const del = db.prepare(`DELETE FROM messages WHERE msg_id = ?`);
        toDelete.forEach(row => {
            try { if (row.media_path && fs.existsSync(row.media_path)) fs.unlinkSync(row.media_path); } catch (_) {}
            del.run(row.msg_id);
        });
    }
}

function getMessage(msg_id) {
    return db.prepare(`SELECT * FROM messages WHERE msg_id = ?`).get(msg_id);
}

function deleteMessage(msg_id) {
    db.prepare(`DELETE FROM messages WHERE msg_id = ?`).run(msg_id);
}

// إعادة محاولة الإرسال لتيليجرام لو فشل بسبب مشكلة شبكة مؤقتة
async function sendWithRetry(fn, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isLastAttempt = attempt === retries;
            console.error(`Telegram send attempt ${attempt}/${retries} failed: ${err.message}`);
            if (isLastAttempt) throw err;
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
}
// ---------------------------------------------------------------

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }), // حفظ الجلسة في ملف
    puppeteer: {
        headless: true,
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    try {
        const imagePath = './whatsapp-qr.png';
        await QRCode.toFile(imagePath, qr, { width: 300 });
        const form = new FormData();
        form.append('chat_id', TG_CHAT_ID);
        form.append('photo', fs.createReadStream(imagePath));
        form.append('caption', '📸 *WhatsApp Radar system requested login!*');

        await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, form, { headers: form.getHeaders() });
        console.log('🚀 QR sent to Telegram.');
    } catch (err) {
        console.error('QR Error:', err.message);
    }
});

client.on('ready', () => {
    console.log('🛡️ WhatsApp Radar is active!');
    sendWithRetry(() => axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: '✅ *WhatsApp Radar متصل ويراقب الآن.*',
        parse_mode: 'Markdown'
    })).catch(err => console.error('Failed to send ready notification:', err.message));
});

client.on('disconnected', (reason) => {
    console.error('⚠️ WhatsApp client disconnected:', reason);
    sendWithRetry(() => axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        chat_id: TG_CHAT_ID,
        text: `⚠️ *WhatsApp Radar انقطع الاتصال!*\nالسبب: ${reason}\nبيحاول يعيد الاتصال تلقائياً...`,
        parse_mode: 'Markdown'
    })).catch(err => console.error('Failed to send disconnect notification:', err.message));

    // محاولة إعادة التشغيل بعد فترة قصيرة
    setTimeout(() => {
        console.log('🔄 Attempting to reinitialize client...');
        client.initialize().catch(err => console.error('Reinitialize failed:', err.message));
    }, 5000);
});

client.on('message', async (msg) => {
    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.name || "Unknown";
    const timeStr = new Date().toLocaleTimeString();

    // نسجل الرسالة فوراً (النص بيتسجل بسرعة من غير ما ينتظر تحميل الميديا)
    saveMessage({
        msg_id: msg.id.id,
        body: msg.body || '',
        sender: senderName,
        time: timeStr,
        mediaPath: null,
        mediaMimetype: null
    });

    if (msg.hasMedia) {
        // تحميل الميديا في الخلفية بـ timeout قصير، عشان متعطلش تسجيل النص
        downloadMediaWithTimeout(msg, 15000)
            .then(media => {
                if (!media || !media.data) return;
                const ext = media.mimetype ? media.mimetype.split('/')[1].split(';')[0] : 'bin';
                const fileName = `${msg.id.id}.${ext}`;
                const filePath = path.join(MEDIA_DIR, fileName);
                fs.writeFileSync(filePath, Buffer.from(media.data, 'base64'));
                // تحديث السجل بمسار الميديا بعد ما يخلص تحميل
                saveMessage({
                    msg_id: msg.id.id,
                    body: msg.body || '',
                    sender: senderName,
                    time: timeStr,
                    mediaPath: filePath,
                    mediaMimetype: media.mimetype
                });
            })
            .catch(err => console.error('Media download error:', err.message));
    }
});

function downloadMediaWithTimeout(msg, ms) {
    return Promise.race([
        msg.downloadMedia(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Media download timed out')), ms))
    ]);
}

client.on('message_revoke_everyone', async (after, before) => {
    if (!before) return;
    const originalMsg = getMessage(before.id.id);
    if (!originalMsg) return;

    const captionText = `🚨 *Deleted Message Detected!*\n👤 *Sender:* ${originalMsg.sender}\n📩 *Message:* ${originalMsg.body || '(no text)'}\n🕒 *Time:* ${originalMsg.time}`;

    try {
        if (originalMsg.media_path && fs.existsSync(originalMsg.media_path)) {
            const isImage = originalMsg.media_mimetype && originalMsg.media_mimetype.startsWith('image/');
            const isVideo = originalMsg.media_mimetype && originalMsg.media_mimetype.startsWith('video/');
            const endpoint = isImage ? 'sendPhoto' : isVideo ? 'sendVideo' : 'sendDocument';
            const fieldName = isImage ? 'photo' : isVideo ? 'video' : 'document';

            await sendWithRetry(async () => {
                const form = new FormData();
                form.append('chat_id', TG_CHAT_ID);
                form.append(fieldName, fs.createReadStream(originalMsg.media_path));
                form.append('caption', captionText);
                form.append('parse_mode', 'Markdown');
                return axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${endpoint}`, form, { headers: form.getHeaders() });
            });
        } else {
            await sendWithRetry(() => axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                chat_id: TG_CHAT_ID,
                text: captionText,
                parse_mode: 'Markdown'
            }));
        }
    } catch (e) {
        console.error("Telegram API Error (all retries failed):", e.message);
    }
});

process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('⚠️ Uncaught Exception:', err.message));

// ---------- Health check بسيط عشان تتابع إن البوت لسه شغال ----------
const http = require('http');
let isClientReady = false;
let lastSeenAt = Date.now();

client.on('ready', () => { isClientReady = true; });
client.on('disconnected', () => { isClientReady = false; });

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    lastSeenAt = Date.now();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: isClientReady ? 'connected' : 'connecting',
        uptime_seconds: Math.floor(process.uptime()),
        checked_at: new Date().toISOString()
    }));
}).listen(PORT, () => console.log(`🩺 Health check listening on port ${PORT}`));
// ---------------------------------------------------------------

client.initialize();
