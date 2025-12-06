module.exports = (bot, msg) => {
    const chatId = msg.chat.id;
    const welcomeText =
        `👋 <b>Welcome to CocoNet Bot!</b>

Here you can buy <b>Telegram Stars</b> and <b>Premium</b> without Fragment verification using TON.

👇 <b>Please choose your language:</b>`;

    bot.sendMessage(chatId, welcomeText, {
        parse_mode: 'HTML',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🇺🇸 English', callback_data: 'set_lang_en' },
                    { text: '🇷🇺 Русский', callback_data: 'set_lang_ru' }
                ],
                [{ text: '🚀 Open App / Открыть', web_app: { url: 'https://web-production-03b2.up.railway.app' } }]
            ]
        }
    });
};