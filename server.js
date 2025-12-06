const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');

// Подключаем наши новые команды
const cmdStart = require('./commands/start');
const cmdHelp = require('./commands/help');
const cmdLanguage = require('./commands/language');
const cmdBroadcast = require('./commands/broadcast');
const cmdAdmin = require('./commands/admin');

const app = express();
app.use(cors());
app.use(express.json());

// --- НАСТРОЙКИ ---
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString() : '';
const MOD_IDS = process.env.MOD_IDS ? process.env.MOD_IDS.split(',').map(id => id.trim()) : [];

console.log('🚀 Запуск сервера...');

// --- БАЗА ДАННЫХ ---
const db = new sqlite3.Database('./orders.db', (err) => {
    if (err) console.error('❌ Ошибка БД:', err.message);
    else console.log('✅ База данных подключена');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT, stars_amount INTEGER, ton_amount REAL, wallet TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users (
        chat_id TEXT PRIMARY KEY, username TEXT, language TEXT DEFAULT 'en',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Состояние (память бота)
const pendingBroadcasts = {};
const userStates = {};

// --- БОТ ---
let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен');

        // === ПОДКЛЮЧАЕМ КОМАНДЫ ===

        // 1. /start
        bot.onText(/\/start/, (msg) => cmdStart(bot, msg));

        // 2. /language
        bot.onText(/\/language/, (msg) => cmdLanguage(bot, msg));

        // 3. /help
        bot.onText(/\/help/, (msg) => cmdHelp(bot, msg, ADMIN_ID, MOD_IDS));

        // 4. /broadcast
        bot.onText(/\/broadcast$/, (msg) => cmdBroadcast(bot, msg, ADMIN_ID, MOD_IDS, userStates));

        // 5. /admin
        bot.onText(/\/admin/, (msg) => cmdAdmin(bot, msg, db, ADMIN_ID));


        // === ОБРАБОТКА ОБЫЧНЫХ СООБЩЕНИЙ И ЛОГИКА РАССЫЛКИ ===
        bot.on('message', async (msg) => {
            if (!msg.from) return;
            const chatId = msg.chat.id.toString();
            const username = msg.from.username || 'unknown';

            // Сохраняем пользователя
            if (msg.chat.type === 'private') {
                const stmt = db.prepare("INSERT OR IGNORE INTO users (chat_id, username, language) VALUES (?, ?, 'en')");
                stmt.run(chatId, username);
                stmt.finalize();
            }

            // Логика ОЖИДАНИЯ ПОСТА ДЛЯ РАССЫЛКИ
            if (userStates[chatId] === 'WAITING_FOR_BROADCAST') {
                // Если пользователь передумал и ввел команду - сбрасываем ожидание
                if (msg.text && msg.text.startsWith('/')) {
                    delete userStates[chatId];
                    return; // Дальше сработает onText команды
                }

                const isAdmin = chatId === ADMIN_ID;
                const isMod = MOD_IDS.includes(chatId);
                delete userStates[chatId];

                if (isAdmin) {
                    await startCopyBroadcast(chatId, msg.message_id, chatId);
                } else if (isMod) {
                    const broadcastId = Date.now().toString();
                    pendingBroadcasts[broadcastId] = {
                        fromChatId: chatId, messageId: msg.message_id, modUsername: username, modId: chatId
                    };

                    await bot.copyMessage(ADMIN_ID, chatId, msg.message_id);
                    const msgToAdmin = `👮‍♂️ <b>МОДЕРАТОР</b> @${username} хочет сделать рассылку.`;
                    await bot.sendMessage(ADMIN_ID, msgToAdmin, {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [[{ text: '✅ Одобрить', callback_data: `approve_${broadcastId}` }, { text: '❌ Отклонить', callback_data: `reject_${broadcastId}` }]]
                        }
                    });
                    await bot.sendMessage(chatId, '⏳ Пост отправлен на проверку.');
                }
            }
        });

        // === ОБРАБОТКА КНОПОК ===
        bot.on('callback_query', async (query) => {
            const { data, message } = query;
            const chatId = message.chat.id.toString();

            // СМЕНА ЯЗЫКА
            if (data === 'set_lang_en' || data === 'set_lang_ru') {
                const lang = data === 'set_lang_ru' ? 'ru' : 'en';
                db.run("UPDATE users SET language = ? WHERE chat_id = ?", [lang, chatId], (err) => {
                    if (err) console.error(err);
                });

                let responseText = lang === 'ru'
                    ? "✅ <b>Язык установлен: Русский</b>\n\nТеперь вы можете использовать все возможности бота."
                    : "✅ <b>Language set: English</b>\n\nNow you can use all features of the bot.";

                let btnText = lang === 'ru' ? "🚀 Открыть приложение" : "🚀 Open App";

                bot.editMessageText(responseText, {
                    chat_id: chatId, message_id: message.message_id, parse_mode: 'HTML',
                    reply_markup: { inline_keyboard: [[{ text: btnText, web_app: { url: 'https://web-production-03b2.up.railway.app' } }]] }
                });
                return bot.answerCallbackQuery(query.id);
            }

            // МОДЕРАЦИЯ
            if (chatId !== ADMIN_ID) return;

            if (data.startsWith('approve_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];
                if (request) {
                    bot.editMessageText('✅ <b>ОДОБРЕНО. Рассылка запущена.</b>', { chat_id: chatId, message_id: message.message_id, parse_mode: 'HTML' }).catch(() => {});
                    await startCopyBroadcast(request.fromChatId, request.messageId, chatId);
                    bot.sendMessage(request.modId, '✅ Ваш пост одобрен и рассылается!');
                    delete pendingBroadcasts[broadcastId];
                } else { bot.answerCallbackQuery(query.id, { text: 'Пост устарел' }); }
            }
            else if (data.startsWith('reject_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];
                if (request) {
                    bot.editMessageText('❌ <b>ОТКЛОНЕНО.</b>', { chat_id: chatId, message_id: message.message_id, parse_mode: 'HTML' }).catch(() => {});
                    bot.sendMessage(request.modId, '❌ Ваш пост был отклонен.');
                    delete pendingBroadcasts[broadcastId];
                }
            }
        });

        // Функция рассылки
        async function startCopyBroadcast(fromChatId, messageId, logChatId) {
            db.all("SELECT chat_id FROM users", async (err, rows) => {
                if (err || !rows) return;
                bot.sendMessage(logChatId, `🚀 Рассылка на ${rows.length} чел...`);
                let success = 0;
                for (const row of rows) {
                    try { await bot.copyMessage(row.chat_id, fromChatId, messageId); success++; } catch (e) {}
                    await new Promise(r => setTimeout(r, 40));
                }
                bot.sendMessage(logChatId, `🏁 <b>Готово!</b>\n✅ Доставлено: ${success}`, { parse_mode: 'HTML' });
            });
        }

    } catch (error) { console.error('❌ Ошибка бота:', error.message); }
}

// --- API ---
app.get('/health', (req, res) => { res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' }); });

app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();

        let dbUserLanguage = 'en';
        const getDbUser = () => new Promise(resolve => {
            db.get("SELECT language FROM users WHERE username = ? COLLATE NOCASE", [clean], (err, row) => resolve(row ? row.language : null));
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