const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID;

console.log('🚀 Запуск сервера...');
console.log('📡 Порт:', PORT);
console.log('🔑 Токен:', TOKEN ? 'установлен' : 'не установлен');
console.log('👮 Админ ID:', ADMIN_ID || 'не установлен');

// Инициализируем бот только если есть токен
let bot = null;
if (TOKEN) {
    try {
        const TelegramBot = require('node-telegram-bot-api');
        bot = new TelegramBot(TOKEN, {
            polling: false,
            request: {
                timeout: 10000
            }
        });
        console.log('✅ Бот инициализирован');
    } catch (error) {
        console.error('❌ Ошибка инициализации бота:', error.message);
    }
} else {
    console.log('⚠️  Токен не установлен, бот не будет работать');
}

// 1. Health check (ОБЯЗАТЕЛЬНО для Railway)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        service: 'Telegram Stars Bot',
        timestamp: new Date().toISOString(),
        bot: bot ? 'active' : 'inactive'
    });
});

// 2. Главная страница
app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Telegram Stars Bot работает!',
        endpoints: {
            health: '/health',
            getUser: '/get-user?username=USERNAME',
            notifyPayment: 'POST /notify-payment'
        }
    });
});

// 3. Поиск пользователя
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) {
            return res.status(400).json({ error: 'Укажите username' });
        }

        const cleanUsername = username.replace('@', '').trim();
        console.log('🔍 Поиск:', cleanUsername);

        // Пробуем через веб-сайт Telegram (более надежно)
        try {
            const response = await axios.get(`https://t.me/${cleanUsername}`, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const $ = cheerio.load(response.data);
            const name = $('div.tgme_page_title').text().trim();
            const photo = $('meta[property="og:image"]').attr('content');

            if (!name || name.length === 0) {
                throw new Error('Имя не найдено');
            }

            return res.json({
                name: name,
                username: cleanUsername,
                photo: photo || null
            });
        } catch (webError) {
            console.log('🌐 Веб-поиск не удался:', webError.message);

            // Если есть бот, пробуем через него
            if (bot) {
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
                    console.log('🤖 Поиск через бот не удался:', botError.message);
                }
            }

            return res.status(404).json({
                error: 'Пользователь не найден',
                username: cleanUsername
            });
        }
    } catch (error) {
        console.error('🔥 Ошибка поиска:', error);
        return res.status(500).json({
            error: 'Внутренняя ошибка сервера',
            details: error.message
        });
    }
});

// 4. Уведомление об оплате
app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;

        // Проверка данных
        if (!username || !amountStars || !amountTon || !wallet) {
            return res.status(400).json({
                error: 'Недостаточно данных',
                received: { username, amountStars, amountTon, wallet }
            });
        }

        console.log('💰 Новая оплата:', { username, amountStars, amountTon, wallet });

        // Если есть бот и ADMIN_ID, отправляем уведомление
        if (bot && ADMIN_ID) {
            try {
                const message = `
✅ <b>НОВЫЙ ЗАКАЗ!</b>

👤 <b>Покупатель:</b> @${username}
⭐ <b>Товар:</b> ${amountStars} Stars
💎 <b>Оплачено:</b> ${amountTon} TON
👛 <b>Кошелек:</b> <code>${wallet}</code>
🕐 <b>Время:</b> ${new Date().toLocaleString('ru-RU')}

<i>Срочно отправь звезды вручную!</i>
                `;

                await bot.sendMessage(ADMIN_ID, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });

                console.log('📨 Уведомление отправлено админу');
            } catch (botError) {
                console.error('❌ Ошибка отправки уведомления:', botError.message);
                // Продолжаем выполнение, даже если уведомление не отправилось
            }
        } else {
            console.log('⚠️  Бот или ADMIN_ID не настроены, уведомление не отправлено');
        }

        // Всегда возвращаем успех клиенту
        res.json({
            success: true,
            message: 'Платеж принят в обработку'
        });

    } catch (error) {
        console.error('🔥 Ошибка обработки платежа:', error);
        res.status(500).json({
            error: 'Ошибка обработки платежа',
            details: error.message
        });
    }
});

// 5. Обработка ошибок
app.use((err, req, res, next) => {
    console.error('🔥 Необработанная ошибка:', err);
    res.status(500).json({
        error: 'Внутренняя ошибка сервера',
        message: err.message
    });
});

// 6. 404 обработчик
app.use((req, res) => {
    res.status(404).json({
        error: 'Эндпоинт не найден',
        path: req.path
    });
});

// 7. Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на http://0.0.0.0:${PORT}`);
    console.log(`🔄 Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`🔗 Переменные окружения:`);
    console.log(`   - PORT: ${PORT}`);
    console.log(`   - TOKEN: ${TOKEN ? 'установлен' : 'НЕ УСТАНОВЛЕН'}`);
    console.log(`   - ADMIN_ID: ${ADMIN_ID || 'НЕ УСТАНОВЛЕН'}`);
    console.log(`📡 Готов к работе!`);
});

// 8. Обработка завершения
process.on('SIGTERM', () => {
    console.log('👋 Получен SIGTERM, завершаем работу...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('💥 Необработанное исключение:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Необработанный промис:', reason);
});