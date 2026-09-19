const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.pushOnMessage = functions.database
  .ref('/chats/{chatId}/messages/{msgId}')
  .onCreate(async (snap, ctx) => {
    const msg = snap.val();
    if (!msg || msg.deleted) return null;

    const chatId = ctx.params.chatId;
    const senderUid = msg.senderId;
    if (!senderUid) return null;

    // Кого уведомлять
    const metaSnap = await admin.database().ref(`chats/${chatId}/meta`).once('value');
    const meta = metaSnap.val() || {};
    let recipients = [];
    if (meta.members) {
      recipients = Object.keys(meta.members).filter(u => u !== senderUid);
    } else {
      recipients = chatId.split('_').filter(u => u !== senderUid);
    }
    if (!recipients.length) return null;

    // Имя отправителя
    const sSnap = await admin.database().ref(`users/${senderUid}`).once('value');
    const sender = sSnap.val() || {};
    const senderName = sender.name || 'Новое сообщение';

    // Собираем все токены получателей
    const tokenOwners = {};
    const tokens = [];
    for (const uid of recipients) {
      const tSnap = await admin.database().ref(`users/${uid}/fcmTokens`).once('value');
      const tObj = tSnap.val() || {};
      Object.keys(tObj).forEach(tok => {
        tokens.push(tok);
        (tokenOwners[tok] = tokenOwners[tok] || []).push(uid);
      });
    }
    if (!tokens.length) return null;

    const body = msg.type === 'sticker'
      ? 'Стикер ' + (msg.text || '')
      : (msg.text || 'Новое сообщение');

    const payload = {
      tokens,
      notification: {
        title: senderName,
        body: String(body).slice(0, 200)
      },
      data: {
        chatId: String(chatId),
        senderUid: String(senderUid),
        msgId: String(ctx.params.msgId || '')
      },
      android: {
        priority: 'high',
        notification: { channelId: 'default', sound: 'default', defaultVibrateTimings: true }
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { icon: 'https://game-cd07d.web.app/icon.png' }
      }
    };

    const resp = await admin.messaging().sendEachForMulticast(payload);

    // Чистим невалидные токены
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          invalid.push(tokens[i]);
        }
      }
    });
    for (const tok of invalid) {
      const owners = tokenOwners[tok] || [];
      for (const uid of owners) {
        await admin.database().ref(`users/${uid}/fcmTokens/${tok}`).remove();
      }
    }
    return null;
  });      Object.keys(tObj).forEach(tok => {
        tokens.push(tok);
        (tokenOwners[tok] = tokenOwners[tok] || []).push(uid);
      });
    }
    if (!tokens.length) return null;

    const body = msg.type === 'sticker'
      ? 'Стикер ' + (msg.text || '')
      : (msg.text || 'Новое сообщение');

    const payload = {
      tokens,
      notification: {
        title: senderName,
        body: String(body).slice(0, 200)
      },
      data: {
        chatId: String(chatId),
        senderUid: String(senderUid),
        msgId: String(ctx.params.msgId || '')
      },
      android: {
        priority: 'high',
        notification: { channelId: 'default', sound: 'default', defaultVibrateTimings: true }
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1, 'content-available': 1 } }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: { icon: 'https://game-cd07d.web.app/icon.png' }
      }
    };

    const resp = await admin.messaging().sendEachForMulticast(payload);

    // Чистим невалидные токены
    const invalid = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = (r.error && r.error.code) || '';
        if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
          invalid.push(tokens[i]);
        }
      }
    });
    for (const tok of invalid) {
      const owners = tokenOwners[tok] || [];
      for (const uid of owners) {
        await admin.database().ref(`users/${uid}/fcmTokens/${tok}`).remove();
      }
    }
    return null;
  });
