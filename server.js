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

// --- БОТ И АДМИНКА ---
let bot = null;
if (TOKEN) {
    try {
        bot = new TelegramBot(TOKEN, { polling: true });
        console.log('✅ Бот запущен');

        bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id.toString();
            if (chatId !== ADMIN_ID) return bot.sendMessage(chatId, '⛔ Нет доступа.');

            const getStats = (days) => {
                return new Promise((resolve, reject) => {
                    let query = `SELECT COUNT(*) as count, COUNT(DISTINCT username) as unique_users, SUM(stars_amount) as total_stars, SUM(ton_amount) as total_ton FROM orders`;
                    if (days > 0) query += ` WHERE created_at >= datetime('now', '-${days} days')`;
                    db.get(query, [], (err, row) => {
                        if (err) reject(err);
                        else resolve({
                            count: row.count || 0,
                            unique_users: row.unique_users || 0,
                            total_stars: row.total_stars || 0,
                            total_ton: row.total_ton || 0
                        });
                    });
                });
            };

            try {
                const [week, month, all] = await Promise.all([getStats(7), getStats(30), getStats(0)]);
                const grossProfit = all.total_stars * (PRICE_SELL - PRICE_BUY);
                const totalGas = all.count * TX_GAS_COST;
                const netProfit = grossProfit - totalGas;

                const text = `
👑 <b>АДМИН ПАНЕЛЬ</b>

📅 <b>7 дней:</b> ${week.count} продаж | ${week.total_stars} зв. | ${week.total_ton.toFixed(2)} TON
🗓 <b>30 дней:</b> ${month.count} продаж | ${month.total_stars} зв. | ${month.total_ton.toFixed(2)} TON
♾ <b>ВСЕГО:</b> ${all.count} продаж | <b>${all.total_stars}</b> зв. | <b>${all.total_ton.toFixed(2)}</b> TON
----------------
💰 <b>ЧИСТАЯ ПРИБЫЛЬ: $${netProfit.toFixed(2)}</b>
`;
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
            } catch (e) {
                bot.sendMessage(chatId, 'Ошибка БД');
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

// ПОИСК ПОЛЬЗОВАТЕЛЯ (С ЛОГАМИ)
app.get('/get-user', async (req, res) => {
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });

        const clean = username.replace('@', '').trim();

        // ВОТ ЗДЕСЬ МЫ ВЕРНУЛИ ЛОГ
        console.log(`🔍 Ищем: @${clean}`);

        // 1. Пробуем через веб (быстро)
        try {
            const resp = await axios.get(`https://t.me/${clean}`, { timeout: 5000 });
            const $ = cheerio.load(resp.data);
            const name = $('div.tgme_page_title').text().trim();
            const photo = $('meta[property="og:image"]').attr('content');

            if (name) {
                return res.json({ name, username: clean, photo });
            }
        } catch (e) {
            // Игнорируем ошибку веба, идем к боту
        }

        // 2. Если веб не нашел, пробуем через API бота (если он есть)
        if (bot) {
            try {
                const chat = await bot.getChat(`@${clean}`);
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
                console.log(`🤖 Бот тоже не нашел: @${clean}`);
            }
        }

        return res.status(404).json({ error: 'Not found' });

    } catch (e) {
        console.error('Search error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

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