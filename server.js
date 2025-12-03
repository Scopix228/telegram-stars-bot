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

// --- ЭКОНОМИКА (Для подсчета прибыли) ---
const PRICE_BUY = 0.015;  // Цена покупки (Fragment)
const PRICE_SELL = 0.017; // Твоя цена продажи
const TX_GAS_COST = 0.05; // Расход на газ (примерно)

console.log('🚀 Запуск сервера...');

// --- БАЗА ДАННЫХ (SQLite) ---
const db = new sqlite3.Database('./orders.db', (err) => {
    if (err) console.error('❌ Ошибка БД:', err.message);
    else console.log('✅ База данных подключена');
});

// Создаем таблицу заказов
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

// --- ИНИЦИАЛИЗАЦИЯ БОТА ---
let bot = null;

if (TOKEN) {
    try {
        // ВАЖНО: polling: true заставляет бота слушать команды
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен и слушает команды');

        // === КОМАНДА /ADMIN ===
        bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id.toString();

            // 1. Проверка: ты ли это?
            if (chatId !== ADMIN_ID) {
                return bot.sendMessage(chatId, '⛔ Доступ запрещен.');
            }

            console.log(`👑 Админ ${chatId} запросил статистику`);

            // Функция для запроса к БД
            const getStats = (days) => {
                return new Promise((resolve, reject) => {
                    let query = `
                        SELECT 
                            COUNT(*) as count, 
                            COUNT(DISTINCT username) as unique_users, 
                            SUM(stars_amount) as total_stars, 
                            SUM(ton_amount) as total_ton 
                        FROM orders
                    `;

                    // Фильтр по времени (если days > 0)
                    if (days > 0) {
                        query += ` WHERE created_at >= datetime('now', '-${days} days')`;
                    }

                    db.get(query, [], (err, row) => {
                        if (err) {
                            reject(err);
                        } else {
                            // Если база пустая, row будет, но значения null. Заменяем их на 0.
                            resolve({
                                count: row.count || 0,
                                unique_users: row.unique_users || 0,
                                total_stars: row.total_stars || 0,
                                total_ton: row.total_ton || 0
                            });
                        }
                    });
                });
            };

            try {
                // Запрашиваем 3 периода одновременно
                const [week, month, all] = await Promise.all([
                    getStats(7),
                    getStats(30),
                    getStats(0)
                ]);

                // --- РАСЧЕТ ЧИСТОЙ ПРИБЫЛИ (За все время) ---
                // Твоя наценка * кол-во звезд
                const grossProfit = all.total_stars * (PRICE_SELL - PRICE_BUY);
                // Газ за транзакции
                const totalGas = all.count * TX_GAS_COST;
                // Итог
                const netProfit = grossProfit - totalGas;

                const text = `
👑 <b>ПАНЕЛЬ ВЛАДЕЛЬЦА</b>

📅 <b>За 7 дней:</b>
• Заказов: <code>${week.count}</code>
• Звезд: <code>${week.total_stars}</code> ⭐️
• Людей: <code>${week.unique_users}</code> 👤
• Оборот: <code>${week.total_ton.toFixed(2)}</code> TON 💎

🗓 <b>За 30 дней:</b>
• Заказов: <code>${month.count}</code>
• Звезд: <code>${month.total_stars}</code> ⭐️
• Людей: <code>${month.unique_users}</code> 👤
• Оборот: <code>${month.total_ton.toFixed(2)}</code> TON 💎

♾ <b>ЗА ВСЕ ВРЕМЯ:</b>
• Всего заказов: <code>${all.count}</code>
• Всего звезд: <code>${all.total_stars}</code> ⭐️
• Общий объем: <code>${all.total_ton.toFixed(2)}</code> TON 💎
-----------------------------
💰 <b>ФИНАНСЫ (Приблиз.):</b>
• Маржа: <code>$${grossProfit.toFixed(2)}</code>
• Расход на газ: <code>-$${totalGas.toFixed(2)}</code>
✅ <b>ЧИСТАЯ ПРИБЫЛЬ: $${netProfit.toFixed(2)}</b>
`;
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

            } catch (e) {
                console.error('Ошибка SQL:', e);
                bot.sendMessage(chatId, 'Ошибка при чтении базы данных.');
            }
        });

    } catch (error) {
        console.error('❌ Ошибка запуска бота:', error.message);
    }
}

// --- API (ДЛЯ САЙТА) ---

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' });
});

app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();

        // Поиск через веб (быстро и надежно)
        try {
            const resp = await axios.get(`https://t.me/${clean}`);
            const $ = cheerio.load(resp.data);
            const name = $('div.tgme_page_title').text().trim();
            const photo = $('meta[property="og:image"]').attr('content');
            if(!name) throw new Error('No name');
            return res.json({ name, username: clean, photo });
        } catch (e) {
            // Фолбек: если веб не сработал, пробуем через API бота
            if (bot) {
                try {
                    const chat = await bot.getChat(`@${clean}`);
                    // Получаем фото
                    let photoUrl = null;
                    if (chat.photo) {
                        photoUrl = await bot.getFileLink(chat.photo.small_file_id);
                    }
                    return res.json({
                        name: chat.first_name || chat.title || clean,
                        username: clean,
                        photo: photoUrl
                    });
                } catch (botErr) {
                    return res.status(404).json({ error: 'Not found' });
                }
            }
            return res.status(404).json({ error: 'Not found' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// УВЕДОМЛЕНИЕ ОБ ОПЛАТЕ + СОХРАНЕНИЕ
app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;

        if (!username || !amountStars) return res.status(400).json({ error: 'No data' });

        console.log(`💰 New Order: @${username}, ${amountStars} stars`);

        // 1. Сохраняем в БД
        const stmt = db.prepare(`
            INSERT INTO orders (username, stars_amount, ton_amount, wallet)
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(username, amountStars, amountTon, wallet || 'unknown');
        stmt.finalize();

        // 2. Пишем админу
        if (bot && ADMIN_ID) {
            const msg = `
✅ <b>ОПЛАТА ПРОШЛА!</b>
👤 Клиент: @${username}
⭐ Звезды: ${amountStars}
💎 Сумма: ${amountTon} TON
👛 Кошелек: <code>${wallet}</code>
`;
            bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' }).catch(err => console.error("Не удалось отправить сообщение админу:", err.message));
        }

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});