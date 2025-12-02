const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

// --- НАСТРОЙКИ ИЗ ПЕРЕМЕННЫХ ОКРУЖЕНИЯ ---
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 3000;

console.log('🔧 Проверка настроек...');
console.log('TOKEN установлен:', TOKEN ? 'Да' : 'Нет');
console.log('ADMIN_ID:', ADMIN_ID || 'Не установлен');

if (!TOKEN || !ADMIN_ID) {
    console.error('❌ ОШИБКА: Не заданы TOKEN или ADMIN_ID в переменных окружения!');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

// 1. Проверка здоровья
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Telegram Stars Bot',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// 2. Поиск юзера
app.get('/get-user', async (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ error: 'No username provided' });
    }

    const cleanUsername = username.replace('@', '').trim();
    console.log(`🔎 Поиск пользователя: ${cleanUsername}`);

    try {
        // Пробуем через бота
        const chat = await bot.getChat(`@${cleanUsername}`);
        let photoUrl = null;
        if (chat.photo) {
            const fileLink = await bot.getFileLink(chat.photo.big_file_id);
            photoUrl = fileLink;
        }
        return res.json({
            name: chat.first_name || chat.title || 'Unknown',
            username: chat.username || cleanUsername,
            photo: photoUrl
        });
    } catch (e) {
        console.log(`Бот не нашел ${cleanUsername}, пробуем через веб...`);
        // Пробуем через Web
        try {
            const web = await axios.get(`https://t.me/${cleanUsername}`, {
                timeout: 5000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            const $ = cheerio.load(web.data);
            const name = $('div.tgme_page_title span').text() || $('div.tgme_page_title').text();
            const photo = $('meta[property="og:image"]').attr('content');

            if (!name || name.trim().length === 0) {
                throw new Error('Имя не найдено');
            }

            return res.json({
                name: name.trim(),
                username: cleanUsername,
                photo: photo
            });
        } catch (err) {
            console.error(`Пользователь не найден: ${cleanUsername}`);
            return res.status(404).json({ error: 'User not found' });
        }
    }
});

// 3. Уведомление об оплате
app.post('/notify-payment', async (req, res) => {
    const { username, amountStars, amountTon, wallet } = req.body;

    if (!username || !amountStars || !amountTon || !wallet) {
        return res.status(400).json({
            error: 'Missing required fields',
            received: { username, amountStars, amountTon, wallet }
        });
    }

    console.log(`💰 НОВАЯ ОПЛАТА! @${username}, ${amountStars} звезд`);

    const message = `
✅ <b>НОВЫЙ ЗАКАЗ!</b>

👤 <b>Покупатель:</b> @${username}
⭐ <b>Товар:</b> ${amountStars} Stars
💎 <b>Оплачено:</b> ${amountTon} TON
👛 <b>Кошелек:</b> <code>${wallet}</code>
🕐 <b>Время:</b> ${new Date().toLocaleString('ru-RU')}

<i>Срочно отправь звезды вручную!</i>
    `;

    try {
        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'HTML' });
        console.log('✅ Уведомление отправлено админу');
        res.json({ success: true });
    } catch (e) {
        console.error("Ошибка отправки сообщения админу:", e.message);
        res.status(500).json({ error: 'Error sending notification' });
    }
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`👮‍♂️ Админ ID: ${ADMIN_ID}`);
    console.log(`🔗 Доступные эндпоинты:`);
    console.log(`   GET  /health - Проверка работы`);
    console.log(`   GET  /get-user?username=... - Поиск пользователя`);
    console.log(`   POST /notify-payment - Уведомление об оплате`);
});
