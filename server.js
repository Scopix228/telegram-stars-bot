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

const MOD_IDS = process.env.MOD_IDS ? process.env.MOD_IDS.split(',').map(id => id.trim()) : [];

console.log('🚀 Запуск сервера...');

// --- БАЗА ДАННЫХ ---
const db = new sqlite3.Database('./orders.db', (err) => {
    if (err) console.error('❌ Ошибка БД:', err.message);
    else console.log('✅ База данных подключена');
});

db.serialize(() => {
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

    // --- ОБНОВЛЕННАЯ ТАБЛИЦА (добавлено поле language) ---
    // Если таблица уже есть, удали файл orders.db перед запуском,
    // иначе колонка не появится сама.
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

        // 1. ЛОВИМ ВСЕ СООБЩЕНИЯ
        bot.on('message', async (msg) => {
            if (!msg.from) return;

            const chatId = msg.chat.id.toString();
            const username = msg.from.username || 'unknown';

            // Сохраняем пользователя (если новый, язык по дефолту 'en')
            if (msg.chat.type === 'private') {
                const stmt = db.prepare("INSERT OR IGNORE INTO users (chat_id, username, language) VALUES (?, ?, 'en')");
                stmt.run(chatId, username);
                stmt.finalize();
            }

            // Логика рассылки (как была раньше)
            if (userStates[chatId] === 'WAITING_FOR_BROADCAST') {
                if (msg.text && msg.text.startsWith('/')) {
                    delete userStates[chatId];
                } else {
                    const isAdmin = chatId === ADMIN_ID;
                    const isMod = MOD_IDS.includes(chatId);
                    delete userStates[chatId];

                    if (isAdmin) {
                        await startCopyBroadcast(chatId, msg.message_id, chatId);
                    } else if (isMod) {
                        const broadcastId = Date.now().toString();
                        pendingBroadcasts[broadcastId] = {
                            fromChatId: chatId,
                            messageId: msg.message_id,
                            modUsername: username,
                            modId: chatId
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
                    return;
                }
            }
        });

        // --- НОВОЕ: КОМАНДА /start ---
        bot.onText(/\/start/, (msg) => {
            const chatId = msg.chat.id;

            // 1. Сообщение на Английском
            const welcomeText =
                `👋 <b>Welcome to CocoNet Bot!</b>

Here you can buy <b>Telegram Stars</b> and <b>Premium</b> without Fragment verification using TON.
Fast, secure, and anonymous.

👇 <b>Please choose your language to continue:</b>`;

            bot.sendMessage(chatId, welcomeText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '🇺🇸 English', callback_data: 'set_lang_en' },
                            { text: '🇷🇺 Русский', callback_data: 'set_lang_ru' }
                        ],
                        // Можно добавить кнопку запуска сразу, но лучше после выбора языка
                        [{ text: '🚀 Open App / Открыть', web_app: { url: 'https://web-production-03b2.up.railway.app' } }]
                    ]
                }
            });
        });

        // --- НОВОЕ: Обработка выбора языка ---
        bot.on('callback_query', async (query) => {
            const { data, message } = query;
            const chatId = message.chat.id.toString();

            // Смена языка
            if (data === 'set_lang_en' || data === 'set_lang_ru') {
                const lang = data === 'set_lang_ru' ? 'ru' : 'en';

                // Обновляем БД
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

                // Удаляем кнопки выбора языка
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

                bot.answerCallbackQuery(query.id);
            }

            // ... (старый код обработки админских кнопок) ...
            if (chatId !== ADMIN_ID) return;
            if (data.startsWith('approve_')) { /* ...код одобрения... */ }
            else if (data.startsWith('reject_')) { /* ...код отклонения... */ }
        });

        // ... (Функции рассылки и админки /help, /admin без изменений) ...
        // (Для краткости я не дублирую их здесь, скопируй их из предыдущего ответа,
        //  но убедись, что startCopyBroadcast берет данные из users)

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
                    await new Promise(r => setTimeout(r, 40));
                }
                bot.sendMessage(logChatId, `🏁 Успешно: ${success}`);
            });
        }

        bot.onText(/\/help/, (msg) => { /* твой код помощи */ });
        bot.onText(/\/admin/, (msg) => { /* твой код админки */ });
        bot.onText(/\/broadcast$/, (msg) => { /* твой код рассылки */ });

    } catch (error) { console.error('❌ Ошибка бота:', error.message); }
}

// --- API ---
app.get('/health', (req, res) => { res.json({ status: 'OK' }); });

// --- ОБНОВЛЕННЫЙ GET-USER (Возвращает язык) ---
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();

        let dbUserLanguage = 'en';

        // Пытаемся найти пользователя в нашей БД, чтобы узнать его язык
        const getDbUser = () => new Promise(resolve => {
            db.get("SELECT language FROM users WHERE username = ? COLLATE NOCASE", [clean], (err, row) => {
                resolve(row ? row.language : null);
            });
        });

        const storedLang = await getDbUser();
        if (storedLang) dbUserLanguage = storedLang;

        // Пытаемся получить инфу из Телеграма
        let tgInfo = { name: clean, username: clean, photo: null };
        if (bot) {
            try {
                const chat = await bot.getChat(`@${clean}`);
                if (chat.photo) tgInfo.photo = await bot.getFileLink(chat.photo.small_file_id);
                tgInfo.name = chat.first_name || chat.title || clean;
            } catch (e) {}
        }

        // Возвращаем данные + язык
        return res.json({
            ...tgInfo,
            language: dbUserLanguage
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/notify-payment', async (req, res) => { /* старый код */ });

app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server running on port ${PORT}`); });