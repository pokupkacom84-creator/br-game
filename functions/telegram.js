const functions = require('firebase-functions');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = functions.config().telegram.token; // задаётся через CLI
const ADMIN_CHAT_ID = functions.config().telegram.admin; // твой ID

let bot = null;
function getBot() {
  if (!bot) bot = new TelegramBot(BOT_TOKEN);
  return bot;
}

// ============ Вебхук ============
exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  const b = getBot();
  const msg = req.body.message || req.body.callback_query?.message;
  const cb = req.body.callback_query;

  // --- Callback от кнопок (Подтвердить/Отклонить) ---
  if (cb) {
    const data = cb.data; // "confirm_<uid>_<rid>" или "reject_<uid>_<rid>"
    const parts = data.split('_');
    const action = parts[0];
    const uid = parts[1];
    const rid = parts[2];

    if (cb.from.id.toString() !== ADMIN_CHAT_ID.toString()) {
      await b.answerCallbackQuery(cb.id, { text: 'Нет доступа' });
      return res.send('ok');
    }

    const payRef = admin.database().ref(`payments/${uid}/${rid}`);
    if (action === 'confirm') {
      await payRef.update({
        status: 'confirmed',
        confirmedAt: Date.now(),
        confirmedBy: 'telegram'
      });
      await b.answerCallbackQuery(cb.id, { text: '✅ Зачислено' });
      await b.editMessageReplyMarkup({ chat_id: cb.message.chat.id, message_id: cb.message.message_id }, { reply_markup: { inline_keyboard: [] } });
      await b.sendMessage(cb.message.chat.id, '✅ Пользователю зачислены звёзды');
    } else {
      await payRef.update({
        status: 'rejected',
        rejectedAt: Date.now(),
        reason: 'Отклонено администратором'
      });
      await b.answerCallbackQuery(cb.id, { text: '❌ Отклонено' });
      await b.editMessageReplyMarkup({ chat_id: cb.message.chat.id, message_id: cb.message.message_id }, { reply_markup: { inline_keyboard: [] } });
      await b.sendMessage(cb.message.chat.id, '❌ Заявка отклонена');
    }
    return res.send('ok');
  }

  if (!msg) return res.send('ok');

  const chatId = msg.chat.id;
  const text = msg.text || '';
  const photo = msg.photo;

  // --- /start с payload = <uid>_<packId> ---
  if (text.startsWith('/start')) {
    const payload = text.split(' ')[1] || '';
    const [uid, packId] = payload.split('_');

    if (!uid || !packId) {
      await b.sendMessage(chatId, 'Привет! Открой оплату из приложения Flux.');
      return res.send('ok');
    }

    // Загружаем пользователя и пакет
    const userSnap = await admin.database().ref(`users/${uid}`).once('value');
    const user = userSnap.val() || {};
    const PACKS = {
      p1: { stars: 100, rub: 99 },
      p2: { stars: 250, rub: 249 },
      p3: { stars: 500, rub: 449 },
      p4: { stars: 1000, rub: 849 },
      p5: { stars: 2500, rub: 1990 },
      p6: { stars: 5000, rub: 3790 },
      p7: { stars: 10000, rub: 6990 }
    };
    const pack = PACKS[packId];
    if (!pack) {
      await b.sendMessage(chatId, 'Неизвестный пакет');
      return res.send('ok');
    }

    // Создаём заявку в Firebase
    const reqRef = admin.database().ref(`payments/${uid}`).push();
    const reqId = reqRef.key;
    const code = 'F' + Date.now().toString().slice(-6);
    await reqRef.set({
      requestId: reqId,
      userId: uid,
      userName: user.name || '',
      username: user.username || '',
      packId,
      stars: pack.stars,
      rub: pack.rub,
      status: 'pending',
      code,
      credited: false,
      createdAt: Date.now(),
      source: 'telegram'
    });

    const cardNumber = functions.config().payment.card;
    const phoneSBP = functions.config().payment.phone;
    const recipient = functions.config().payment.recipient;

    await b.sendMessage(chatId,
      `💳 *Оплата ${pack.stars} ⭐*\n\n` +
      `К оплате: *${pack.rub} ₽*\n` +
      `Код: \`${code}\`\n\n` +
      `Карта: \`${cardNumber}\`\n` +
      `СБП: \`${phoneSBP}\`\n` +
      `Получатель: ${recipient}\n\n` +
      `Переведите точную сумму с кодом в комментарии.\n` +
      `После оплаты отправьте 📸 скриншот *в этот чат*.`,
      { parse_mode: 'Markdown' }
    );

    return res.send('ok');
  }

  // --- Получили скриншот ---
  if (photo && photo.length) {
    // Ищем активную заявку пользователя по Telegram
    // (мы не знаем uid — используем последний pending заявки с этим юзернеймом)
    const tgUser = msg.from.username || msg.from.first_name || '';
    const paysSnap = await admin.database().ref('payments').once('value');
    const allPays = paysSnap.val() || {};
    let found = null;

    // Ищем pending заявки, где совпадает имя/username и недавно созданные
    const now = Date.now();
    Object.keys(allPays).forEach(uid => {
      Object.keys(allPays[uid]).forEach(rid => {
        const p = allPays[uid][rid];
        if (p.status !== 'pending') return;
        if (now - p.createdAt > 24 * 3600 * 1000) return;
        if (!p.source || p.source !== 'telegram') return;
        if (p.username && tgUser.toLowerCase().includes(p.username.toLowerCase())) {
          found = { uid, rid, pay: p };
        }
      });
    });

    if (!found) {
      await b.sendMessage(chatId, 'Не нашёл активную заявку. Открой оплату из приложения заново.');
      return res.send('ok');
    }

    // Берём самое большое фото (там больше деталей)
    const fileId = photo[photo.length - 1].file_id;
    const fileLink = await b.getFileLink(fileId);

    await admin.database().ref(`payments/${found.uid}/${found.rid}`).update({
      status: 'awaiting',
      proofImageTg: fileLink,
      proofImageFileId: fileId,
      paidAt: Date.now()
    });

    // Шлём тебе в ЛС заявку с кнопками
    await b.sendPhoto(ADMIN_CHAT_ID, fileId, {
      caption:
        `🟡 *Новая заявка на оплату*\n\n` +
        `👤 ${found.pay.userName || 'Без имени'} ${found.pay.username ? '@' + found.pay.username : ''}\n` +
        `⭐ ${found.pay.stars} звёзд\n` +
        `💰 ${found.pay.rub} ₽\n` +
        `🔑 Код: \`${found.pay.code}\`\n\n` +
        `Проверь поступление и подтверди:`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Подтвердить', callback_data: `confirm_${found.uid}_${found.rid}` },
          { text: '❌ Отклонить', callback_data: `reject_${found.uid}_${found.rid}` }
        ]]
      }
    });

    await b.sendMessage(chatId, '✅ Скриншот отправлен на проверку. Подтверждение — до 24 часов.');
    return res.send('ok');
  }

  res.send('ok');
});
