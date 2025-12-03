const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose(); // Подключаем БД
const TelegramBot = require('node-telegram-bot-api'); // Подключаем тут сразу

const app = express();
app.use(cors());
app.use(express.json());

// --- НАСТРОЙКИ ---
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN;
// Приводим ID к строке для надежного сравнения
const ADMIN_ID = process.env.ADMIN_ID ? process.env.ADMIN_ID.toString() : null;

// --- ЭКОНОМИКА (Для расчета прибыли) ---
const PRICE_BUY = 0.015;  // За сколько покупаешь ты ($)
const PRICE_SELL = 0.017; // За сколько продаешь ($)
const TX_GAS_COST = 0.05; // Примерная стоимость газа за 2 транзакции (в $)

// --- БАЗА ДАННЫХ (SQLite) ---
// Создаем файл базы данных orders.db
const db = new sqlite3.Database('./orders.db', (err) => {
    if (err) console.error('❌ Ошибка подключения к БД:', err.message);
    else console.log('✅ База данных подключена');
});

// Создаем таблицу, если её нет
db.run(`
    CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        user_id TEXT,
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
        bot = new TelegramBot(TOKEN, { polling: true }); // Включаем polling для приема команд
        console.log('✅ Бот запущен (Polling)');

        // === ЛОГИКА АДМИН ПАНЕЛИ ===
        bot.onText(/\/admin/, async (msg) => {
            const chatId = msg.chat.id.toString();

            // 1. Проверка на админа
            if (chatId !== ADMIN_ID) {
                return bot.sendMessage(chatId, '⛔ У вас нет доступа к этой команде.');
            }

            // 2. Функция для получения статистики за период
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

                    // Если days = 0, то берем за все время, иначе добавляем условие времени
                    if (days > 0) {
                        query += ` WHERE created_at >= datetime('now', '-${days} days')`;
                    }

                    db.get(query, [], (err, row) => {
                        if (err) reject(err);
                        else resolve(row || { count: 0, unique_users: 0, total_stars: 0, total_ton: 0 });
                    });
                });
            };

            try {
                // Запрашиваем данные параллельно
                const [week, month, all] = await Promise.all([
                    getStats(7),  // Неделя
                    getStats(30), // Месяц
                    getStats(0)   // Все время
                ]);

                // 3. Расчет прибыли (на основе данных за все время)
                // Грязная прибыль = (Цена продажи - Цена покупки) * Кол-во звезд
                const totalStars = all.total_stars || 0;
                const grossProfit = totalStars * (PRICE_SELL - PRICE_BUY);

                // Расходы на газ = Кол-во транзакций * Стоимость газа
                const totalTx = all.count || 0;
                const totalGas = totalTx * TX_GAS_COST;

                // Чистая прибыль
                const netProfit = grossProfit - totalGas;

                // 4. Формируем сообщение
                const text = `
👑 <b>АДМИН ПАНЕЛЬ</b>

📅 <b>За 7 дней:</b>
• Продаж: ${week.count} шт.
• Звезд: <b>${week.total_stars || 0}</b> ⭐️
• Людей: ${week.unique_users} 👤
• Оборот: ${(week.total_ton || 0).toFixed(2)} TON 💎

🗓 <b>За 30 дней:</b>
• Продаж: ${month.count} шт.
• Звезд: <b>${month.total_stars || 0}</b> ⭐️
• Людей: ${month.unique_users} 👤
• Оборот: ${(month.total_ton || 0).toFixed(2)} TON 💎

♾ <b>ЗА ВСЕ ВРЕМЯ:</b>
• Всего заказов: ${all.count}
• Всего звезд: <b>${all.total_stars || 0}</b> ⭐️
• Общий оборот: <b>${(all.total_ton || 0).toFixed(2)}</b> TON
-----------------------------
💰 <b>ФИНАНСЫ (Чистыми):</b>
• Маржа: $${grossProfit.toFixed(2)}
• Расход на газ: -$${totalGas.toFixed(2)}
✅ <b>ИТОГ: $${netProfit.toFixed(2)}</b>
`;
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

            } catch (e) {
                console.error('Ошибка админки:', e);
                bot.sendMessage(chatId, 'Ошибка при расчете статистики.');
            }
        });

    } catch (error) {
        console.error('❌ Ошибка бота:', error.message);
    }
}

// --- API ЭНДПОИНТЫ ---

app.get('/health', (req, res) => {
    res.json({ status: 'OK', bot: bot ? 'active' : 'inactive' });
});

app.get('/get-user', async (req, res) => {
    // ... (Твой старый код поиска пользователя оставляем без изменений)
    // Я его сократил тут для удобства чтения, но ты оставь как было
    // или скопируй из предыдущей версии server.js ту часть, что внутри /get-user
    try {
        const username = req.query.username;
        if (!username) return res.status(400).json({ error: 'No username' });
        const clean = username.replace('@', '').trim();

        // Быстрый поиск через веб
        try {
            const resp = await axios.get(`https://t.me/${clean}`);
            const $ = cheerio.load(resp.data);
            const name = $('div.tgme_page_title').text().trim();
            const photo = $('meta[property="og:image"]').attr('content');
            if(!name) throw new Error('No name');
            return res.json({ name, username: clean, photo });
        } catch (e) {
            return res.status(404).json({ error: 'Not found' });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. УВЕДОМЛЕНИЕ ОБ ОПЛАТЕ + СОХРАНЕНИЕ В БД
app.post('/notify-payment', async (req, res) => {
    try {
        const { username, amountStars, amountTon, wallet } = req.body;

        if (!username || !amountStars || !amountTon) {
            return res.status(400).json({ error: 'No data' });
        }

        console.log(`💰 Оплата: @${username} | ${amountStars} зв. | ${amountTon} TON`);

        // 1. СОХРАНЯЕМ В БД
        const stmt = db.prepare(`
            INSERT INTO orders (username, stars_amount, ton_amount, wallet) 
            VALUES (?, ?, ?, ?)
        `);
        stmt.run(username, amountStars, amountTon, wallet || 'unknown');
        stmt.finalize();

        // 2. ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ АДМИНУ
        if (bot && ADMIN_ID) {
            const msg = `
✅ <b>НОВЫЙ ЗАКАЗ!</b>
👤 Покупатель: @${username}
⭐ Звезды: ${amountStars}
💎 Сумма: ${amountTon} TON
👛 Кошелек: <code>${wallet}</code>
`;
            bot.sendMessage(ADMIN_ID, msg, { parse_mode: 'HTML' });
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Payment error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер работает на порту ${PORT}`);
});