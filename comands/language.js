module.exports = (bot, msg) => {
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
};