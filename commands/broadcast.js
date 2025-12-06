module.exports = async (bot, msg, ADMIN_ID, MOD_IDS, userStates) => {
    const chatId = msg.chat.id.toString();
    const isAdmin = chatId === ADMIN_ID;
    const isMod = MOD_IDS.includes(chatId);

    if (!isAdmin && !isMod) return bot.sendMessage(chatId, '⛔ Нет прав.');

    // Включаем режим ожидания в главном объекте userStates
    userStates[chatId] = 'WAITING_FOR_BROADCAST';

    await bot.sendMessage(chatId, '📢 <b>Режим рассылки активирован.</b>\n\nОтправьте следующим сообщением <b>текст, фото или видео</b> (или перешлите пост), и он будет обработан.', { parse_mode: 'HTML' });
};