const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
require('dotenv').config();

// قراءة الإعدادات من متغيرات السيرفر
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// حماية: إذا لم توجد المتغيرات، لا يبدأ البوت
if (!TG_TOKEN || !TG_CHAT_ID) {
    console.error("❌ ERROR: Missing TG_TOKEN or TG_CHAT_ID in Environment Variables!");
    process.exit(1);
}

const messageLog = new Map();

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
});

client.on('message', async (msg) => {
    const contact = await msg.getContact();
    let mediaData = null;

    if (msg.hasMedia) {
        try {
            const media = await msg.downloadMedia();
            mediaData = media; // { mimetype, data (base64), filename }
        } catch (err) {
            console.error('Media download error:', err.message);
        }
    }

    messageLog.set(msg.id.id, {
        body: msg.body,
        sender: contact.pushname || contact.name || "Unknown",
        time: new Date().toLocaleTimeString(),
        media: mediaData
    });

    // تقليل حجم الذاكرة (إبقاء آخر 200 رسالة فقط)
    if (messageLog.size > 200) {
        const firstKey = messageLog.keys().next().value;
        messageLog.delete(firstKey);
    }
});

client.on('message_revoke_everyone', async (after, before) => {
    if (before && messageLog.has(before.id.id)) {
        const originalMsg = messageLog.get(before.id.id);
        const captionText = `🚨 *Deleted Message Detected!*\n👤 *Sender:* ${originalMsg.sender}\n📩 *Message:* ${originalMsg.body || '(no text)'}\n🕒 *Time:* ${originalMsg.time}`;

        try {
            if (originalMsg.media && originalMsg.media.data) {
                // بعت الميديا مع الكابشن
                const form = new FormData();
                form.append('chat_id', TG_CHAT_ID);
                const buffer = Buffer.from(originalMsg.media.data, 'base64');
                const isImage = originalMsg.media.mimetype && originalMsg.media.mimetype.startsWith('image/');
                const isVideo = originalMsg.media.mimetype && originalMsg.media.mimetype.startsWith('video/');
                const endpoint = isImage ? 'sendPhoto' : isVideo ? 'sendVideo' : 'sendDocument';
                const fieldName = isImage ? 'photo' : isVideo ? 'video' : 'document';
                const ext = originalMsg.media.mimetype ? originalMsg.media.mimetype.split('/')[1] : 'bin';

                form.append(fieldName, buffer, { filename: `deleted.${ext}` });
                form.append('caption', captionText);
                form.append('parse_mode', 'Markdown');

                await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/${endpoint}`, form, { headers: form.getHeaders() });
            } else {
                await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                    chat_id: TG_CHAT_ID,
                    text: captionText,
                    parse_mode: 'Markdown'
                });
            }
        } catch (e) {
            console.error("Telegram API Error:", e.message);
        }
    }
});

process.on('unhandledRejection', (reason) => console.error('⚠️ Unhandled Rejection:', reason));

client.initialize();