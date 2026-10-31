import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import { DeletedMessage } from "telegram/events/DeletedMessage";

const API_ID = 37903917;
const API_HASH = "4e2c9b6a239fefd89a6749fde0f39aad";
const SKEY = "tgyou_mtproto_session";
const W = window;

let client = null;
let TGM = false; // режим Telegram включён
let TGME = null;
const ents = {}; // chatId -> entity
const photoQ = {};

const $ = (s) => document.querySelector(s);
const sid = (x) => (x == null ? "" : String(x));
const hue = (s) => { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };

/* ---------- экран входа ---------- */
function loginHtml(step, err) {
  const T = {
    phone: ["Введите номер телефона в международном формате", "phone", "+7 900 000 00 00", "tel"],
    code: ["Код отправлен в приложение Telegram или по SMS", "code", "Код", "numeric"],
    password: ["Включена двухэтапная проверка. Введите пароль", "pw", "Пароль", "text"],
    load: ["Подключение к Telegram…", null],
  }[step];
  const img = (document.querySelector("#login img") || {}).src || "";
  let h = '<div class="auth"><div class="big">' + (img ? '<img src="' + img + '" alt="">' : "") + "</div><h2>Telegram You</h2><p>" + T[0] + "</p>";
  if (T[1]) {
    h += '<div class="afield"><input id="tgi" ' + (step === "password" ? 'type="password"' : "") + ' inputmode="' + T[3] + '" placeholder="' + T[2] + '" autocomplete="off"></div>';
    h += '<button class="tb f aw" id="tgb">Далее</button>';
  }
  h += '<div class="aerr" id="aerr">' + (err || "") + "</div></div>";
  return h;
}

function ask(step, err) {
  return new Promise((res) => {
    const el = $("#login");
    el.style.display = "flex";
    el.innerHTML = loginHtml(step, err);
    const inp = $("#tgi"), btn = $("#tgb");
    const go = () => { const v = inp.value.trim(); if (!v) return; btn.disabled = true; btn.textContent = "…"; res(v); };
    btn.onclick = go;
    inp.onkeydown = (e) => { if (e.keyCode === 13) go(); };
    setTimeout(() => inp.focus(), 100);
  });
}

async function connect() {
  const saved = localStorage.getItem(SKEY) || "";
  client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
  let lastErr = "";
  await client.start({
    phoneNumber: () => ask("phone", lastErr),
    phoneCode: () => ask("code", lastErr),
    password: () => ask("password", lastErr),
    onError: (e) => {
      const m = String((e && e.errorMessage) || (e && e.message) || e);
      lastErr = ({
        PHONE_CODE_INVALID: "Неверный код",
        PHONE_CODE_EXPIRED: "Код устарел",
        PASSWORD_HASH_INVALID: "Неверный пароль",
        PHONE_NUMBER_INVALID: "Неверный номер",
        FLOOD: "Слишком много попыток, подождите",
      })[m] || m;
      return false; // повторить шаг
    },
  });
  localStorage.setItem(SKEY, client.session.save());
}

/* ---------- конвертация данных Telegram -> формат приложения ---------- */
function kindOf(d) {
  if (d.isUser) return d.entity && d.entity.bot ? "bot" : "user";
  if (d.isChannel && !d.isGroup) return "channel";
  return "group";
}

function convMsg(m, c) {
  const o = {
    id: sid(m.id),
    tg: true,
    out: !!m.out,
    text: m.message || "",
    t: (m.date || 0) * 1000,
    from: m.out ? "me" : (m.sender && (m.sender.firstName || m.sender.title)) || c.name,
    edited: !!m.editDate,
    reply: m.replyTo && m.replyTo.replyToMsgId ? sid(m.replyTo.replyToMsgId) : undefined,
    fwd: m.fwdFrom ? (m.fwdFrom.fromName || "пользователя") : undefined,
    raw: m,
  };
  if (m.voice) { o.voice = true; o.dur = (m.voice.attributes.find((a) => a.duration) || {}).duration || 1; }
  else if (m.photo) o.photoPending = true;
  else if (m.sticker) o.sticker = (m.sticker.attributes.find((a) => a.alt) || {}).alt || "🖼";
  else if (m.media && (m.document || m.video || m.audio)) {
    const d = m.document;
    const nm = (d && d.attributes.find((a) => a.fileName) || {}).fileName || "файл";
    o.file = { k: "f", n: nm, s: d ? Number(d.size) : 0 };
    o.mid = "tg" + m.id;
  }
  return o;
}

function mkChat(d) {
  const id = sid(d.id);
  ents[id] = d.inputEntity || d.entity;
  const mute = d.dialog && d.dialog.notifySettings && d.dialog.notifySettings.muteUntil;
  const c = {
    id, tg: true, type: kindOf(d), name: d.name || "Без имени", hue: hue(id),
    peer: id, pinned: !!d.pinned, muted: !!(mute && mute > Date.now() / 1000),
    unread: d.unreadCount || 0, online: false, typing: false, msgs: [], reads: {}, ready: true, refs: [],
    members: (d.entity && d.entity.participantsCount) || 0, u: {}, uname: d.entity && d.entity.username,
  };
  if (d.message) c.msgs.push(convMsg(d.message, c));
  return c;
}

async function loadAvatar(c) {
  if (c.photo || photoQ[c.id]) return;
  photoQ[c.id] = 1;
  try {
    const b = await client.downloadProfilePhoto(ents[c.id], { isBig: false });
    if (b && b.length) { c.photo = URL.createObjectURL(new Blob([b], { type: "image/jpeg" })); W.softMain(); }
  } catch (e) {}
}

async function loadDialogs() {
  const ds = await client.getDialogs({ limit: 80 });
  W.S.chats = ds.filter((d) => !d.archived).map(mkChat);
  W.softMain();
  W.S.chats.slice(0, 30).forEach(loadAvatar);
}

async function loadHistory(c) {
  if (c.hist) return;
  c.hist = true;
  const list = await client.getMessages(ents[c.id], { limit: 60 });
  c.msgs = list.reverse().map((m) => convMsg(m, c));
  W.renderMsgs && W.S.open === c.id && W.renderMsgs();
  W.softMain();
  fetchMedia(c);
}

async function fetchMedia(c) {
  for (const m of c.msgs) {
    if (!m.raw || m.mediaDone) continue;
    if (m.photoPending || m.voice) {
      m.mediaDone = true;
      try {
        const buf = await client.downloadMedia(m.raw, {});
        if (buf) {
          const url = URL.createObjectURL(new Blob([buf], { type: m.voice ? "audio/ogg" : "image/jpeg" }));
          if (m.voice) m.audio = url; else { m.img = url; m.photoPending = false; }
          if (W.S.open === c.id) W.renderMsgs(1);
        }
      } catch (e) {}
    }
  }
}

/* ---------- запуск ---------- */
async function startTG() {
  TGM = true;
  try { await connect(); } catch (e) { TGM = false; W.showLogin("auth"); W.aerr && W.aerr({ message: String(e.message || e) }); return; }
  const me = await client.getMe();
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Я";
  W.ME = { uid: "me", name, email: me.phone ? "+" + me.phone : "" };
  TGME = W.ME;
  W.S.name = name;
  W.S.phone = W.ME.email;
  W.S.me = { name, username: me.username || "", bio: "", priv: {}, blocked: {} };
  W.S.cover = null; W.S.tab = "chats"; W.S.open = null; W.S.chats = [];
  W.S.admin = false;
  $("#login").style.display = "none";
  W.renderMain();
  client.downloadProfilePhoto("me", { isBig: false }).then((b) => {
    if (b && b.length) { W.S.me.avatar = "data:image/jpeg;base64," + btoa(String.fromCharCode(...new Uint8Array(b))); W.refreshMe(); }
  }).catch(() => {});
  await loadDialogs();
  hookEvents();
  W.toast("Подключено к Telegram");
}

/* ---------- события в реальном времени ---------- */
function chatOf(ev) {
  const id = sid(ev.chatId || (ev.message && ev.message.chatId));
  return W.S.chats.find((c) => c.id === id);
}

function hookEvents() {
  client.addEventHandler(async (ev) => {
    let c = chatOf(ev);
    const m = ev.message;
    if (!c) { await loadDialogs(); c = chatOf(ev); if (!c) return; }
    if (c.hist) {
      if (!c.msgs.some((x) => x.id === sid(m.id))) c.msgs.push(convMsg(m, c));
    } else c.msgs = [convMsg(m, c)];
    if (!m.out) {
      if (W.S.open === c.id) { markRead(c); } else {
        c.unread++;
        if (W.S.notif && !c.muted) W.toast(c.name + ": " + (m.message || "медиа").split("\n")[0]);
      }
    }
    if (W.S.open === c.id) { W.renderMsgs(1); fetchMedia(c); if (m.out) W.scrollEnd(); }
    W.softMain();
  }, new NewMessage({}));

  client.addEventHandler((ev) => {
    const c = chatOf(ev); if (!c) return;
    const m = ev.message, i = c.msgs.findIndex((x) => x.id === sid(m.id));
    if (i >= 0) { c.msgs[i] = convMsg(m, c); if (W.S.open === c.id) W.renderMsgs(1); W.softMain(); }
  }, new EditedMessage({}));

  client.addEventHandler((ev) => {
    const ids = (ev.deletedIds || []).map(sid);
    W.S.chats.forEach((c) => {
      const n = c.msgs.length;
      c.msgs = c.msgs.filter((x) => ids.indexOf(x.id) < 0);
      if (n !== c.msgs.length && W.S.open === c.id) W.renderMsgs(1);
    });
    W.softMain();
  }, new DeletedMessage({}));

  // «печатает…» и статус «в сети»
  client.addEventHandler((u) => {
    try {
      if (u instanceof Api.UpdateUserTyping || u instanceof Api.UpdateChatUserTyping) {
        const id = sid(u.userId || u.chatId);
        const c = W.S.chats.find((x) => x.id === id || x.id === sid(u.chatId));
        if (c) {
          c.typing = true; W.softMain(); if (W.S.open === c.id) W.renderChatHdr();
          clearTimeout(c._tt);
          c._tt = setTimeout(() => { c.typing = false; W.softMain(); if (W.S.open === c.id) W.renderChatHdr(); }, 5000);
        }
      } else if (u instanceof Api.UpdateUserStatus) {
        const c = W.S.chats.find((x) => x.id === sid(u.userId));
        if (c) { c.online = u.status instanceof Api.UserStatusOnline; W.softMain(); if (W.S.open === c.id) W.renderChatHdr(); }
      }
    } catch (e) {}
  });
}

/* ---------- подмена функций приложения ---------- */
function markRead(c) {
  c.unread = 0;
  client.markAsRead(ents[c.id]).catch(() => {});
}

function dataToBuf(d) {
  const b = atob(d.split(",")[1]), a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}

async function send(c, o) {
  const ent = ents[c.id];
  const replyTo = o.reply ? Number(o.reply) : undefined;
  try {
    if (o.img) {
      const f = new File([dataToBuf(o.img)], "photo.jpg", { type: "image/jpeg" });
      await client.sendFile(ent, { file: f, forceDocument: false, replyTo });
    } else if (o.voice && o.audio) {
      const f = new File([dataToBuf(o.audio)], "voice.ogg", { type: "audio/ogg" });
      await client.sendFile(ent, { file: f, voiceNote: true, attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: o.dur || 1 })], replyTo });
    } else {
      await client.sendMessage(ent, { message: o.text || o.sticker || "", replyTo, silent: !!o.silent });
    }
  } catch (e) { W.toast("Ошибка отправки: " + (e.errorMessage || e.message)); }
}

const NOPE = () => W.toast("В режиме Telegram это пока недоступно");

function patch() {
  const O = {};
  ["hideBan", "showLogin", "openChat", "pushMsg", "pushTo", "sbClick", "markRead", "doDel", "logout", "getMedia",
    "react", "pinMsg", "setTyping", "typingPing", "startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat"].forEach((n) => { O[n] = W[n]; });

  W.showLogin = function (step, mode) {
    if (TGM) return; // Firebase не должен перекрывать вход через Telegram
    O.showLogin(step, mode);
    if (step === "auth" && !TGM) {
      const el = $("#login .auth"); if (!el) return;
      const b = document.createElement("button");
      b.className = "tb f aw"; b.style.marginTop = "12px"; b.textContent = "Войти через Telegram";
      b.onclick = startTG;
      el.insertBefore(b, el.querySelector("#aerr"));
    }
  };

  // Firebase при отсутствии своего пользователя сбрасывает ME=null и зовёт hideBan() – возвращаем нашего
  W.hideBan = function () { if (TGM && TGME) W.ME = TGME; return O.hideBan.apply(this, arguments); };

  W.openChat = function (id) {
    O.openChat(id);
    const c = W.chat(id);
    if (TGM && c && c.tg) { loadHistory(c).then(() => fetchMedia(c)); markRead(c); }
  };

  W.markRead = function (c, f) { if (TGM) { if (c && c.tg && (f || W.S.open === c.id)) markRead(c); return; } O.markRead(c, f); };

  W.pushMsg = function (o) {
    if (!TGM) return O.pushMsg(o);
    const c = W.chat(W.S.open); if (!c) return;
    if (W.S.reply) o.reply = W.S.reply;
    send(c, o); W.S.reply = null; W.renderReply();
  };
  W.pushTo = function (c, o) { if (!TGM) return O.pushTo(c, o); send(c, o); };

  W.sbClick = function () {
    if (!TGM) return O.sbClick();
    const ta = $("#ta");
    if (W.S.edit) {
      const v = ta.value.trim(), c = W.chat(W.S.open), id = Number(W.S.edit);
      if (v) client.editMessage(ents[c.id], { message: id, text: v }).catch((e) => W.toast(e.errorMessage || "Ошибка"));
      W.S.edit = null; ta.value = ""; W.renderReply(); W.onType(); return;
    }
    return O.sbClick();
  };

  W.doDel = function (all) {
    if (!TGM) return O.doDel(all);
    const c = W.chat(W.S.open);
    client.deleteMessages(ents[c.id], W.S.delIds.map(Number), { revoke: !!all })
      .then(() => { c.msgs = c.msgs.filter((m) => W.S.delIds.indexOf(m.id) < 0); W.renderMsgs(1); W.softMain(); })
      .catch((e) => W.toast(e.errorMessage || "Ошибка"));
    W.clrMsel(); W.toast("Удалено");
  };

  W.react = function (mid, e) {
    if (!TGM) return O.react(mid, e);
    const c = W.chat(W.S.open);
    client.invoke(new Api.messages.SendReaction({ peer: ents[c.id], msgId: Number(mid), reaction: [new Api.ReactionEmoji({ emoticon: e })] })).catch(() => {});
  };

  W.pinMsg = function (mid) {
    if (!TGM) return O.pinMsg(mid);
    const c = W.chat(W.S.open);
    client.pinMessage(ents[c.id], Number(mid)).then(() => W.toast("Закреплено")).catch(() => W.toast("Не удалось закрепить"));
  };

  const typingAct = () => {
    const c = W.chat(W.S.open); if (!c) return;
    client.invoke(new Api.messages.SetTyping({ peer: ents[c.id], action: new Api.SendMessageTypingAction() })).catch(() => {});
  };
  W.setTyping = function (v) { if (!TGM) return O.setTyping(v); W.tyOn = v; };
  W.typingPing = function () { if (!TGM) return O.typingPing(); if (!W.typingPing.t || Date.now() - W.typingPing.t > 4000) { W.typingPing.t = Date.now(); typingAct(); } };

  W.getMedia = function (id, quiet) {
    if (!TGM) return O.getMedia(id, quiet);
    const m = W.findMsg(id); if (!m || !m.raw) return;
    W.toast("Загрузка…");
    client.downloadMedia(m.raw, {}).then((buf) => {
      const nm = (m.file && m.file.n) || "file", blob = new Blob([buf]);
      if (W.Android && W.Android.saveFile) { // Sketchware WebView: blob-ссылки не скачиваются, шлём data URL
        const r = new FileReader(); r.onload = () => W.Android.saveFile(nm, r.result); r.readAsDataURL(blob); return;
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = nm;
      document.body.appendChild(a); a.click(); a.remove();
    }).catch(() => W.toast("Файл недоступен"));
  };

  W.logout = function () {
    if (!TGM) return O.logout();
    W.closeChat();
    client.invoke(new Api.auth.LogOut()).catch(() => {}).finally(() => {
      localStorage.removeItem(SKEY); location.reload();
    });
  };

  ["startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat"].forEach((n) => {
    W[n] = function () { return TGM ? NOPE() : O[n].apply(this, arguments); };
  });
}

/* ---------- автозапуск ---------- */
function boot() {
  patch();
  if (localStorage.getItem(SKEY)) {
    // есть сохранённая сессия Telegram – входим автоматически
    const t = setInterval(() => { if (typeof W.S === "object" && W.chat) { clearInterval(t); startTG(); } }, 50);
  }
}
boot();
