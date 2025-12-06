const axios = require('axios'); // Нужно импортировать axios здесь

module.exports = async (bot, msg, db, ADMIN_ID) => {
    const chatId = msg.chat.id.toString();
    if (chatId !== ADMIN_ID) return;

    try {
        // 1. Получаем курс TON
        let tonPrice = 0;
        try {
            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
            tonPrice = response.data['the-open-network'].usd;
        } catch (e) {
            console.error('Ошибка курса:', e.message);
            tonPrice = 6.5;
        }

        // 2. Статистика
        const getStats = (period) => {
            return new Promise((resolve, reject) => {
                let query = `SELECT COUNT(*) as count, SUM(stars_amount) as stars, SUM(ton_amount) as ton FROM orders`;
                if (period === 'month') {
                    query += ` WHERE created_at >= date('now','start of month')`;
                }
                db.get(query, [], (err, row) => {
                    if (err) reject(err);
                    else resolve({ count: row.count || 0, stars: row.stars || 0, ton: row.ton || 0 });
                });
            });
        };

        const getUserCount = () => {
            return new Promise(resolve => {
                db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => resolve(row ? row.count : 0));
            });
        };

        const [allTime, monthly, usersCount] = await Promise.all([
            getStats('all'),
            getStats('month'),
            getUserCount()
        ]);

        const totalUsd = (allTime.ton * tonPrice).toFixed(2);
        const monthUsd = (monthly.ton * tonPrice).toFixed(2);
        const totalTon = allTime.ton.toFixed(2);
        const monthTon = monthly.ton.toFixed(2);

        const text = `
👑 <b>ПАНЕЛЬ АДМИНИСТРАТОРА</b>

👥 <b>Аудитория бота:</b> ${usersCount} чел.

📅 <b>ЗА МЕСЯЦ:</b>
💵 <b>Доход:</b> $${monthUsd}
💎 <b>Крипта:</b> ${monthTon} TON
⭐ <b>Звезд:</b> ${monthly.stars}
🛒 <b>Покупок:</b> ${monthly.count}

📈 <b>ЗА ВСЕ ВРЕМЯ:</b>
💰 <b>Оборот:</b> $${totalUsd}
💎 <b>Крипта:</b> ${totalTon} TON
⭐ <b>Звезд:</b> ${allTime.stars}
📦 <b>Заказов:</b> ${allTime.count}

ℹ️ <i>Курс: 1 TON ≈ $${tonPrice}</i>
`;
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

    } catch (e) {
        console.error(e);
        bot.sendMessage(chatId, '❌ Ошибка статистики.');
    }
};