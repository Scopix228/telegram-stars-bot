const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;
const PORT = process.env.PORT || 3000;

console.log('🚀 Проверка переменных окружения...');
console.log('TOKEN:', TOKEN ? 'Есть' : 'Нет');
console.log('ADMIN_ID:', ADMIN_ID || 'Не установлен');
console.log('PORT:', PORT);

if (!TOKEN || !ADMIN_ID) {
    console.error('❌ Ошибка: Не заданы TOKEN или ADMIN_ID в переменных окружения!');
    process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: false });

// Health check
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        service: 'Telegram Stars Bot',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Telegram Stars Bot',
        time: new Date().toISOString()
    });
});

// Поиск пользователя
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) {
            return res.status(400).json({ error: 'Нет username' });
        }

        const cleanUsername = username.replace('@', '').trim();
        console.log('🔍 Ищем:', cleanUsername);

        // Пробуем через бота
        try {
            const chat = await bot.getChat(`@${cleanUsername}`);
            let photoUrl = null;
            if (chat.photo) {
                photoUrl = await bot.getFileLink(chat.photo.big_file_id);
            }
            return res.json({
                name: chat.first_name || chat.title || 'Без имени',
                username: chat.username || cleanUsername,
                photo: photoUrl
            });
        } catch (botError) {
            console.log('Бот не нашел, пробуем через сайт...');
            // Через сайт
            try {
                const response = await axios.get(`https://t.me/${cleanUsername}`);
                const $ = cheerio.load(response.data);
                const name = $('div.tgme_page_title').text().trim();
                const photo = $('meta[property="og:image"]').attr('content');

                if (!name) throw new Error('Нет имени');

                return res.json({
                    name: name,
                    username: cleanUsername,
                    photo: photo
                });
            } catch (webError) {
                console.log('Сайт не нашел');
                return res.status(404).json({ error: 'Пользователь не найден' });
            }
        }
    } catch (error) {
        console.error('Ошибка поиска:', error);
        return res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Уведомление об оплате
app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;

        if (!username || !amountStars || !amountTon || !wallet) {
            return res.status(400).json({ error: 'Не все данные' });
        }

        console.log('💰 Оплата:', { username, amountStars, amountTon, wallet });

        const message = `
✅ <b>НОВЫЙ ЗАКАЗ!</b>

👤 <b>Покупатель:</b> @${username}
⭐ <b>Товар:</b> ${amountStars} Stars
💎 <b>Оплачено:</b> ${amountTon} TON
👛 <b>Кошелек:</b> <code>${wallet}</code>
🕐 <b>Время:</b> ${new Date().toLocaleString('ru-RU')}

<i>Отправь звезды вручную!</i>
        `;

        await bot.sendMessage(ADMIN_ID, message, { parse_mode: 'HTML' });
        console.log('✅ Сообщение отправлено админу');

        res.json({ success: true });
    } catch (error) {
        console.error('Ошибка уведомления:', error);
        res.status(500).json({ error: 'Ошибка отправки' });
    }
});

// Запуск сервера
const server = app.listen(PORT, () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    console.log(`📞 Эндпоинты:`);
    console.log(`   GET  / - Проверка`);
    console.log(`   GET  /health - Health check (для Railway)`);
    console.log(`   GET  /get-user?username=... - Поиск`);
    console.log(`   POST /notify-payment - Уведомление`);
});

// Обработка ошибок при запуске сервера
server.on('error', (error) => {
    console.error('❌ Ошибка при запуске сервера:', error);
    process.exit(1);
});