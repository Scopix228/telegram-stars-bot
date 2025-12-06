const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// --- НАСТРОЙКИ ---
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString() : '';

// Список ID модераторов
const MOD_IDS = process.env.MOD_IDS ? process.env.MOD_IDS.split(',').map(id => id.trim()) : [];

console.log('🚀 Запуск сервера...');

// --- БАЗА ДАННЫХ ---
const db = new sqlite3.Database('./orders.db', (err) => {
    if (err) console.error('❌ Ошибка БД:', err.message);
    else console.log('✅ База данных подключена');
});

db.serialize(() => {
    // Таблица заказов
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
                                              id INTEGER PRIMARY KEY AUTOINCREMENT,
                                              username TEXT,
                                              stars_amount INTEGER,
                                              ton_amount REAL,
                                              wallet TEXT,
                                              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Таблица пользователей (с языком)
    // ВАЖНО: Если у тебя старая база без колонки language, удали файл orders.db перед запуском!
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
                                             chat_id TEXT PRIMARY KEY,
                                             username TEXT,
                                             language TEXT DEFAULT 'en',
                                             joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

const pendingBroadcasts = {};
const userStates = {};

// --- БОТ ---
let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен');

        // 1. ЛОВИМ ВСЕ СООБЩЕНИЯ (Логика сохранения и Рассылки)
        bot.on('message', async (msg) => {
            if (!msg.from) return;

            const chatId = msg.chat.id.toString();
            const username = msg.from.username || 'unknown';

            // А) Сохраняем юзера (по умолчанию en)
            if (msg.chat.type === 'private') {
                const stmt = db.prepare("INSERT OR IGNORE INTO users (chat_id, username, language) VALUES (?, ?, 'en')");
                stmt.run(chatId, username);
                stmt.finalize();
            }

            // Б) Проверяем режим рассылки
            if (userStates[chatId] === 'WAITING_FOR_BROADCAST') {
                // Если ввел команду вместо поста — отменяем ожидание
                if (msg.text && msg.text.startsWith('/')) {
                    delete userStates[chatId];
                    // И даем коду ниже обработать эту команду
                } else {
                    const isAdmin = chatId === ADMIN_ID;
                    const isMod = MOD_IDS.includes(chatId);

                    // Сбрасываем состояние
                    delete userStates[chatId];

                    if (isAdmin) {
                        // АДМИН: Сразу шлём всем
                        await startCopyBroadcast(chatId, msg.message_id, chatId);
                    } else if (isMod) {
                        // МОДЕРАТОР: Шлём админу
                        const broadcastId = Date.now().toString();
                        pendingBroadcasts[broadcastId] = {
                            fromChatId: chatId,
                            messageId: msg.message_id,
                            modUsername: username,
                            modId: chatId
                        };

                        // Копия админу
                        await bot.copyMessage(ADMIN_ID, chatId, msg.message_id);

                        const msgToAdmin = `👮‍♂️ <b>МОДЕРАТОР</b> @${username} хочет сделать рассылку.`;
                        await bot.sendMessage(ADMIN_ID, msgToAdmin, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '✅ Одобрить', callback_data: `approve_${broadcastId}` },
                                        { text: '❌ Отклонить', callback_data: `reject_${broadcastId}` }
                                    ]
                                ]
                            }
                        });
                        await bot.sendMessage(chatId, '⏳ Пост отправлен на проверку Админу.');
                    }
                    return; // Прерываем, чтобы не обрабатывать это сообщение дальше
                }
            }
        });

        // 2. КОМАНДА /start (Выбор языка)
        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;
            const welcomeText =
                `👋 <b>Welcome to CocoNet Bot!</b>

Here you can buy <b>Telegram Stars</b> and <b>Premium</b> without Fragment verification using TON.

👇 <b>Please choose your language:</b>`;

            bot.sendMessage(chatId, welcomeText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🇺🇸 English', callback_data: 'set_lang_en' },
                            { text: '🇷🇺 Русский', callback_data: 'set_lang_ru' }
                        ],
                        [{ text: '🚀 Open App / Открыть', web_app: { url: 'https://web-production-03b2.up.railway.app' } }]
                    ]
                }
            });
        });

        // 3. КОМАНДА /language (Смена языка)
        bot.onText(/\/language/, (msg) => {
            const chatId = msg.chat.id;
            bot.sendMessage(chatId, '🌐 <b>Choose your language / Выберите язык:</b>', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🇺🇸 English', callback_data: 'set_lang_en' },
                            { text: '🇷🇺 Русский', callback_data: 'set_lang_ru' }
                        ]
                    ]
                }
            });
        });

        // 4. КОМАНДА /help (Помощь + Язык)
        bot.onText(/\/help/, (msg) => {
            const chatId = msg.chat.id.toString();
            const isAdmin = chatId === ADMIN_ID;
            const isMod = MOD_IDS.includes(chatId);

            if (!isAdmin && !isMod) return;

            let text = '';

            if (isAdmin) {
                text = `
👮‍♂️ <b>Панель Администратора</b>

🔹 <b>/admin</b> — Статистика продаж и пользователей.
🔹 <b>/broadcast</b> — Рассылка всем пользователям.
   <i>(Напишите команду, а следующим сообщением отправьте пост).</i>
🔹 <b>/language</b> — Сменить язык бота.
🔹 <b>/help</b> — Этот список команд.
`;
            } else if (isMod) {
                text = `
🛡 <b>Панель Модератора</b>

🔸 <b>/broadcast</b> — Предложить рассылку (отправляется на проверку Админу).
🔸 <b>/language</b> — Сменить язык.
🔸 <b>/help</b> — Этот список команд.
`;
            }

            bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        });

        // 5. КОМАНДА /broadcast (Запуск режима)
        bot.onText(/\/broadcast$/, async (msg) => {
            const chatId = msg.chat.id.toString();
            const isAdmin = chatId === ADMIN_ID;
            const isMod = MOD_IDS.includes(chatId);

            if (!isAdmin && !isMod) return bot.sendMessage(chatId, '⛔ Нет прав.');

            userStates[chatId] = 'WAITING_FOR_BROADCAST';
            await bot.sendMessage(chatId, '📢 <b>Режим рассылки активирован.</b>\n\nОтправьте следующим сообщением <b>текст, фото или видео</b> (или перешлите пост), и он будет обработан.', { parse_mode: 'HTML' });
        });

// 6. КОМАНДА /admin (Расширенная статистика)
        bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id.toString();
            if (chatId !== ADMIN_ID) return;

            try {
                // 1. Получаем курс TON к USD (для подсчета в долларах)
                let tonPrice = 0;
                try {
                    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
                    tonPrice = response.data['the-open-network'].usd;
                } catch (e) {
                    console.error('Ошибка получения курса:', e.message);
                    tonPrice = 6.5; // Если API недоступен, берем примерный курс
                }

                // 2. Функция для получения статистики за период
                const getStats = (period) => {
                    return new Promise((resolve, reject) => {
                        let query = `SELECT COUNT(*) as count, SUM(stars_amount) as stars, SUM(ton_amount) as ton FROM orders`;

                        // Если нужен только этот месяц (SQLite синтаксис)
                        if (period === 'month') {
                            query += ` WHERE created_at >= date('now','start of month')`;
                        }

                        db.get(query, [], (err, row) => {
                            if (err) reject(err);
                            else resolve({
                                count: row.count || 0,
                                stars: row.stars || 0,
                                ton: row.ton || 0
                            });
                        });
                    });
                };

                // 3. Получаем кол-во пользователей
                const getUserCount = () => {
                    return new Promise(resolve => {
                        db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => resolve(row ? row.count : 0));
                    });
                };

                // Выполняем запросы параллельно
                const [allTime, monthly, usersCount] = await Promise.all([
                    getStats('all'),   // За все время
                    getStats('month'), // За этот месяц
                    getUserCount()     // Пользователи
                ]);

                // Считаем USD
                const totalUsd = (allTime.ton * tonPrice).toFixed(2);
                const monthUsd = (monthly.ton * tonPrice).toFixed(2);
                const totalTon = allTime.ton.toFixed(2);
                const monthTon = monthly.ton.toFixed(2);

                const text = `
👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>

👥 <b>Аудитория бота:</b> ${usersCount} чел.
<i>(Пользователи, нажавшие /start)</i>

📅 <b>СТАТИСТИКА ЗА МЕСЯЦ:</b>
💵 <b>Доход:</b> $${monthUsd}
💎 <b>В крипте:</b> ${monthTon} TON
⭐ <b>Звезд продано:</b> ${monthly.stars}
🛒 <b>Кол-во покупок:</b> ${monthly.count}

📈 <b>ЗА ВСЕ ВРЕМЯ:</b>
💰 <b>Оборот:</b> $${totalUsd}
💎 <b>В крипте:</b> ${totalTon} TON
⭐ <b>Всего звёзд:</b> ${allTime.stars}
📦 <b>Всего заказов:</b> ${allTime.count}

ℹ️ <i>Курс расчета: 1 TON ≈ $${tonPrice}</i>
`;
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

            } catch (e) {
                console.error(e);
                bot.sendMessage(chatId, '❌ Ошибка при получении статистики.');
            }
        });

        // 7. ОБРАБОТКА КНОПОК (Язык + Модерация)
        bot.on('callback_query', async (query) => {
            const { data, message } = query;
            const chatId = message.chat.id.toString();

            // -- Смена языка --
            if (data === 'set_lang_en' || data === 'set_lang_ru') {
                const lang = data === 'set_lang_ru' ? 'ru' : 'en';

                db.run("UPDATE users SET language = ? WHERE chat_id = ?", [lang, chatId], (err) => {
                    if (err) console.error(err);
                });

                let responseText = '';
                let btnText = '';

                if (lang === 'ru') {
                    responseText = "✅ <b>Язык установлен: Русский</b>\n\nТеперь вы можете использовать все возможности бота.";
                    btnText = "🚀 Открыть приложение";
                } else {
                    responseText = "✅ <b>Language set: English</b>\n\nNow you can use all features of the bot.";
                    btnText = "🚀 Open App";
                }

                bot.editMessageText(responseText, {
                    chat_id: chatId,
                    message_id: message.message_id,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: btnText, web_app: { url: 'https://web-production-03b2.up.railway.app' } }]
                        ]
                    }
                });
                return bot.answerCallbackQuery(query.id);
            }

            // -- Админка --
            if (chatId !== ADMIN_ID) return;

            if (data.startsWith('approve_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    bot.editMessageText('✅ <b>ОДОБРЕНО. Рассылка запущена.</b>', {
                        chat_id: chatId, message_id: message.message_id, parse_mode: 'HTML'
                    }).catch(() => {});

                    await startCopyBroadcast(request.fromChatId, request.messageId, chatId);

                    bot.sendMessage(request.modId, '✅ Ваш пост одобрен и рассылается!');
                    delete pendingBroadcasts[broadcastId];
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Пост устарел' });
                }
            }
            else if (data.startsWith('reject_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    bot.editMessageText('❌ <b>ОТКЛОНЕНО.</b>', {
                        chat_id: chatId, message_id: message.message_id, parse_mode: 'HTML'
                    }).catch(() => {});

                    bot.sendMessage(request.modId, '❌ Ваш пост был отклонен.');
                    delete pendingBroadcasts[broadcastId];
                }
            }
        });

        // Функция копирования
        async function startCopyBroadcast(fromChatId, messageId, logChatId) {
            db.all("SELECT chat_id FROM users", async (err, rows) => {
                if (err || !rows) return;
                bot.sendMessage(logChatId, `🚀 Рассылка на ${rows.length} чел...`);

                let success = 0;
                for (const row of rows) {
                    try {
                        await bot.copyMessage(row.chat_id, fromChatId, messageId);
                        success++;
                    } catch (e) {}
                    // Пауза 40мс
                    await new Promise(r => setTimeout(r, 40));
                }
                bot.sendMessage(logChatId, `🏁 <b>Готово!</b>\n✅ Доставлено: ${success}`, { parse_mode: 'HTML' });
            });
        }

    } catch (error) {
        console.error('❌ Ошибка бота:', error.message);
    }
}

// --- API ---
app.get('/health', (req, res) => { res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' }); });

// API: Получить юзера (с языком)
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();

        let dbUserLanguage = 'en';

        // Ищем язык в БД
        const getDbUser = () => new Promise(resolve => {
            db.get("SELECT language FROM users WHERE username = ? COLLATE NOCASE", [clean], (err, row) => {
                resolve(row ? row.language : null);
            });
        });

        const storedLang = await getDbUser();
        if (storedLang) dbUserLanguage = storedLang;

        let tgInfo = { name: clean, username: clean, photo: null };
        if (bot) {
            try {
                const chat = await bot.getChat(`@${clean}`);
                if (chat.photo) tgInfo.photo = await bot.getFileLink(chat.photo.small_file_id);
                tgInfo.name = chat.first_name || chat.title || clean;
            } catch (e) {}
        }

        return res.json({ ...tgInfo, language: dbUserLanguage });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;
        if (!username || !amountStars) return res.status(400).json({ error: 'No data' });

        const stmt = db.prepare(`INSERT INTO orders (username, stars_amount, ton_amount, wallet) VALUES (?, ?, ?, ?)`);
        stmt.run(username, amountStars, amountTon, wallet || 'unknown');
        stmt.finalize();

        if (bot && ADMIN_ID) {
            const msg = `✅ <b>НОВЫЙ ЗАКАЗ!</b>\n👤 @${username}\n⭐ ${amountStars}\n💎 ${amountTon} TON\n👛 <code>${wallet}</code>`;
            bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' }).catch(() => {});
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server running on port ${PORT}`); });