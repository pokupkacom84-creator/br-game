import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import { DeletedMessage } from "telegram/events/DeletedMessage";
import { getPeerId } from "telegram/Utils";

const API_ID = 37903917;
const API_HASH = "4e2c9b6a239fefd89a6749fde0f39aad";
const SKEY = "tgyou_mtproto_session";
const AKEY = "tgyou_ayu";
const W = window;

/* =====================================================================
   ПРОКСИ ДЛЯ ОБХОДА БЛОКИРОВОК
   Все WebSocket-подключения gramjs к *.web.telegram.org (путь /apiws)
   перенаправляются на ваш WebSocket-релей (см. relay-worker.js / relay-node.js).
   ===================================================================== */
const PKEY = "tgyou_proxy";
const getProxy = () => { try { return (localStorage.getItem(PKEY) || "").trim(); } catch (e) { return ""; } };
(function () {
  const NativeWS = W.WebSocket;
  if (!NativeWS || NativeWS.__tgProxy) return;
  function PWS(url, protocols) {
    const p = getProxy();
    try {
      const u = new URL(url);
      if (p && (/(^|\.)web\.telegram\.org$/.test(u.hostname) || /\/apiws$/.test(u.pathname))) {
        const b = new URL(p);
        b.searchParams.set("h", u.hostname);
        url = b.toString();
      }
    } catch (e) {}
    return protocols !== undefined ? new NativeWS(url, protocols) : new NativeWS(url);
  }
  PWS.prototype = NativeWS.prototype;
  ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach((k) => { PWS[k] = NativeWS[k]; });
  PWS.__tgProxy = true;
  W.WebSocket = PWS;
})();

let client = null;
let TGM = false; // режим Telegram включён
let TGME = null;
let MYID = "";
const ents = {}; // chatId -> InputPeer / entity
const photoQ = {};

const $ = (s) => document.querySelector(s);
const sid = (x) => (x == null ? "" : String(x));
const hue = (s) => { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toast = (t) => W.toast && W.toast(t);
const errTxt = (e) => (e && (e.errorMessage || e.message)) || String(e);

/* =====================================================================
   НАСТРОЙКИ AYU (режим призрака, сохранение удалённых/изменённых)
   ===================================================================== */
const AYU = { ghostRead: false, ghostTyping: false, ghostOnline: false, readOnSend: true, keepDeleted: true, keepEdits: true, keepMedia: true };
try { Object.assign(AYU, JSON.parse(localStorage.getItem(AKEY) || "{}")); } catch (e) {}
const saveAyu = () => { try { localStorage.setItem(AKEY, JSON.stringify(AYU)); } catch (e) {} };

/* =====================================================================
   КЭШ СООБЩЕНИЙ (IndexedDB) — нужен, чтобы помнить удалённое и правки
   ===================================================================== */
let idbP = null;
function idb() {
  if (idbP) return idbP;
  idbP = new Promise((res, rej) => {
    const r = indexedDB.open("tgyou_ayu", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      const m = d.createObjectStore("msgs", { keyPath: "k" });
      m.createIndex("chat", "chat"); m.createIndex("id", "id");
      d.createObjectStore("blobs", { keyPath: "k" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idbP;
}
const rq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const wq = (t) => new Promise((res) => { t.oncomplete = () => res(); t.onerror = () => res(); t.onabort = () => res(); });

const queue = new Map();
let queueT = null;
function qSave(rec) { queue.set(rec.k, rec); clearTimeout(queueT); queueT = setTimeout(flush, 800); }
async function flush() {
  clearTimeout(queueT);
  if (!queue.size) return;
  const arr = [...queue.values()]; queue.clear();
  try {
    const d = await idb(); const t = d.transaction("msgs", "readwrite"); const s = t.objectStore("msgs");
    arr.forEach((r) => s.put(r)); await wq(t);
  } catch (e) {}
}
async function idbChat(chatId) { try { await flush(); const d = await idb(); return await rq(d.transaction("msgs").objectStore("msgs").index("chat").getAll(chatId)); } catch (e) { return []; } }
async function idbById(id) { try { await flush(); const d = await idb(); return await rq(d.transaction("msgs").objectStore("msgs").index("id").getAll(id)); } catch (e) { return []; } }
async function idbAll() { try { await flush(); const d = await idb(); return await rq(d.transaction("msgs").objectStore("msgs").getAll()); } catch (e) { return []; } }
async function idbDel(k) { try { queue.delete(k); const d = await idb(); const t = d.transaction(["msgs", "blobs"], "readwrite"); t.objectStore("msgs").delete(k); t.objectStore("blobs").delete(k); await wq(t); } catch (e) {} }
async function idbPutBlob(k, blob) {
  if (!AYU.keepMedia || !blob || blob.size > 8 * 1024 * 1024) return;
  try { const d = await idb(); const t = d.transaction("blobs", "readwrite"); t.objectStore("blobs").put({ k, blob }); await wq(t); } catch (e) {}
}
async function idbGetBlob(k) { try { const d = await idb(); const r = await rq(d.transaction("blobs").objectStore("blobs").get(k)); return r && r.blob; } catch (e) { return null; } }

function recOf(c, m) {
  return {
    k: c.id + ":" + m.id, chat: c.id, ch: c.type, id: Number(m.id), text: m.text || "", t: m.t, out: !!m.out, from: m.from,
    edited: !!m.edited, editT: m.editT, edits: m.edits, fwd: m.fwd, reply: m.reply, voice: !!m.voice, dur: m.dur,
    photo: !!(m.img || m.photoPending), sticker: m.sticker, file: m.file, deleted: !!m.deleted, delT: m.delT,
  };
}
function cacheMsg(c, m) { if (m && m.id != null && !isNaN(Number(m.id))) qSave(recOf(c, m)); }
async function fromRec(r) {
  const m = {
    id: sid(r.id), tg: true, out: r.out, text: r.text, t: r.t, from: r.from, edited: r.edited, editT: r.editT, edits: r.edits,
    fwd: r.fwd, reply: r.reply, voice: r.voice || undefined, dur: r.dur, sticker: r.sticker, file: r.file,
    deleted: !!r.deleted, delT: r.delT, mediaDone: true,
  };
  if (r.photo || r.voice) {
    const b = await idbGetBlob(r.k);
    if (b) { const url = URL.createObjectURL(b); if (r.voice) m.audio = url; else m.img = url; }
    else if (r.photo && !m.text) m.text = "🖼 Фото (недоступно)";
  }
  return m;
}

/* =====================================================================
   ЭКРАН ВХОДА
   ===================================================================== */
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

/* =====================================================================
   КОНВЕРТАЦИЯ ДАННЫХ TELEGRAM -> формат приложения
   ===================================================================== */
function kindOf(d) {
  if (d.isUser) return d.entity && d.entity.bot ? "bot" : "user";
  if (d.isChannel && !d.isGroup) return "channel";
  return "group";
}

// форматирование Telegram (entities) -> разметка приложения: **жирный** __курсив__ `код`
function entMd(text, ents_) {
  if (!text || !ents_ || !ents_.length) return text || "";
  const ins = [];
  ents_.forEach((e) => {
    const n = e.className; let o = "", c = "";
    if (n === "MessageEntityBold") { o = c = "**"; }
    else if (n === "MessageEntityItalic") { o = c = "__"; }
    else if (n === "MessageEntityCode" || n === "MessageEntityPre") { o = c = "`"; }
    else if (n === "MessageEntityTextUrl" && e.url) { c = " (" + e.url + ")"; }
    else return;
    if (o) ins.push({ p: e.offset, s: o, k: 1 });
    ins.push({ p: e.offset + e.length, s: c, k: 0 });
  });
  ins.sort((a, b) => b.p - a.p || a.k - b.k);
  let out = text;
  ins.forEach((i) => { out = out.slice(0, i.p) + i.s + out.slice(i.p); });
  return out;
}

function convReact(m) {
  const r = {};
  const res = m.reactions && m.reactions.results;
  if (!res) return undefined;
  res.forEach((x, k) => {
    const emo = x.reaction && x.reaction.emoticon; if (!emo) return;
    const mine = x.chosenOrder != null;
    const n = Number(x.count) - (mine ? 1 : 0);
    for (let i = 0; i < n; i++) r["u" + k + "_" + i] = emo;
    if (mine) r.me = emo;
  });
  return r;
}

const ACT = {
  MessageActionChatAddUser: "добавлен(ы) участник(и)", MessageActionChatDeleteUser: "участник удалён",
  MessageActionChatJoinedByLink: "присоединился(-ась) по ссылке", MessageActionChatJoinedByRequest: "присоединился(-ась)",
  MessageActionChatEditTitle: "изменено название", MessageActionChatEditPhoto: "изменено фото", MessageActionChatDeletePhoto: "фото удалено",
  MessageActionPinMessage: "сообщение закреплено", MessageActionChatCreate: "группа создана", MessageActionChannelCreate: "канал создан",
  MessageActionContactSignUp: "присоединился(-ась) к Telegram", MessageActionHistoryClear: "история очищена", MessageActionPhoneCall: "📞 звонок",
};

function convMsg(m, c) {
  let fwd;
  if (m.fwdFrom) {
    try { fwd = (m.forward && ((m.forward.chat && m.forward.chat.title) || (m.forward.sender && m.forward.sender.firstName))) || m.fwdFrom.fromName || "пользователя"; }
    catch (e) { fwd = m.fwdFrom.fromName || "пользователя"; }
  }
  const o = {
    id: sid(m.id), tg: true, out: !!m.out,
    text: entMd(m.message || "", m.entities),
    t: (m.date || 0) * 1000,
    from: m.out ? "me" : (m.sender && (m.sender.firstName || m.sender.title)) || c.name,
    edited: !!m.editDate, editT: m.editDate ? m.editDate * 1000 : undefined,
    reply: m.replyTo && m.replyTo.replyToMsgId ? sid(m.replyTo.replyToMsgId) : undefined,
    fwd, raw: m, react: convReact(m),
    read: !!(m.out && c.readOut && Number(m.id) <= c.readOut),
  };
  try {
    if (m.action) { o.text = "ℹ️ " + (ACT[m.action.className] || "служебное сообщение"); o.service = true; }
    else if (m.voice) { o.voice = true; o.dur = (m.voice.attributes.find((a) => a.duration) || {}).duration || 1; }
    else if (m.photo) o.photoPending = true;
    else if (m.sticker) o.sticker = (m.sticker.attributes.find((a) => a.alt) || {}).alt || "🖼";
    else if (m.media && (m.document || m.video || m.audio)) {
      const d = m.document;
      const nm = (d && d.attributes.find((a) => a.fileName) || {}).fileName || (m.videoNote ? "кружок.mp4" : "файл");
      o.file = { k: "f", n: nm, s: d ? Number(d.size) : 0 };
      o.mid = "tg" + m.id;
    } else if (m.media && !o.text) {
      const k = m.media.className;
      if (k === "MessageMediaGeo" || k === "MessageMediaGeoLive") o.text = "📍 https://maps.google.com/?q=" + m.media.geo.lat + "," + m.media.geo.long;
      else if (k === "MessageMediaPoll") { const q = m.media.poll.question; o.text = "📊 " + (typeof q === "string" ? q : q.text); }
      else if (k === "MessageMediaContact") o.text = "👤 " + [m.media.firstName, m.media.lastName].filter(Boolean).join(" ") + " " + (m.media.phoneNumber || "");
      else if (k === "MessageMediaDice") o.text = (m.media.emoticon || "🎲") + " " + m.media.value;
    }
  } catch (e) {}
  return o;
}

function statusOf(ent) {
  const s = ent && ent.status; if (!s) return {};
  const n = s.className;
  if (n === "UserStatusOnline") return { online: true };
  if (n === "UserStatusOffline") return { seen: "t", seenT: s.wasOnline * 1000 };
  if (n === "UserStatusRecently") return { seen: "recent" };
  if (n === "UserStatusLastWeek") return { seen: "week" };
  if (n === "UserStatusLastMonth") return { seen: "month" };
  return { seen: "long" };
}

function mkChat(d) {
  const id = sid(d.id);
  ents[id] = d.inputEntity || d.entity;
  const dl = d.dialog || {};
  const mute = dl.notifySettings && dl.notifySettings.muteUntil;
  const self = id === MYID;
  const c = {
    id, tg: true, type: self ? "saved" : kindOf(d), name: self ? "Избранное" : (d.name || "Без имени"), hue: hue(id),
    peer: id, pinned: !!d.pinned, muted: !!(mute && mute > Date.now() / 1000),
    unread: d.unreadCount || 0, online: false, typing: false, msgs: [], reads: {}, ready: true, refs: [],
    members: (d.entity && d.entity.participantsCount) || 0, u: {}, uname: d.entity && d.entity.username,
    readOut: Number(dl.readOutboxMaxId) || 0,
  };
  c._pp = c.pinned; c._pm = c.muted;
  Object.assign(c, statusOf(d.entity));
  if (d.message) c.msgs.push(convMsg(d.message, c));
  return c;
}

function mkChatEnt(e) {
  const id = sid(getPeerId(e));
  ents[id] = e;
  const user = e.className === "User";
  const c = {
    id, tg: true, type: user ? (e.bot ? "bot" : "user") : (e.className === "Channel" && e.broadcast ? "channel" : "group"),
    name: user ? ([e.firstName, e.lastName].filter(Boolean).join(" ") || e.username || "Без имени") : (e.title || "Без имени"),
    hue: hue(id), peer: id, pinned: false, muted: false, unread: 0, online: false, typing: false, msgs: [], reads: {}, ready: true, refs: [],
    members: e.participantsCount || 0, u: {}, uname: e.username, readOut: 0,
  };
  c._pp = false; c._pm = false;
  Object.assign(c, statusOf(e));
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
  const ds = await client.getDialogs({ limit: 200 });
  W.S.chats = ds.filter((d) => !d.archived).map(mkChat);
  W.softMain();
  const list = W.S.chats.slice();
  for (const c of list.slice(0, 30)) loadAvatar(c);
  (async () => { for (const c of list.slice(30)) { await loadAvatar(c); await new Promise((r) => setTimeout(r, 120)); } })();
}

/* ---------- история: загрузка, слияние с кэшем (удалённые), подгрузка вверх ---------- */
async function mergeCache(c, fetched, lo) {
  const have = new Set(c.msgs.map((x) => x.id)); fetched.forEach((x) => have.add(x.id));
  const byId = {}; fetched.forEach((x) => { byId[x.id] = x; });
  const rows = await idbChat(c.id), extra = [];
  for (const r of rows) {
    const rid = sid(r.id);
    if (have.has(rid)) {
      const x = byId[rid];
      if (x && AYU.keepEdits) {
        if (r.edits && r.edits.length) x.edits = r.edits;
        if (x.edited && r.text && r.text !== x.text) x.edits = (x.edits || []).concat([{ t: r.editT || r.t, text: r.text }]);
      }
      continue;
    }
    if (r.deleted) { if (AYU.keepDeleted) extra.push(await fromRec(r)); continue; }
    if (AYU.keepDeleted && r.id >= lo) { r.deleted = true; r.delT = Date.now(); qSave(r); extra.push(await fromRec(r)); }
  }
  return extra;
}
const byTime = (a, b) => a.t - b.t || Number(a.id) - Number(b.id);

async function loadHistory(c) {
  if (c.hist) return;
  c.hist = true;
  const list = await client.getMessages(ents[c.id], { limit: 60 });
  const fetched = list.reverse().map((m) => convMsg(m, c));
  const lo = fetched.length ? Math.min(...fetched.map((x) => Number(x.id))) : 0;
  const extra = await mergeCache(c, fetched, lo);
  c.msgs = fetched.concat(extra).sort(byTime);
  fetched.forEach((m) => cacheMsg(c, m));
  if (list.length < 60) c.noMore = true;
  W.renderMsgs && W.S.open === c.id && W.renderMsgs();
  W.softMain();
  fetchMedia(c);
  client.getMessages(ents[c.id], { filter: new Api.InputMessagesFilterPinned(), limit: 1 }).then((l) => {
    if (l && l[0]) { c.pin = sid(l[0].id); if (W.S.open === c.id) W.renderMsgs(1); }
  }).catch(() => {});
}

async function loadOlder(c) {
  if (c.loadingOld || c.noMore || !c.hist) return;
  const real = c.msgs.filter((x) => !x.deleted && !isNaN(Number(x.id)));
  if (!real.length) return;
  c.loadingOld = true;
  try {
    const minId = Math.min(...real.map((x) => Number(x.id)));
    const list = await client.getMessages(ents[c.id], { limit: 50, offsetId: minId });
    if (!list.length) { c.noMore = true; return; }
    const fetched = list.reverse().map((m) => convMsg(m, c));
    const lo = Math.min(...fetched.map((x) => Number(x.id)));
    const extra = await mergeCache(c, fetched, lo);
    fetched.forEach((m) => cacheMsg(c, m));
    c.msgs = fetched.concat(extra, c.msgs).sort(byTime);
    if (list.length < 50) c.noMore = true;
    if (W.S.open === c.id) {
      const el = $("#msgs"), h0 = el.scrollHeight, t0 = el.scrollTop;
      W.renderMsgs(1);
      el.scrollTop = t0 + (el.scrollHeight - h0);
      fetchMedia(c);
    }
  } catch (e) {} finally { c.loadingOld = false; }
}

async function fetchMedia(c) {
  for (const m of c.msgs) {
    if (!m.raw || m.mediaDone) continue;
    if (m.photoPending || m.voice) {
      m.mediaDone = true;
      try {
        const buf = await client.downloadMedia(m.raw, {});
        if (buf) {
          const blob = new Blob([buf], { type: m.voice ? "audio/ogg" : "image/jpeg" });
          const url = URL.createObjectURL(blob);
          if (m.voice) m.audio = url; else { m.img = url; m.photoPending = false; }
          idbPutBlob(c.id + ":" + m.id, blob); cacheMsg(c, m);
          if (W.S.open === c.id) W.renderMsgs(1);
        }
      } catch (e) {}
    }
  }
}

/* =====================================================================
   ЗАПУСК
   ===================================================================== */
async function startTG() {
  TGM = true;
  try { await connect(); } catch (e) { TGM = false; W.showLogin("auth"); W.aerr && W.aerr({ message: String(e.message || e) }); return; }
  const me = await client.getMe();
  MYID = sid(me.id);
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Я";
  W.ME = { uid: "me", name, email: me.phone ? "+" + me.phone : "" };
  TGME = W.ME;
  W.S.name = name;
  W.S.phone = W.ME.email;
  W.S.me = { name, username: me.username || "", bio: "", priv: {}, blocked: {} };
  W.S.cover = null; W.S.tab = "chats"; W.S.open = null; W.S.chats = [];
  W.S.admin = false;
  $("#login").style.display = "none";
  injectCss();
  W.renderMain();
  client.downloadProfilePhoto("me", { isBig: false }).then((b) => {
    if (b && b.length) { W.S.me.avatar = "data:image/jpeg;base64," + btoa(String.fromCharCode(...new Uint8Array(b))); W.refreshMe(); }
  }).catch(() => {});
  client.invoke(new Api.users.GetFullUser({ id: new Api.InputUserSelf() })).then((r) => { W.S.me.bio = (r.fullUser && r.fullUser.about) || ""; }).catch(() => {});
  client.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 200 })).then((r) => {
    (r.blocked || []).forEach((b) => { W.S.me.blocked[sid(getPeerId(b.peerId))] = true; });
  }).catch(() => {});
  await loadDialogs();
  hookEvents();
  setInterval(() => { if (AYU.ghostOnline) setOffline(); }, 15000);
  if (AYU.ghostOnline) setOffline();
  W.toast("Подключено к Telegram");
}

function setOffline() { client && client.invoke(new Api.account.UpdateStatus({ offline: true })).catch(() => {}); }

/* =====================================================================
   СОБЫТИЯ В РЕАЛЬНОМ ВРЕМЕНИ
   ===================================================================== */
function chatOf(ev) {
  const id = sid(ev.chatId || (ev.message && ev.message.chatId));
  return W.S.chats.find((c) => c.id === id);
}
const chatById = (id) => W.S.chats.find((c) => c.id === id);

async function onDeleted(ev) {
  const ids = (ev.deletedIds || []).map(sid);
  const chId = ev.chatId != null ? sid(ev.chatId) : null;
  const match = (c) => (chId ? c.id === chId : c.type !== "channel");
  if (!AYU.keepDeleted) {
    W.S.chats.forEach((c) => {
      if (!match(c)) return;
      const n = c.msgs.length;
      c.msgs = c.msgs.filter((x) => ids.indexOf(x.id) < 0);
      if (n !== c.msgs.length && W.S.open === c.id) W.renderMsgs(1);
    });
    ids.forEach(async (id) => { (await idbById(Number(id))).forEach((r) => { if (chId ? r.chat === chId : r.ch !== "channel") idbDel(r.k); }); });
    W.softMain();
    return;
  }
  const now = Date.now();
  W.S.chats.forEach((c) => {
    if (!match(c)) return;
    let ch = false;
    c.msgs.forEach((m) => { if (ids.indexOf(m.id) >= 0 && !m.deleted) { m.deleted = true; m.delT = now; cacheMsg(c, m); ch = true; } });
    if (ch && W.S.open === c.id) W.renderMsgs(1);
  });
  for (const id of ids) {
    for (const r of await idbById(Number(id))) {
      if ((chId ? r.chat === chId : r.ch !== "channel") && !r.deleted) { r.deleted = true; r.delT = now; qSave(r); }
    }
  }
  W.softMain();
}

function hookEvents() {
  client.addEventHandler(async (ev) => {
    let c = chatOf(ev);
    const m = ev.message;
    if (!c) { await loadDialogs(); c = chatOf(ev); if (!c) return; }
    const cm = convMsg(m, c);
    if (c.hist) { if (!c.msgs.some((x) => x.id === cm.id)) c.msgs.push(cm); } else c.msgs = [cm];
    cacheMsg(c, cm);
    if (!m.out) {
      if (W.S.open === c.id && !AYU.ghostRead) markRead(c);
      else {
        c.unread++;
        if (W.S.open !== c.id && W.S.notif && !c.muted) W.toast(c.name + ": " + (m.message || "медиа").split("\n")[0]);
      }
    }
    if (W.S.open === c.id) { W.renderMsgs(1); fetchMedia(c); if (m.out) W.scrollEnd(); }
    W.softMain();
  }, new NewMessage({}));

  client.addEventHandler((ev) => {
    const c = chatOf(ev); if (!c) return;
    const m = ev.message, i = c.msgs.findIndex((x) => x.id === sid(m.id));
    if (i < 0) return;
    const old = c.msgs[i], nw = convMsg(m, c);
    nw.edits = old.edits;
    if (AYU.keepEdits && old.text !== nw.text && old.text) nw.edits = (old.edits || []).concat([{ t: old.editT || old.t, text: old.text }]);
    ["img", "audio", "mediaDone"].forEach((k) => { if (old[k] !== undefined && (old.img || old.audio)) nw[k] = old[k]; });
    if (nw.img) nw.photoPending = false;
    c.msgs[i] = nw; cacheMsg(c, nw);
    if (W.S.open === c.id) W.renderMsgs(1);
    W.softMain();
  }, new EditedMessage({}));

  client.addEventHandler(onDeleted, new DeletedMessage({}));

  // остальные «сырые» обновления: печатает, статус, реакции, прочтение, закреп
  client.addEventHandler((u) => {
    try {
      const n = u.className;
      if (n === "UpdateUserTyping" || n === "UpdateChatUserTyping" || n === "UpdateChannelUserTyping") {
        const id = n === "UpdateUserTyping" ? sid(u.userId)
          : sid(getPeerId(n === "UpdateChatUserTyping" ? new Api.PeerChat({ chatId: u.chatId }) : new Api.PeerChannel({ channelId: u.channelId })));
        const c = chatById(id);
        if (c) {
          const stop = u.action && u.action.className === "SendMessageCancelAction";
          c.typing = !stop; W.softMain(); if (W.S.open === c.id) W.renderChatHdr();
          clearTimeout(c._tt);
          c._tt = setTimeout(() => { c.typing = false; W.softMain(); if (W.S.open === c.id) W.renderChatHdr(); }, 5000);
        }
      } else if (n === "UpdateUserStatus") {
        const c = chatById(sid(u.userId));
        if (c) { c.online = false; c.seen = undefined; Object.assign(c, statusOf({ status: u.status })); W.softMain(); if (W.S.open === c.id) W.renderChatHdr(); }
      } else if (n === "UpdateMessageReactions") {
        const c = chatById(sid(getPeerId(u.peer))); if (!c) return;
        const m = c.msgs.find((x) => x.id === sid(u.msgId));
        if (m) { m.react = convReact({ reactions: u.reactions }); if (W.S.open === c.id) W.renderMsgs(1); }
      } else if (n === "UpdateReadHistoryOutbox" || n === "UpdateReadChannelOutbox") {
        const c = chatById(n === "UpdateReadHistoryOutbox" ? sid(getPeerId(u.peer)) : sid(getPeerId(new Api.PeerChannel({ channelId: u.channelId }))));
        if (c) { c.readOut = Number(u.maxId); c.msgs.forEach((m) => { if (m.out && Number(m.id) <= c.readOut) m.read = true; }); if (W.S.open === c.id) W.renderMsgs(1); W.softMain(); }
      } else if (n === "UpdateReadHistoryInbox" || n === "UpdateReadChannelInbox") {
        const c = chatById(n === "UpdateReadHistoryInbox" ? sid(getPeerId(u.peer)) : sid(getPeerId(new Api.PeerChannel({ channelId: u.channelId }))));
        if (c) { c.unread = u.stillUnreadCount || 0; W.softMain(); }
      } else if (n === "UpdatePinnedMessages" || n === "UpdatePinnedChannelMessages") {
        const c = chatById(n === "UpdatePinnedMessages" ? sid(getPeerId(u.peer)) : sid(getPeerId(new Api.PeerChannel({ channelId: u.channelId }))));
        if (c && c.hist) client.getMessages(ents[c.id], { filter: new Api.InputMessagesFilterPinned(), limit: 1 }).then((l) => { c.pin = l && l[0] ? sid(l[0].id) : null; if (W.S.open === c.id) W.renderMsgs(1); }).catch(() => {});
      }
    } catch (e) {}
  });
}

/* =====================================================================
   ДЕЙСТВИЯ
   ===================================================================== */
function markRead(c) {
  if (AYU.ghostRead) return; // режим призрака: не отправляем «прочитано»
  c.unread = 0;
  client.markAsRead(ents[c.id]).catch(() => {});
}

function afterSend(c) {
  if (AYU.ghostOnline) setTimeout(setOffline, 400);
  if (AYU.ghostRead && AYU.readOnSend) { c.unread = 0; client.markAsRead(ents[c.id]).catch(() => {}); W.softMain(); }
}

function dataToBuf(d) {
  const b = atob(d.split(",")[1]), a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}
const mimeOf = (d) => (/^data:([^;,]+)/.exec(d || "") || [])[1] || "";

async function send(c, o) {
  const ent = ents[c.id];
  const replyTo = o.reply ? Number(o.reply) : undefined;
  try {
    if (o.img) {
      const f = new File([dataToBuf(o.img)], "photo.jpg", { type: "image/jpeg" });
      await client.sendFile(ent, { file: f, forceDocument: false, replyTo });
    } else if (o.voice && o.audio) {
      const mt = mimeOf(o.audio) || "audio/ogg";
      const f = new File([dataToBuf(o.audio)], "voice." + (/ogg/.test(mt) ? "ogg" : /mp4/.test(mt) ? "m4a" : "webm"), { type: mt });
      await client.sendFile(ent, { file: f, voiceNote: true, attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: o.dur || 1 })], replyTo });
    } else {
      await client.sendMessage(ent, { message: o.text || o.sticker || "", replyTo, silent: !!o.silent, parseMode: "md" });
    }
    afterSend(c);
  } catch (e) { W.toast("Ошибка отправки: " + errTxt(e)); }
}

const NOPE = () => W.toast("Звонки через MTProto в браузере недоступны");

async function openEntity(e) {
  const id = sid(getPeerId(e));
  let c = chatById(id);
  if (!c) { c = mkChatEnt(e); W.S.chats.push(c); loadAvatar(c); }
  W.S.tab = "chats"; W.renderMain(); W.openChat(id);
}
async function openByQuery(v) {
  v = String(v || "").trim().replace(/^https?:\/\/t\.me\//i, "").replace(/^@/, "").split("/")[0].split("?")[0];
  if (!v) return;
  try { openEntity(await client.getEntity(/^\d{7,}$/.test(v) ? "+" + v : v)); }
  catch (e) { toast("Не найдено: " + errTxt(e)); }
}

async function leaveOrDelete(c) {
  const ent = ents[c.id], cn = ent && ent.className;
  try {
    if (cn === "InputPeerChannel") await client.invoke(new Api.channels.LeaveChannel({ channel: new Api.InputChannel({ channelId: ent.channelId, accessHash: ent.accessHash }) }));
    else if (cn === "InputPeerChat") {
      await client.invoke(new Api.messages.DeleteChatUser({ chatId: ent.chatId, userId: new Api.InputUserSelf() }));
      await client.invoke(new Api.messages.DeleteHistory({ peer: ent, maxId: 0, revoke: false }));
    } else await client.invoke(new Api.messages.DeleteHistory({ peer: ent, maxId: 0, revoke: false }));
    W.S.chats = W.S.chats.filter((x) => x.id !== c.id);
  } catch (e) { toast(errTxt(e)); }
}

/* ---------- профиль ---------- */
async function tgProfile(id) {
  const me = id === "me" || id === MYID;
  const c = me ? null : W.S.chats.find((x) => x.id === id || x.peer === id);
  W.PG = "tg:" + id; // чтобы Firebase-версия профиля не перерисовывала страницу
  const name = me ? W.S.name : (c ? c.name : "Профиль");
  const photo = me ? W.S.me.avatar : (c && c.photo);
  const ic = W.ic, R = W.R;
  const status = me ? "в сети" : c ? W.statusText(c) : "";
  const rows = (about) => {
    let h = "";
    if (me) h += R(ic("person"), esc(name), "Имя", "AYU_editName()");
    const un = me ? W.S.me.username : (c && c.uname);
    if (un || me) h += R("@", un ? esc(un) : "Не задано", "Имя пользователя", me ? "AYU_editUser()" : "");
    if (me && W.S.phone) h += R(ic("call"), esc(W.S.phone), "Телефон");
    if (about || me) h += R(ic("info"), about ? esc(about) : "Не задано", c && c.type !== "user" && c.type !== "bot" ? "Описание" : "О себе", me ? "AYU_editBio()" : "");
    h += R(ic("person"), esc(me ? MYID : id), "ID");
    return h;
  };
  W.page(esc(name), '<div class="pcov"></div><div class="pav"><div class="av xl" style="--h:' + hue(id) + (photo ? ";background-image:url(" + photo + ")" : "") + '">' + (photo ? "" : esc(W.initials(name))) + '</div></div><div class="pn"><b>' + esc(name) + "</b><span>" + status + '</span></div><div class="card" id="pfc">' + rows(me ? W.S.me.bio : "") + "</div>");
  try {
    let about = "";
    const ent = me ? new Api.InputUserSelf() : ents[c.id], cn = ent && ent.className;
    if (me || cn === "InputPeerUser") about = (await client.invoke(new Api.users.GetFullUser({ id: ent }))).fullUser.about;
    else if (cn === "InputPeerChannel") about = (await client.invoke(new Api.channels.GetFullChannel({ channel: ent }))).fullChat.about;
    else if (cn === "InputPeerChat") about = (await client.invoke(new Api.messages.GetFullChat({ chatId: ent.chatId }))).fullChat.about;
    if (me) W.S.me.bio = about || "";
    const el = $("#pfc"); if (el && W.PG === "tg:" + id) el.innerHTML = rows(about);
  } catch (e) {}
}
W.AYU_editName = () => {
  W.dialog.ph = "Имя"; W.dialog.ml = 30;
  W.dialog("Ваше имя", "", W.S.name, "Сохранить", (n) => {
    const p = n.split(/\s+/); 
    client.invoke(new Api.account.UpdateProfile({ firstName: p[0], lastName: p.slice(1).join(" ") })).then(() => { W.S.name = n; W.S.me.name = n; W.closePage(); tgProfile("me"); }).catch((e) => toast(errTxt(e)));
  });
};
W.AYU_editBio = () => {
  W.dialog.ph = "О себе"; W.dialog.ml = 70; W.dialog.opt = 1;
  W.dialog("О себе", "Напишите о себе пару слов", W.S.me.bio || "", "Сохранить", (v) => {
    client.invoke(new Api.account.UpdateProfile({ about: v || "" })).then(() => { W.S.me.bio = v || ""; W.closePage(); tgProfile("me"); }).catch((e) => toast(errTxt(e)));
  });
};
W.AYU_editUser = () => {
  W.dialog.ph = "username"; W.dialog.ml = 32; W.dialog.opt = 1;
  W.dialog("Имя пользователя", "a–z, 0–9 и _, от 5 символов", W.S.me.username || "", "Сохранить", (v) => {
    client.invoke(new Api.account.UpdateUsername({ username: (v || "").replace(/^@/, "") })).then(() => { W.S.me.username = (v || "").replace(/^@/, ""); W.closePage(); tgProfile("me"); }).catch((e) => toast(errTxt(e)));
  });
};

/* ---------- AyuGram: настройки, история правок, журнал удалённых ---------- */
function injectCss() {
  if ($("#ayucss")) return;
  const s = document.createElement("style"); s.id = "ayucss";
  s.textContent = ".m.deleted{opacity:.8;outline:1.5px dashed #d93025;outline-offset:-1.5px}.m .mt .ayud{color:#d93025;margin-right:4px}.m .mt .ayue{text-decoration:underline dotted}";
  document.head.appendChild(s);
}
const SWROW = (k, ico, t, sub) => '<div class="row" style="padding:4px 0" onclick="AYU_t(\'' + k + '\')"><div class="ico">' + W.ic(ico) + '</div><div class="t">' + t + "<small>" + sub + '</small></div><div class="sw' + (AYU[k] ? " on" : "") + '"></div></div>';
function ayuCard() {
  const ghost = AYU.ghostRead && AYU.ghostTyping && AYU.ghostOnline;
  return '<div class="card"><div class="row" style="padding:0 0 4px"><div class="ico">' + W.ic("shield") + '</div><div class="t">AyuGram<small>Приватность и сохранение истории</small></div></div>' +
    '<div class="row" style="padding:4px 0" onclick="AYU_ghost()"><div class="ico">' + W.ic("moon") + '</div><div class="t">Режим призрака<small>Всё ниже одним переключателем</small></div><div class="sw' + (ghost ? " on" : "") + '"></div></div>' +
    SWROW("ghostRead", "done", "Не отмечать прочитанным", "Собеседник не увидит, что вы прочли") +
    SWROW("ghostTyping", "edit", "Не показывать «печатает»", "Скрыть набор текста") +
    SWROW("ghostOnline", "mute", "Скрыть «в сети»", "Принудительно отправлять статус «офлайн»") +
    SWROW("readOnSend", "check", "Читать при отправке", "С режимом призрака: прочитать чат, когда вы пишете сами") +
    SWROW("keepDeleted", "del", "Сохранять удалённые", "Удалённые собеседником сообщения остаются с пометкой") +
    SWROW("keepEdits", "edit", "История изменений", "Хранить прежние версии отредактированных сообщений") +
    SWROW("keepMedia", "image", "Сохранять медиа", "Кэшировать фото и голосовые для удалённых сообщений") +
    '<div class="row" style="padding:4px 0" onclick="AYU_proxy()"><div class="ico">' + W.ic("lock") + '</div><div class="t">Прокси<small>' + (getProxy() ? esc(getProxy()) : "Не настроен — обход блокировок") + '</small></div></div>' +
    '<div class="row" style="padding:4px 0" onclick="AYU_log()"><div class="ico">' + W.ic("file") + '</div><div class="t">Журнал удалённых<small>Все сохранённые удалённые сообщения</small></div></div></div>';
}
W.AYU_proxy = () => {
  W.dialog.ph = "wss://relay.example.com/"; W.dialog.ml = 200; W.dialog.opt = 1;
  W.dialog("Прокси (WebSocket-релей)", "Адрес вашего релея вида wss://… Пустое поле — без прокси. Приложение перезагрузится.", getProxy(), "Сохранить", (v) => {
    v = (v || "").trim();
    if (v && !/^wss?:\/\//i.test(v)) return toast("Адрес должен начинаться с wss://");
    try { if (v) localStorage.setItem(PKEY, v); else localStorage.removeItem(PKEY); } catch (e) {}
    location.reload();
  });
};
W.AYU_t = (k) => {
  AYU[k] = !AYU[k]; saveAyu();
  if (k === "ghostOnline" && AYU[k]) setOffline();
  if (k === "keepDeleted" || k === "keepEdits") W.renderMsgs && W.S.open && W.renderMsgs(1);
  W.renderSettings();
};
W.AYU_ghost = () => {
  const on = !(AYU.ghostRead && AYU.ghostTyping && AYU.ghostOnline);
  AYU.ghostRead = AYU.ghostTyping = AYU.ghostOnline = on; saveAyu();
  if (on) setOffline();
  W.renderSettings(); toast(on ? "Режим призрака включён" : "Режим призрака выключен");
};
W.AYU_hist = (mid) => {
  const m = W.findMsg(mid); if (!m || !m.edits) return;
  const fm = (t) => new Date(t).toLocaleString(W.LOC ? W.LOC() : "ru");
  W.sheet('<div class="sec" style="padding:4px 12px">История изменений</div>' + m.edits.slice().reverse().map((e) => '<div class="si" style="display:block;height:auto;padding:10px 16px"><small style="opacity:.7">' + fm(e.t) + "</small><div>" + esc(e.text) + "</div></div>").join("") +
    '<div class="si" style="display:block;height:auto;padding:10px 16px"><small style="opacity:.7">Сейчас</small><div>' + esc(m.text) + "</div></div>");
};
W.AYU_forget = (mid) => {
  W.closeAll();
  const c = W.chat(W.S.open); if (!c) return;
  c.msgs = c.msgs.filter((x) => x.id !== mid); idbDel(c.id + ":" + mid);
  W.renderMsgs(1); W.softMain();
};
W.AYU_log = async () => {
  W.page("Удалённые сообщения", '<div class="empty">Загрузка…</div>');
  const rows = (await idbAll()).filter((r) => r.deleted).sort((a, b) => (b.delT || 0) - (a.delT || 0)).slice(0, 150);
  const R = W.R;
  W.page("Удалённые сообщения", (rows.length ? rows.map((r) => {
    const c = chatById(r.chat);
    const txt = r.text || (r.photo ? "🖼 Фото" : r.voice ? "🎤 Голосовое" : r.file ? "📎 " + r.file.n : r.sticker || "(без текста)");
    return R(W.ic("del"), esc(txt).slice(0, 300), esc((c ? c.name : "Чат " + r.chat) + " · " + W.hm(r.t) + (r.delT ? " · удалено " + new Date(r.delT).toLocaleDateString() : "")));
  }).join("") : '<div class="empty"><b>Пусто</b><p>Здесь появятся сообщения, которые удалили собеседники</p></div>') +
    (rows.length ? '<div class="card"><div class="row" style="padding:4px 0" onclick="AYU_clearLog()"><div class="ico">' + W.ic("del") + '</div><div class="t">Очистить журнал</div></div></div>' : ""));
};
W.AYU_clearLog = async () => {
  for (const r of (await idbAll()).filter((x) => x.deleted)) await idbDel(r.k);
  W.S.chats.forEach((c) => { c.msgs = c.msgs.filter((m) => !m.deleted); });
  W.AYU_log(); W.softMain(); if (W.S.open) W.renderMsgs(1);
};

function decorate() {
  if (!TGM) return;
  const c = W.chat(W.S.open); if (!c) return;
  document.querySelectorAll("#msgs .m[data-mid]").forEach((el) => {
    const m = c.msgs.find((x) => x.id === el.dataset.mid); if (!m) return;
    const mt = el.querySelector(".mt"); if (!mt) return;
    if (m.deleted && !el.classList.contains("deleted")) {
      el.classList.add("deleted");
      mt.insertAdjacentHTML("afterbegin", '<span class="ayud">🗑 удалено</span>');
    }
    if (m.edits && m.edits.length && !mt.dataset.ey) {
      mt.dataset.ey = 1; mt.classList.add("ayue");
    }
  });
}

/* =====================================================================
   ПОДМЕНА ФУНКЦИЙ ПРИЛОЖЕНИЯ
   ===================================================================== */
function patch() {
  const O = {};
  ["hideBan", "showLogin", "openChat", "pushMsg", "pushTo", "sbClick", "markRead", "doDel", "logout", "getMedia", "react", "pinMsg",
    "setTyping", "typingPing", "startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat", "persist", "selDel", "selRead",
    "statusText", "doFwd", "openProfile", "sendBlob", "sendFile", "mention", "moreCards", "renderMsgs", "msgMenu2", "iBlock"].forEach((n) => { O[n] = W[n]; });

  W.showLogin = function (step, mode) {
    if (TGM) return; // Firebase не должен перекрывать вход через Telegram
    O.showLogin(step, mode);
    if (step === "auth" && !TGM) {
      const el = $("#login .auth"); if (!el) return;
      const b = document.createElement("button");
      b.className = "tb f aw"; b.style.marginTop = "12px"; b.textContent = "Войти через Telegram";
      b.onclick = startTG;
      el.insertBefore(b, el.querySelector("#aerr"));
      const pb = document.createElement("button");
      pb.className = "tb"; pb.style.marginTop = "6px";
      pb.textContent = getProxy() ? "Прокси: включён" : "Настроить прокси";
      pb.onclick = () => W.AYU_proxy();
      el.insertBefore(pb, el.querySelector("#aerr"));
    }
  };

  // Firebase при отсутствии своего пользователя сбрасывает ME=null и зовёт hideBan() – возвращаем нашего
  W.hideBan = function () { if (TGM && TGME) W.ME = TGME; return O.hideBan.apply(this, arguments); };

  W.openChat = function (id) {
    if (TGM && id === "c0") id = MYID; // «Избранное»
    const c0 = W.chat(id), u0 = c0 && c0.unread;
    O.openChat(id);
    const c = W.chat(id);
    if (TGM && c && c.tg) {
      if (AYU.ghostRead && u0) { c.unread = u0; W.softMain(); } // призрак: счётчик не сбрасываем
      loadHistory(c).then(() => fetchMedia(c));
      const chn = $("#chn");
      if (chn && c.type === "channel") chn.onclick = () => { c.muted = !c.muted; W.persist(c); W.openChat(id); };
      const el = $("#msgs");
      if (el && !el._ayu) { el._ayu = 1; el.addEventListener("scroll", () => { if (el.scrollTop < 150) { const cc = W.chat(W.S.open); if (cc && cc.tg) loadOlder(cc); } }, { passive: true }); }
    }
  };

  W.renderMsgs = function () { const r = O.renderMsgs.apply(this, arguments); decorate(); return r; };

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
      if (v) client.editMessage(ents[c.id], { message: id, text: v, parseMode: "md" }).catch((e) => W.toast(errTxt(e) || "Ошибка"));
      W.S.edit = null; ta.value = ""; W.renderReply(); W.onType(); return;
    }
    return O.sbClick();
  };

  W.doDel = function (all) {
    if (!TGM) return O.doDel(all);
    const c = W.chat(W.S.open), ids = W.S.delIds.slice();
    client.deleteMessages(ents[c.id], ids.map(Number), { revoke: !!all })
      .then(() => { c.msgs = c.msgs.filter((m) => ids.indexOf(m.id) < 0); ids.forEach((i) => idbDel(c.id + ":" + i)); W.renderMsgs(1); W.softMain(); })
      .catch((e) => W.toast(errTxt(e)));
    W.clrMsel(); W.toast("Удалено");
  };

  W.doFwd = function (cid) {
    if (!TGM) return O.doFwd(cid);
    W.closeAll();
    const src = W.chat(W.S.open), to = W.chat(cid);
    const ids = W.S.fwdIds.filter((i) => { const m = W.findMsg(i); return m && !m.deleted; }).map(Number);
    if (!ids.length) { W.clrMsel(); return toast("Нечего пересылать"); }
    client.forwardMessages(ents[to.id], { messages: ids, fromPeer: ents[src.id] }).then(() => toast("Переслано")).catch((e) => toast(errTxt(e)));
    W.clrMsel();
  };

  W.react = function (mid, e) {
    if (!TGM) return O.react(mid, e);
    const c = W.chat(W.S.open), m = W.findMsg(mid); if (!m) return;
    const mine = m.react && m.react.me === e;
    client.invoke(new Api.messages.SendReaction({ peer: ents[c.id], msgId: Number(mid), reaction: mine ? [] : [new Api.ReactionEmoji({ emoticon: e })] })).catch(() => {});
    m.react = m.react || {};
    if (mine) delete m.react.me; else m.react.me = e;
    W.renderMsgs(1);
  };

  W.pinMsg = function (mid) {
    if (!TGM) return O.pinMsg(mid);
    const c = W.chat(W.S.open);
    if (c.pin === mid) client.unpinMessage(ents[c.id], Number(mid)).then(() => { c.pin = null; W.renderMsgs(1); W.toast("Откреплено"); }).catch(() => W.toast("Не удалось открепить"));
    else client.pinMessage(ents[c.id], Number(mid)).then(() => { c.pin = mid; W.renderMsgs(1); W.toast("Закреплено"); }).catch(() => W.toast("Не удалось закрепить"));
  };

  const typingAct = () => {
    if (AYU.ghostTyping) return; // призрак: «печатает…» не отправляем
    const c = W.chat(W.S.open); if (!c) return;
    client.invoke(new Api.messages.SetTyping({ peer: ents[c.id], action: new Api.SendMessageTypingAction() })).catch(() => {});
  };
  W.setTyping = function (v) { if (!TGM) return O.setTyping(v); W.tyOn = v; };
  W.typingPing = function () { if (!TGM) return O.typingPing(); if (!W.typingPing.t || Date.now() - W.typingPing.t > 4000) { W.typingPing.t = Date.now(); typingAct(); } };

  W.getMedia = function (id, quiet) {
    if (!TGM) return O.getMedia(id, quiet);
    const m = W.findMsg(id); if (!m || !m.raw) return W.toast("Файл недоступен");
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

  // файлы, видео, GIF — без лимита в 5 МБ и без Firebase
  W.sendBlob = function (b, name, k) {
    if (!TGM) return O.sendBlob(b, name, k);
    const c = W.chat(W.S.open); if (!c) return;
    const replyTo = W.S.reply ? Number(W.S.reply) : undefined;
    W.S.reply = null; W.renderReply();
    W.toast("Отправка…");
    const f = new File([b], name, { type: b.type || "application/octet-stream" });
    client.sendFile(ents[c.id], { file: f, forceDocument: k === "f", supportsStreaming: true, replyTo })
      .then(() => { W.toast("Отправлено"); afterSend(c); }).catch((e) => W.toast("Ошибка отправки: " + errTxt(e)));
  };
  W.sendFile = function (k) {
    if (!TGM) return O.sendFile(k);
    const i = document.createElement("input"); i.type = "file";
    i.accept = k === "v" ? "video/*" : k === "a" ? "audio/*" : k === "g" ? "image/gif" : "*/*";
    i.style.display = "none"; document.body.appendChild(i);
    i.onchange = () => { const f = i.files[0]; i.remove(); if (f) W.sendBlob(f, f.name, k); };
    i.click();
  };

  W.logout = function () {
    if (!TGM) return O.logout();
    W.closeChat();
    client.invoke(new Api.auth.LogOut()).catch(() => {}).finally(() => {
      localStorage.removeItem(SKEY);
      try { indexedDB.deleteDatabase("tgyou_ayu"); } catch (e) {}
      location.reload();
    });
  };

  W.startCall = function () { return TGM ? NOPE() : O.startCall.apply(this, arguments); };

  W.newChatDlg = function () {
    if (!TGM) return O.newChatDlg();
    W.dialog.ph = "@username или номер";
    W.dialog("Новый чат", "Введите @username, ссылку t.me или номер телефона", "", "Начать", openByQuery);
  };
  W.mention = function (n) { if (!TGM) return O.mention(n); openByQuery(n); };

  W.iBlock = function (c) { return TGM && c && c.tg ? !!(W.S.me.blocked && W.S.me.blocked[c.peer]) : O.iBlock(c); };
  W.toggleBlock = function () {
    if (!TGM) return O.toggleBlock();
    const c = W.chat(W.S.open), b = W.iBlock(c);
    client.invoke(b ? new Api.contacts.Unblock({ id: ents[c.id] }) : new Api.contacts.Block({ id: ents[c.id] })).then(() => {
      if (b) delete W.S.me.blocked[c.peer]; else W.S.me.blocked[c.peer] = true;
      W.toast(b ? "Разблокирован" : "Заблокирован");
    }).catch((e) => W.toast(errTxt(e)));
  };

  W.clearHist = function () {
    if (!TGM) return O.clearHist();
    const c = W.chat(W.S.open), ent = ents[c.id];
    W.dialog("Очистить историю?", c.type === "user" ? "Сообщения будут удалены у обоих участников." : "Сообщения будут удалены только у вас.", null, "Очистить", () => {
      const p = ent.className === "InputPeerChannel"
        ? client.invoke(new Api.channels.DeleteHistory({ channel: new Api.InputChannel({ channelId: ent.channelId, accessHash: ent.accessHash }), maxId: 0 }))
        : client.invoke(new Api.messages.DeleteHistory({ peer: ent, maxId: 0, justClear: true, revoke: c.type === "user" }));
      p.then(() => { c.msgs = []; W.renderMsgs(1); W.softMain(); W.toast("История очищена"); }).catch((e) => W.toast(errTxt(e)));
    });
  };
  W.delChat = function () {
    if (!TGM) return O.delChat();
    const c = W.chat(W.S.open);
    W.dialog(c.type === "user" || c.type === "bot" || c.type === "saved" ? "Удалить чат?" : "Покинуть чат?", "Чат пропадёт из списка.", null, "Подтвердить", async () => {
      const id = c.id; W.closeChat(); await leaveOrDelete(c); W.renderMain();
    });
  };
  W.selDel = function () {
    if (!TGM) return O.selDel();
    const n = W.S.sel.length;
    W.dialog("Удалить " + (n > 1 ? n + " чата(ов)" : "чат") + "?", "Чаты будут удалены из списка (из групп и каналов вы выйдете).", null, "Удалить", async () => {
      const ids = W.S.sel.slice(); W.S.sel = [];
      for (const id of ids) { const c = W.chat(id); if (c) await leaveOrDelete(c); }
      W.renderMain();
    });
  };
  W.selRead = function () {
    if (!TGM) return O.selRead();
    W.S.sel.forEach((id) => { const c = W.chat(id); if (c) { c.unread = 0; client.markAsRead(ents[c.id]).catch(() => {}); } });
    W.S.sel = []; W.renderMain();
  };

  // закреп / без звука в списке чатов -> настоящие настройки Telegram
  W.persist = function (c) {
    if (!TGM || !c || !c.tg) return O.persist(c);
    if (!!c.pinned !== !!c._pp) {
      c._pp = !!c.pinned;
      client.invoke(new Api.messages.ToggleDialogPin({ peer: new Api.InputDialogPeer({ peer: ents[c.id] }), pinned: !!c.pinned })).catch((e) => W.toast(errTxt(e)));
    }
    if (!!c.muted !== !!c._pm) {
      c._pm = !!c.muted;
      client.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer: ents[c.id] }), settings: new Api.InputPeerNotifySettings({ muteUntil: c.muted ? 2147483647 : 0 }) })).catch((e) => W.toast(errTxt(e)));
    }
  };

  W.statusText = function (c) {
    if (!TGM || !c || !c.tg || c.type !== "user") return O.statusText(c);
    if (c.typing) return O.statusText(c);
    if (c.online) return "в сети";
    if (c.seen === "t") {
      const d = new Date(c.seenT), n = new Date(), y = new Date(n - 864e5);
      const hm = W.hm(c.seenT);
      if (d.toDateString() === n.toDateString()) return "был(а) в " + hm;
      if (d.toDateString() === y.toDateString()) return "был(а) вчера в " + hm;
      return "был(а) " + d.toLocaleDateString("ru");
    }
    return ({ recent: "был(а) недавно", week: "был(а) на этой неделе", month: "был(а) в этом месяце", long: "был(а) давно" })[c.seen] || "был(а) недавно";
  };

  W.openProfile = function (id) { if (!TGM) return O.openProfile(id); tgProfile(id); };

  W.moreCards = function () { return O.moreCards() + (TGM ? ayuCard() : ""); };

  // меню сообщения: история правок + «убрать» для сохранённых удалённых
  W.msgMenu2 = function (mid) {
    if (!TGM) return O.msgMenu2(mid);
    const m = W.findMsg(mid); if (!m) return;
    if (m.deleted) {
      let h = '<div class="sec" style="padding:4px 12px">🗑 Сообщение удалено собеседником</div>';
      if (m.text) h += W.si("copy", "Копировать", "copyMsg('" + mid + "')");
      if (m.edits && m.edits.length) h += W.si("edit", "История изменений (" + m.edits.length + ")", "AYU_hist('" + mid + "')");
      h += W.si("del", "Убрать из истории", "AYU_forget('" + mid + "')");
      return W.sheet(h);
    }
    O.msgMenu2(mid);
    if (m.edits && m.edits.length) $("#sheet").insertAdjacentHTML("beforeend", W.si("edit", "История изменений (" + m.edits.length + ")", "AYU_hist('" + mid + "')"));
  };
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
