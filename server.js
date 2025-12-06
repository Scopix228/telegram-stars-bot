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

// Список ID модераторов (через запятую в Variables)
const MOD_IDS = process.env.MOD_IDS ? process.env.MOD_IDS.split(',').map(id => id.trim()) : [];

// --- ЭКОНОМИКА ---
const PRICE_BUY = 0.015;
const PRICE_SELL = 0.017;
const TX_GAS_COST = 0.05;

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

    // Таблица всех пользователей
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
                                             chat_id TEXT PRIMARY KEY,
                                             username TEXT,
                                             joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Хранилище временных данных
const pendingBroadcasts = {}; // Посты на проверке от модераторов
const userStates = {};        // Состояние пользователя (ждет ли бот пост?)

// --- БОТ ---
let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен');

        // 1. ЛОВИМ ВСЕ СООБЩЕНИЯ (И для БД, и для Рассылки)
        bot.on('message', async (msg) => {
            const chatId = msg.chat.id.toString();
            const username = msg.from.username || 'unknown';

            // А) Сохраняем юзера в БД (если новый)
            if (msg.chat.type === 'private') {
                const stmt = db.prepare("INSERT OR IGNORE INTO users (chat_id, username) VALUES (?, ?)");
                stmt.run(chatId, username);
                stmt.finalize();
            }

            // Б) Проверяем, ждем ли мы пост для рассылки от этого юзера
            if (userStates[chatId] === 'WAITING_FOR_BROADCAST') {
                // Если пользователь передумал и ввел другую команду - сбрасываем
                if (msg.text && msg.text.startsWith('/')) {
                    delete userStates[chatId];
                    return; // Дальше обработает обработчик команд
                }

                const isAdmin = chatId === ADMIN_ID;
                const isMod = MOD_IDS.includes(chatId);

                // Очищаем состояние (рассылка разовая)
                delete userStates[chatId];

                if (isAdmin) {
                    // АДМИН: Сразу рассылаем это сообщение
                    await startCopyBroadcast(chatId, msg.message_id, chatId);
                } else if (isMod) {
                    // МОДЕРАТОР: Отправляем админу на проверку
                    const broadcastId = Date.now().toString();

                    // Сохраняем данные о сообщении (откуда копировать)
                    pendingBroadcasts[broadcastId] = {
                        fromChatId: chatId,
                        messageId: msg.message_id,
                        modUsername: username,
                        modId: chatId
                    };

                    // 1. Копируем сообщение Админу (чтобы он увидел, как оно выглядит)
                    await bot.copyMessage(ADMIN_ID, chatId, msg.message_id);

                    // 2. Снизу кидаем кнопки
                    const msgToAdmin = `👮‍♂️ <b>МОДЕРАТОР</b> @${username} хочет сделать рассылку (пост выше).`;
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
                return; // Прерываем дальнейшую обработку
            }
        });

        // 2. КОМАНДА /broadcast (Запускает режим ожидания)
        bot.onText(/\/broadcast$/, async (msg) => {
            const chatId = msg.chat.id.toString();
            const isAdmin = chatId === ADMIN_ID;
            const isMod = MOD_IDS.includes(chatId);

            if (!isAdmin && !isMod) {
                return bot.sendMessage(chatId, '⛔ Нет прав.');
            }

            // Включаем режим ожидания
            userStates[chatId] = 'WAITING_FOR_BROADCAST';

            await bot.sendMessage(chatId, '📢 <b>Режим рассылки активирован.</b>\n\nОтправьте мне следующим сообщением то, что хотите разослать (текст, фото, видео или перешлите готовый пост).', { parse_mode: 'HTML' });
        });

        // 3. ОБРАБОТКА КНОПОК АДМИНА
        bot.on('callback_query', async (query) => {
            const { data, message } = query;
            const chatId = query.message.chat.id.toString();

            if (chatId !== ADMIN_ID) return;

            if (data.startsWith('approve_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    // Удаляем кнопки у админа
                    bot.editMessageText('✅ <b>ОДОБРЕНО. Рассылка запущена.</b>', {
                        chat_id: chatId,
                        message_id: message.message_id,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    // Запускаем копирование сообщения всем
                    await startCopyBroadcast(request.fromChatId, request.messageId, chatId);

                    bot.sendMessage(request.modId, '✅ Ваш пост одобрен и рассылается!');
                    delete pendingBroadcasts[broadcastId];
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Пост уже не актуален' });
                }
            }
            else if (data.startsWith('reject_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    bot.editMessageText('❌ <b>ОТКЛОНЕНО.</b>', {
                        chat_id: chatId,
                        message_id: message.message_id,
                        parse_mode: 'HTML'
                    }).catch(() => {});

                    bot.sendMessage(request.modId, '❌ Ваш пост был отклонен.');
                    delete pendingBroadcasts[broadcastId];
                }
            }
        });

        // --- ФУНКЦИЯ МАССОВОГО КОПИРОВАНИЯ ---
        async function startCopyBroadcast(fromChatId, messageId, logChatId) {
            // Берем ВСЕХ пользователей, которые есть в БД на ЭТОТ момент
            db.all("SELECT chat_id FROM users", async (err, rows) => {
                if (err || !rows || rows.length === 0) {
                    return bot.sendMessage(logChatId, 'Ошибка БД или нет пользователей.');
                }

                bot.sendMessage(logChatId, `🚀 Начинаю копирование для ${rows.length} пользователей...`);

                let success = 0;
                let blocked = 0;

                for (const row of rows) {
                    try {
                        // copyMessage(куда, откуда, какой_id_сообщения)
                        await bot.copyMessage(row.chat_id, fromChatId, messageId);
                        success++;
                    } catch (e) {
                        blocked++;
                    }
                    // Пауза 40мс чтобы не словить лимит (около 25 сообщений в секунду)
                    await new Promise(r => setTimeout(r, 40));
                }

                bot.sendMessage(logChatId, `🏁 <b>Готово!</b>\n✅ Доставлено: ${success}\n💀 Недоставлено: ${blocked}`, { parse_mode: 'HTML' });
            });
        }

        // --- СТАРАЯ АДМИНКА ---
        bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id.toString();
            if (chatId !== ADMIN_ID) return;

            const getStats = (days) => {
                return new Promise((resolve, reject) => {
                    let query = `SELECT COUNT(*) as count, SUM(stars_amount) as total_stars, SUM(ton_amount) as total_ton FROM orders`;
                    if (days > 0) query += ` WHERE created_at >= datetime('now', '-${days} days')`;
                    db.get(query, [], (err, row) => {
                        if (err) reject(err);
                        else resolve(row);
                    });
                });
            };

            // Простой подсчет пользователей
            const getUserCount = () => {
                return new Promise(resolve => {
                    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => resolve(row ? row.count : 0));
                });
            };

            try {
                const [all, usersCount] = await Promise.all([getStats(0), getUserCount()]);

                const text = `
👑 <b>АДМИН ПАНЕЛЬ</b>
👥 <b>Всего юзеров в боте:</b> ${usersCount}

💰 <b>Продаж за все время:</b> ${all.count || 0}
⭐ <b>Звезд продано:</b> ${all.total_stars || 0}
💎 <b>Оборот TON:</b> ${all.total_ton ? all.total_ton.toFixed(2) : 0}
`;
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
            } catch (e) {
                console.error(e);
            }
        });

    } catch (error) {
        console.error('❌ Ошибка бота:', error.message);
    }
}

// --- API ---
app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' });
});

// GET-USER API
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();
        console.log(`🔍 Ищем: @${clean}`);

        // 1. Веб поиск
        try {
            const resp = await axios.get(`https://t.me/${clean}`, { timeout: 5000 });
            const $ = cheerio.load(resp.data);
            const name = $('div.tgme_page_title').text().trim();
            const photo = $('meta[property="og:image"]').attr('content');
            if (name) return res.json({ name, username: clean, photo });
        } catch (e) {}

        // 2. Бот поиск
        if (bot) {
            try {
                const chat = await bot.getChat(`@${clean}`);
                let photoUrl = null;
                if (chat.photo) photoUrl = await bot.getFileLink(chat.photo.small_file_id);
                return res.json({
                    name: chat.first_name || chat.title || clean,
                    username: clean,
                    photo: photoUrl
                });
            } catch (botErr) {}
        }
        return res.status(404).json({ error: 'Not found' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PAYMENT API
app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;
        if (!username || !amountStars) return res.status(400).json({ error: 'No data' });

        console.log(`💰 ПРОДАЖА: @${username} | ${amountStars} зв.`);

        const stmt = db.prepare(`INSERT INTO orders (username, stars_amount, ton_amount, wallet) VALUES (?, ?, ?, ?)`);
        stmt.run(username, amountStars, amountTon, wallet || 'unknown');
        stmt.finalize();

        if (bot && ADMIN_ID) {
            const msg = `✅ <b>НОВЫЙ ЗАКАЗ!</b>\n👤 @${username}\n⭐ ${amountStars}\n💎 ${amountTon} TON\n👛 <code>${wallet}</code>`;
            bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' }).catch(() => {});
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});