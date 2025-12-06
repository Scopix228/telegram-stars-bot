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

// --- НОВОЕ: СПИСОК МОДЕРАТОРОВ ---
// В Railway добавь переменную MOD_IDS со списком ID через запятую (напр: 123456,789012)
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
    // Таблица заказов (была раньше)
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

    // --- НОВОЕ: Таблица всех пользователей бота для рассылки ---
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            chat_id TEXT PRIMARY KEY,
            username TEXT,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Хранилище для ожидающих подтверждения рассылок (в оперативной памяти)
const pendingBroadcasts = {};

// --- БОТ И АДМИНКА ---
let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен');

        // --- НОВОЕ: Сохраняем всех, кто пишет боту /start ---
        bot.on('message', (msg) => {
            if (msg.chat.type === 'private') {
                const chatId = msg.chat.id.toString();
                const username = msg.from.username || 'unknown';

                // Пытаемся добавить юзера, если его нет (OR IGNORE пропустит, если уже есть)
                const stmt = db.prepare("INSERT OR IGNORE INTO users (chat_id, username) VALUES (?, ?)");
                stmt.run(chatId, username);
                stmt.finalize();
            }
        });

        // --- НОВОЕ: Команда рассылки /broadcast текст ---
        bot.onText(/\/broadcast (.+)/, async (msg, match) => {
            const chatId = msg.chat.id.toString();
            const textToSend = match[1]; // Текст после команды

            const isAdmin = chatId === ADMIN_ID;
            const isMod = MOD_IDS.includes(chatId);

            if (!isAdmin && !isMod) {
                return bot.sendMessage(chatId, '⛔ У вас нет прав.');
            }

            // 1. ЕСЛИ АДМИН - ШЛЕМ СРАЗУ
            if (isAdmin) {
                await startBroadcast(textToSend, chatId);
            }
            // 2. ЕСЛИ МОДЕРАТОР - ШЛЕМ АДМИНУ НА ПРОВЕРКУ
            else if (isMod) {
                // Генерируем уникальный ID для этой заявки
                const broadcastId = Date.now().toString();
                pendingBroadcasts[broadcastId] = {
                    text: textToSend,
                    modUsername: msg.from.username || chatId,
                    modId: chatId
                };

                const msgToAdmin = `
👮‍♂️ <b>МОДЕРАТОР ПРЕДЛАГАЕТ РАССЫЛКУ</b>
👤 От: @${msg.from.username}

📄 <b>Текст:</b>
${textToSend}
`;
                // Отправляем админу с кнопками
                await bot.sendMessage(ADMIN_ID, msgToAdmin, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ Подтвердить', callback_data: `approve_${broadcastId}` },
                                { text: '❌ Отклонить', callback_data: `reject_${broadcastId}` }
                            ]
                        ]
                    }
                });

                await bot.sendMessage(chatId, '⏳ Ваша рассылка отправлена на проверку Админу.');
            }
        });

        // --- НОВОЕ: Обработка кнопок Админа ---
        bot.on('callback_query', async (query) => {
            const { data, message } = query;
            const chatId = query.message.chat.id.toString();

            if (chatId !== ADMIN_ID) return;

            if (data.startsWith('approve_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    await bot.editMessageText(`${message.text}\n\n✅ <b>ОДОБРЕНО</b> (Рассылка запущена)`, {
                        chat_id: chatId,
                        message_id: message.message_id,
                        parse_mode: 'HTML'
                    });

                    // Запускаем рассылку
                    await startBroadcast(request.text, chatId);

                    // Уведомляем модератора
                    bot.sendMessage(request.modId, '✅ Вашу рассылку одобрили и запустили!');

                    delete pendingBroadcasts[broadcastId]; // Чистим память
                } else {
                    bot.answerCallbackQuery(query.id, { text: 'Заявка устарела или не найдена' });
                }
            }

            else if (data.startsWith('reject_')) {
                const broadcastId = data.split('_')[1];
                const request = pendingBroadcasts[broadcastId];

                if (request) {
                    await bot.editMessageText(`${message.text}\n\n❌ <b>ОТКЛОНЕНО</b>`, {
                        chat_id: chatId,
                        message_id: message.message_id,
                        parse_mode: 'HTML'
                    });

                    // Уведомляем модератора
                    bot.sendMessage(request.modId, '❌ Вашу рассылку отклонили.');

                    delete pendingBroadcasts[broadcastId];
                }
            }
        });

        // Функция самой рассылки (получаем всех юзеров из БД)
        async function startBroadcast(text, adminChatId) {
            db.all("SELECT chat_id FROM users", async (err, rows) => {
                if (err) {
                    return bot.sendMessage(adminChatId, 'Ошибка при получении списка пользователей.');
                }

                if (rows.length === 0) {
                    return bot.sendMessage(adminChatId, 'Пользователей в базе нет (никто еще не нажал /start).');
                }

                bot.sendMessage(adminChatId, `🚀 Рассылка началась на ${rows.length} пользователей...`);

                let successCount = 0;
                let blockedCount = 0;

                // Проходим по всем пользователям
                for (const row of rows) {
                    try {
                        await bot.sendMessage(row.chat_id, text);
                        successCount++;
                    } catch (e) {
                        // Пользователь заблокировал бота
                        blockedCount++;
                    }
                    // Маленькая задержка, чтобы Телеграм не забанил за спам (30-50мс)
                    await new Promise(r => setTimeout(r, 50));
                }

                bot.sendMessage(adminChatId, `🏁 <b>Рассылка завершена!</b>\n✅ Доставлено: ${successCount}\n💀 Заблокировали: ${blockedCount}`, { parse_mode: 'HTML' });
            });
        }

        // --- СТАРАЯ АДМИНКА (оставляем как есть) ---
        bot.onText(/\/admin/, async (msg) => {
            // ... твой старый код админки здесь ...
            // (Я его скрыл для краткости, но он должен остаться)
            const chatId = msg.chat.id.toString();
            if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ Нет доступа.');
            // ... логика статистики ...
        });

    } catch (error) {
        console.error('❌ Ошибка бота:', error.message);
    }
}

// --- API ---

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' });
});

// ... ОСТАЛЬНЫЕ API ENDPOINTS (/get-user, /notify-payment) ОСТАВЛЯЕМ БЕЗ ИЗМЕНЕНИЙ ...
app.get('/get-user', async (req, res) => { /* твой код */ });
app.post('/notify-payment', async (req, res) => { /* твой код */ });

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});