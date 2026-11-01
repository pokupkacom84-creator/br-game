import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { EditedMessage } from "telegram/events/EditedMessage";
import { DeletedMessage } from "telegram/events/DeletedMessage";
import { getPeerId } from "telegram/Utils";
import * as MDX from "telegram/extensions/markdown";
import bigInt from "big-integer";

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
let MYPREM = false;
const CELIST = []; // премиум-эмодзи, вставленные в поле ввода: [{alt, id}]
const ents = {}; // chatId -> InputPeer / entity
const photoQ = {};

const $ = (s) => document.querySelector(s);
const sid = (x) => (x == null ? "" : String(x));
const hue = (s) => { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360; return h; };
const stripCE = (s) => String(s).replace(/\uE000\d+\uE001/g, "").replace(/\uE002/g, "");
const esc = (s) => stripCE(String(s == null ? "" : s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    const r = indexedDB.open("tgyou_ayu", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      const m = d.objectStoreNames.contains("msgs")
        ? r.transaction.objectStore("msgs")
        : d.createObjectStore("msgs", { keyPath: "k" });
      if (!m.indexNames.contains("chat")) m.createIndex("chat", "chat");
      if (!m.indexNames.contains("id")) m.createIndex("id", "id");
      if (!m.indexNames.contains("chatId")) m.createIndex("chatId", ["chat", "id"]);
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs", { keyPath: "k" });
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
async function idbChat(chatId, limit = 250) {
  try {
    await flush();
    const d = await idb();
    const index = d.transaction("msgs").objectStore("msgs").index("chatId");
    const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
    return await new Promise((resolve, reject) => {
      const rows = [];
      const req = index.openCursor(range, "prev");
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || rows.length >= limit) { resolve(rows.reverse()); return; }
        rows.push(cur.value);
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  } catch (e) { return []; }
}
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
    else if (n === "MessageEntityCustomEmoji") { o = "\uE000" + String(e.documentId) + "\uE001"; c = "\uE002"; }
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

// реакции в виде списка: [{k, e, d, n, mine, who:[peerId|"me"]}] — для чипов как в Telegram
function sameR(rr, emo, doc) {
  if (!rr) return false;
  if (emo) return rr.emoticon === emo;
  return rr.documentId != null && String(rr.documentId) === doc;
}
function convRx(m) {
  const res = m.reactions && m.reactions.results;
  if (!res || !res.length) return undefined;
  const rec = m.reactions.recentReactions || [];
  const out = [];
  res.forEach((x) => {
    const emo = x.reaction && x.reaction.emoticon;
    const doc = x.reaction && x.reaction.documentId != null ? String(x.reaction.documentId) : null;
    if (!emo && !doc) return;
    const mine = x.chosenOrder != null;
    const who = rec.filter((r) => sameR(r.reaction, emo, doc)).map((r) => { try { return r.my ? "me" : sid(getPeerId(r.peerId)); } catch (e) { return ""; } }).filter(Boolean);
    if (mine && who.indexOf("me") < 0) who.push("me");
    out.push({ k: emo || "ce:" + doc, e: emo || null, d: doc, n: Number(x.count), mine, who: who.slice(0, 3) });
  });
  return out.length ? out : undefined;
}

const ACT = {
  MessageActionChatAddUser: "добавлен(ы) участник(и)", MessageActionChatDeleteUser: "участник удалён",
  MessageActionChatJoinedByLink: "присоединился(-ась) по ссылке", MessageActionChatJoinedByRequest: "присоединился(-ась)",
  MessageActionChatEditTitle: "изменено название", MessageActionChatEditPhoto: "изменено фото", MessageActionChatDeletePhoto: "фото удалено",
  MessageActionPinMessage: "сообщение закреплено", MessageActionChatCreate: "группа создана", MessageActionChannelCreate: "канал создан",
  MessageActionContactSignUp: "присоединился(-ась) к Telegram", MessageActionHistoryClear: "история очищена", MessageActionPhoneCall: "📞 звонок",
};

function convMsgRaw(m, c) {
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
    fwd, raw: m, react: convReact(m), rx: convRx(m),
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

function convMsg(m, c) {
  try { return convMsgRaw(m, c); }
  catch (e) {
    console.error("convMsg", e, m);
    return { id: sid(m.id), tg: true, out: !!m.out, text: m.message || "", t: (m.date || Date.now() / 1000) * 1000, from: m.out ? "me" : c.name, raw: m };
  }
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

function limiter(n) {
  let a = 0; const q = [];
  const pump = () => { while (a < n && q.length) { const j = q.shift(); a++; j().catch(() => {}).finally(() => { a--; pump(); }); } };
  return { add: (j) => { q.push(j); pump(); } };
}
const avLim = limiter(6), mediaLim = limiter(4);
let softT = 0;
const softSoon = () => { if (softT) return; softT = setTimeout(() => { softT = 0; W.softMain(); }, 200); };
async function avGet(id) { try { const d = await idb(); return await rq(d.transaction("blobs").objectStore("blobs").get("av:" + id)); } catch (e) { return null; } }
async function avPut(id, blob) { try { const d = await idb(); const t = d.transaction("blobs", "readwrite"); t.objectStore("blobs").put({ k: "av:" + id, blob, ts: Date.now() }); await wq(t); } catch (e) {} }
async function loadAvatar(c) {
  if (c.photo || photoQ[c.id]) return;
  photoQ[c.id] = 1;
  const cached = await avGet(c.id);
  if (cached && cached.blob) { c.photo = URL.createObjectURL(cached.blob); softSoon(); if (Date.now() - (cached.ts || 0) < 3 * 864e5) return; }
  avLim.add(async () => {
    const b = await client.downloadProfilePhoto(ents[c.id], { isBig: false });
    if (b && b.length) { const blob = new Blob([b], { type: "image/jpeg" }); c.photo = URL.createObjectURL(blob); avPut(c.id, blob); softSoon(); }
  });
}

async function loadDialogs() {
  const apply = (ds) => {
    const old = {}; (W.S.chats || []).forEach((c) => { old[c.id] = c; });
    W.S.chats = ds.filter((d) => !d.archived).map((d) => old[sid(d.id)] || mkChat(d));
    W.softMain();
    W.S.chats.forEach(loadAvatar);
  };
  apply(await client.getDialogs({ limit: 30 }));
  client.getDialogs({ limit: 200 }).then(apply).catch(() => {});
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
  const netP = client.getMessages(ents[c.id], { limit: 80 });
  if (!c._cacheShown) {
    c._cacheShown = true;
    idbChat(c.id, 80).then(async (rows) => {
      if (!rows.length || W.S.open !== c.id) return;
      const cached = await Promise.all(rows.filter((r) => AYU.keepDeleted || !r.deleted).map(fromRec));
      const map = new Map(c.msgs.map((m) => [m.id, m]));
      cached.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
      c.msgs = [...map.values()].sort(byTime);
      if (W.S.open === c.id) W.renderMsgs();
    }).catch(() => {});
  }
  let list;
  try { list = await netP; }
  catch (e) { c.hist = false; return; }
  const fetched = list.slice().reverse().map((m) => convMsg(m, c));
  const lo = fetched.length ? Math.min(...fetched.map((x) => Number(x.id))) : 0;
  const extra = await mergeCache(c, fetched, lo);
  const map = new Map(fetched.map((m) => [m.id, m]));
  c.msgs.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
  extra.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
  c.msgs = [...map.values()].sort(byTime);
  fetched.forEach((m) => cacheMsg(c, m));
  if (list.length < 80) c.noMore = true;
  if (W.renderMsgs && W.S.open === c.id) W.renderMsgs();
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
    const list = await client.getMessages(ents[c.id], { limit: 60, offsetId: minId });
    if (!list.length) { c.noMore = true; return; }
    const fetched = list.slice().reverse().map((m) => convMsg(m, c));
    const lo = Math.min(...fetched.map((x) => Number(x.id)));
    const extra = await mergeCache(c, fetched, lo);
    const map = new Map(c.msgs.map((m) => [m.id, m]));
    fetched.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
    extra.forEach((m) => { if (!map.has(m.id)) map.set(m.id, m); });
    fetched.forEach((m) => cacheMsg(c, m));
    c.msgs = [...map.values()].sort(byTime);
    if (list.length < 60) c.noMore = true;
    if (W.S.open === c.id) {
      const el = $("#msgs"), h0 = el ? el.scrollHeight : 0, t0 = el ? el.scrollTop : 0;
      W.renderMsgs(1);
      if (el) el.scrollTop = t0 + (el.scrollHeight - h0);
      fetchMedia(c);
    }
  } catch (e) { console.warn("loadOlder", e); } finally { c.loadingOld = false; }
}

const renderSoon = (c) => { if (c._rt) return; c._rt = setTimeout(() => { c._rt = 0; if (W.S.open === c.id) W.renderMsgs(1); }, 150); };
function fetchMedia(c) {
  const list = c.msgs.filter((m) => m.raw && !m.mediaDone && (m.photoPending || m.voice)).reverse(); // сначала самые новые
  for (const m of list) {
    m.mediaDone = true;
    mediaLim.add(async () => {
      const key = c.id + ":" + m.id;
      let blob = await idbGetBlob(key);
      if (!blob) {
        if (m.photoPending) { // мгновенное размытое превью
          try {
            const t = await client.downloadMedia(m.raw, { thumb: 0 });
            if (t && t.length && !m.img) { m.img = URL.createObjectURL(new Blob([t], { type: "image/jpeg" })); m.prev = true; renderSoon(c); }
          } catch (e) {}
        }
        const buf = await client.downloadMedia(m.raw, {});
        if (!buf) return;
        blob = new Blob([buf], { type: m.voice ? "audio/ogg" : "image/jpeg" });
        idbPutBlob(key, blob);
      }
      const url = URL.createObjectURL(blob);
      if (m.voice) m.audio = url;
      else { if (m.prev && m.img) URL.revokeObjectURL(m.img); m.img = url; m.photoPending = false; m.prev = false; }
      cacheMsg(c, m); renderSoon(c);
    });
  }
}

/* =====================================================================
   ЗАПУСК
   ===================================================================== */
function showEntry(err) {
  const el = $("#login"); if (!el) return;
  const img = (document.querySelector("#login img") || {}).src || "";
  el.style.display = "flex";
  el.innerHTML = '<div class="auth"><div class="big">' + (img ? '<img src="' + img + '" alt="">' : "") + "</div><h2>Telegram You</h2><p>Вход выполняется через Telegram</p>" +
    '<button class="tb f aw" id="tge">Войти через Telegram</button>' +
    '<button class="tb" id="tgp" style="margin-top:6px">' + (getProxy() ? "Прокси: включён" : "Настроить прокси") + "</button>" +
    '<div class="aerr" id="aerr">' + esc(err || "") + "</div></div>";
  $("#tge").onclick = startTG;
  $("#tgp").onclick = () => W.AYU_proxy();
}

async function startTG() {
  TGM = true;
  { const el = $("#login"); if (el) { el.style.display = "flex"; el.innerHTML = loginHtml("load"); } }
  try { await connect(); } catch (e) { TGM = false; console.error("connect", e); showEntry("Не удалось подключиться: " + String((e && (e.errorMessage || e.message)) || e)); return; }
  const me = await client.getMe();
  MYID = sid(me.id); MYPREM = !!me.premium;
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
  buildEmoPanel(); loadAvail();
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
  setInterval(pollChat, 8000);
  setInterval(pollDialogs, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollDialogs(); pollChat(); } });
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

async function onNew(ev) {
    let c = chatOf(ev);
    const m = ev.message;
    if (!c) { await loadDialogs(); c = chatOf(ev); if (!c) return; }
    const cm = convMsg(m, c);
    const existing = c.msgs.findIndex((x) => x.id === cm.id);
    if (existing >= 0) {
      const old = c.msgs[existing];
      if (!old.pending && !old.deleted) return;
      c.msgs[existing] = cm;
    } else if (c.hist) c.msgs.push(cm);
    else c.msgs = [cm];
    c.msgs.sort(byTime);
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
  }

function hookEvents() {
  client.addEventHandler((ev) => { onNew(ev).catch((e) => console.error("NewMessage", e)); }, new NewMessage({}));
  client.invoke(new Api.updates.GetState()).catch(() => {}); // запускает поток обновлений

  client.addEventHandler((ev) => { const c = chatOf(ev); if (c) applyEdit(c, ev.message); }, new EditedMessage({}));

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
        if (m) { m.react = convReact({ reactions: u.reactions }); m.rx = convRx({ reactions: u.reactions }); if (W.S.open === c.id) W.renderMsgs(1); }
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
   ОПРОС — запасной канал, если поток обновлений gramjs молчит
   ===================================================================== */
function mergeLive(c, list) {
  if (!list || !list.length) return;
  const view = W.S.open === c.id ? $("#msgs") : null;
  const wasAtBottom = !view || view.scrollHeight - view.scrollTop - view.clientHeight < 120;
  const items = list.slice().reverse(); // старые -> новые
  const ids = items.map((m) => Number(m.id));
  const lo = Math.min(...ids), hi = Math.max(...ids);
  let changed = false;
  const seen = new Set();
  items.forEach((m) => {
    const cm = convMsg(m, c); seen.add(cm.id);
    const old = c.msgs.find((x) => x.id === cm.id);
    if (!old) {
      c.msgs.push(cm); cacheMsg(c, cm); changed = true;
      if (!m.out) {
        if (W.S.open === c.id && !AYU.ghostRead) markRead(c); else if (W.S.open !== c.id) c.unread++;
      }
    } else if (!old.deleted) {
      if (cm.editT && cm.editT !== old.editT) { applyEdit(c, m); }
      else if (JSON.stringify(cm.rx || []) !== JSON.stringify(old.rx || [])) { old.react = cm.react; old.rx = cm.rx; changed = true; }
    }
  });
  const now = Date.now();
  c.msgs.forEach((m) => {
    const n = Number(m.id);
    if (m.pending || m.deleted || isNaN(n) || n < lo || n > hi || seen.has(m.id)) return;
    m.deleted = true; m.delT = now; cacheMsg(c, m); changed = true; // исчезло с сервера
  });
  if (!AYU.keepDeleted) c.msgs = c.msgs.filter((m) => !m.deleted);
  if (changed) {
    c.msgs.sort(byTime);
    if (W.S.open === c.id) { W.renderMsgs(1); if (wasAtBottom) W.scrollEnd(); fetchMedia(c); }
    W.softMain();
  }
}
let polling = false, pollingD = false;
async function pollChat() {
  if (!client || !TGM || polling || document.hidden) return;
  const c = W.chat(W.S.open);
  if (!c || !c.tg || !c.hist || c.loadingOld) return;
  polling = true;
  try { mergeLive(c, await client.getMessages(ents[c.id], { limit: 25 })); } catch (e) {} finally { polling = false; }
}
async function pollDialogs() {
  if (!client || !TGM || pollingD || document.hidden) return;
  pollingD = true;
  try {
    const ds = await client.getDialogs({ limit: 40 });
    let added = false;
    for (const d of ds) {
      if (d.archived) continue;
      const id = sid(d.id), c = chatById(id);
      if (!c) { const nc = mkChat(d); W.S.chats.push(nc); loadAvatar(nc); added = true; continue; }
      const dl = d.dialog || {};
      if (dl.readOutboxMaxId != null) { c.readOut = Number(dl.readOutboxMaxId) || c.readOut; c.msgs.forEach((m) => { if (m.out && Number(m.id) <= c.readOut) m.read = true; }); }
      if (W.S.open !== c.id) c.unread = d.unreadCount || 0;
      c.online = false; c.seen = undefined; Object.assign(c, statusOf(d.entity));
      if (d.message) {
        const cm = convMsg(d.message, c);
        if (!c.msgs.some((x) => x.id === cm.id)) { if (c.hist) c.msgs.push(cm); else c.msgs = [cm]; cacheMsg(c, cm); }
      }
    }
    W.softMain();
    if (W.S.open) W.renderChatHdr();
  } catch (e) {} finally { pollingD = false; }
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

// gramjs не присылает NewMessage/EditedMessage на то, что отправили мы сами — добавляем из ответа вручную
function addSent(c, m) {
  try {
    if (!m || m.id == null) return;
    const cm = convMsg(m, c);
    if (!c.msgs.some((x) => x.id === cm.id)) c.msgs.push(cm);
    cacheMsg(c, cm);
    if (W.S.open === c.id) { W.renderMsgs(1); W.scrollEnd(); fetchMedia(c); }
    W.softMain();
  } catch (e) { console.error("addSent", e); }
}
function addSentAny(c, r) { (Array.isArray(r) ? r : [r]).forEach((m) => addSent(c, m)); }
function applyEdit(c, m) {
  const i = c.msgs.findIndex((x) => x.id === sid(m.id));
  if (i < 0) return;
  const old = c.msgs[i], nw = convMsg(m, c);
  nw.edits = old.edits;
  if (AYU.keepEdits && old.text !== nw.text && old.text) nw.edits = (old.edits || []).concat([{ t: old.editT || old.t, text: old.text }]);
  ["img", "audio", "mediaDone"].forEach((k) => { if (old[k] !== undefined && (old.img || old.audio)) nw[k] = old[k]; });
  if (nw.img) nw.photoPending = false;
  c.msgs[i] = nw; cacheMsg(c, nw);
  if (W.S.open === c.id) W.renderMsgs(1);
  W.softMain();
}

function addPending(c, o, label) {
  const p = { id: "p" + Date.now() + Math.random().toString(36).slice(2, 5), tg: true, out: true, pending: true, from: "me", t: Date.now(),
    text: o.img || o.voice ? "" : (label || o.text || o.sticker || ""), reply: o.reply || undefined };
  if (o.img) { p.img = o.img; }
  if (o.voice) { p.voice = true; p.dur = o.dur || 1; p.audio = o.audio; }
  c.msgs.push(p);
  if (W.S.open === c.id) { W.renderMsgs(1); W.scrollEnd(); }
  W.softMain();
  return p;
}
function dropPending(c, p) {
  c.msgs = c.msgs.filter((x) => x !== p);
  if (W.S.open === c.id) W.renderMsgs(1);
}

async function send(c, o) {
  const ent = ents[c.id];
  const replyTo = o.reply ? Number(o.reply) : undefined;
  let r;
  const pend = (o.text || o.sticker || o.img || o.voice) ? addPending(c, o) : null;
  try {
    if (o.img) {
      const f = new File([dataToBuf(o.img)], "photo.jpg", { type: "image/jpeg" });
      r = await client.sendFile(ent, { file: f, forceDocument: false, replyTo });
    } else if (o.voice && o.audio) {
      const mt = mimeOf(o.audio) || "audio/ogg";
      const f = new File([dataToBuf(o.audio)], "voice." + (/ogg/.test(mt) ? "ogg" : /mp4/.test(mt) ? "m4a" : "webm"), { type: mt });
      r = await client.sendFile(ent, { file: f, voiceNote: true, attributes: [new Api.DocumentAttributeAudio({ voice: true, duration: o.dur || 1 })], replyTo });
    } else {
      const message = o.text || o.sticker || "";
      if (!message) return;
      const list = CELIST.splice(0);
      let done = false;
      if (list.length && MDX && MDX.MarkdownParser) {
        try {
          const pr = MDX.MarkdownParser.parse(message), msg = pr[0], base = pr[1] || [], ce = [];
          let pos = 0;
          list.forEach((it) => { const i = msg.indexOf(it.alt, pos); if (i < 0) return; ce.push(new Api.MessageEntityCustomEmoji({ offset: i, length: it.alt.length, documentId: bigInt(it.id) })); pos = i + it.alt.length; });
          r = await client.sendMessage(ent, { message: msg, replyTo, silent: !!o.silent, formattingEntities: base.concat(ce).sort((a, b) => a.offset - b.offset) });
          done = true;
        } catch (e0) { console.warn("custom emoji send failed, fallback", e0); }
      }
      if (!done) {
        try { r = await client.sendMessage(ent, { message, replyTo, silent: !!o.silent, parseMode: "md" }); }
        catch (e1) { r = await client.sendMessage(ent, { message, replyTo, silent: !!o.silent }); } // запасной вариант без разметки
      }
    }
  } catch (e) { console.error("send", e); if (pend) dropPending(c, pend); return W.toast("Ошибка отправки: " + errTxt(e)); }
  if (pend) c.msgs = c.msgs.filter((x) => x !== pend);
  addSentAny(c, r);
  try { afterSend(c); } catch (e) {}
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
  s.textContent = ".m.deleted{opacity:.8;outline:1.5px dashed #d93025;outline-offset:-1.5px}.m .mt .ayud{color:#d93025;margin-right:4px}.m .mt .ayue{text-decoration:underline dotted}" + SKIN_CSS;
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
   ПРЕМИУМ-ЭМОДЗИ (custom emoji): показ в тексте/реакциях и выбор в панели
   Анимированные TGS показываются статичной картинкой (превью), WEBM/WEBP — как есть.
   ===================================================================== */
const CE = new Map(); // id -> {doc, url, video, busy}
const RE_CE = /\uE000(\d+)\uE001([^\uE002]*)\uE002/g;
const ceEl = (e) => (e.video ? '<video class="cei" src="' + e.url + '" autoplay loop muted playsinline></video>' : '<img class="cei" src="' + e.url + '" alt="">');
function ceHtml(id, alt) {
  const e = CE.get(id);
  if (e && e.url) return '<span class="ce" data-ce="' + id + '" data-h="1">' + ceEl(e) + "</span>";
  return '<span class="ce" data-ce="' + id + '">' + esc(alt || "⭐") + "</span>";
}
function ceFill(id) {
  const e = CE.get(id); if (!e || !e.url) return;
  document.querySelectorAll('.ce[data-ce="' + id + '"]').forEach((el) => { if (el.dataset.h) return; el.dataset.h = "1"; el.innerHTML = ceEl(e); });
}
async function ceDownload(id) {
  const e = CE.get(id); if (!e || e.url || e.busy || !e.doc) return;
  e.busy = true;
  try {
    let blob = await idbGetBlob("ce:" + id);
    if (!blob) {
      const d = e.doc, mt = d.mimeType || ""; let buf, type = "image/webp";
      if (mt === "video/webm") { buf = await client.downloadMedia(d, {}); type = "video/webm"; }
      else if (mt === "image/webp" || mt === "image/png") { buf = await client.downloadMedia(d, {}); type = mt; }
      else { const sz = (d.thumbs || []).filter((t) => t.className === "PhotoSize" || t.className === "PhotoCachedSize").pop(); if (sz) buf = await client.downloadMedia(d, { thumb: sz }); }
      if (buf && buf.length) { blob = new Blob([buf], { type }); idbPutBlob("ce:" + id, blob); }
    }
    if (blob) { e.url = URL.createObjectURL(blob); e.video = /^video/.test(blob.type); ceFill(id); }
  } catch (err) {} finally { e.busy = false; }
}
async function ceLoad(ids) {
  if (!client) return;
  ids = [...new Set(ids)].filter((i) => { const e = CE.get(i); return !(e && (e.url || e.busy)); });
  if (!ids.length) return;
  const need = ids.filter((i) => !(CE.get(i) && CE.get(i).doc));
  if (need.length) {
    try {
      const r = await client.invoke(new Api.messages.GetCustomEmojiDocuments({ documentId: need.map((i) => bigInt(i)) }));
      r.forEach((d) => { const id = String(d.id); CE.set(id, Object.assign(CE.get(id) || {}, { doc: d })); });
    } catch (e) {}
  }
  for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(ceDownload));
}
function ceHydrate(root) {
  const ids = [];
  (root || document).querySelectorAll(".ce[data-ce]:not([data-h])").forEach((el) => {
    const id = el.dataset.ce, e = CE.get(id);
    if (e && e.url) ceFill(id); else ids.push(id);
  });
  if (ids.length) ceLoad(ids);
}
const altOf = (d) => { const a = (d.attributes || []).find((x) => x.className === "DocumentAttributeCustomEmoji"); return (a && a.alt) || "⭐"; };

W.AYU_ce = (id, alt) => {
  const ta = $("#ta"); if (!ta) return;
  ta.value += alt; CELIST.push({ alt, id });
  if (!MYPREM && !W._cePremHint) { W._cePremHint = 1; toast("Без Telegram Premium такой эмодзи отправится обычным"); }
  W.onType && W.onType();
};

/* ---------- реакции в стиле Telegram ---------- */
let AVAIL = ["❤️", "👍", "👎", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "😈", "😴", "😭", "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "🤗", "🫡", "🎅", "🎄", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷", "😡"];
async function loadAvail() {
  try {
    const r = await client.invoke(new Api.messages.GetAvailableReactions({ hash: 0 }));
    if (r && r.reactions) { const l = r.reactions.filter((x) => !x.inactive && (MYPREM || !x.premium)).map((x) => x.reaction); if (l.length) AVAIL = l; }
  } catch (e) {}
}
function rxAv(w) {
  let url = "", name = "?";
  if (w === "me") { url = W.S.me && W.S.me.avatar; name = W.S.name || "Я"; }
  else { const c = chatById(w); if (c) { url = c.photo; name = c.name; } }
  return '<i style="' + (url ? "background-image:url(" + url + ")" : "background:hsl(" + hue(w) + ",45%,42%)") + '">' + (url ? "" : esc((name || "?").trim().charAt(0).toUpperCase())) + "</i>";
}
function rxHtml(m) {
  const list = m.rx; if (!list || !list.length) return "";
  return '<div class="rxs">' + list.map((r) => {
    const sym = r.e ? '<span class="rxe">' + esc(r.e) + "</span>" : ceHtml(r.d, "⭐");
    const tail = r.who.length && r.who.length === r.n && r.n <= 3 ? '<span class="rxa">' + r.who.map(rxAv).join("") + "</span>" : "<b>" + r.n + "</b>";
    return '<span class="rx tgrx' + (r.mine ? " me" : "") + '" onclick="event.stopPropagation();react(\'' + m.id + "','" + r.k + '\')">' + sym + tail + "</span>";
  }).join("") + "</div>";
}
W.AYU_rxMore = (mid) => {
  const box = $("#rxall"); if (!box) return;
  if (box.dataset.o) { box.style.display = "none"; box.dataset.o = ""; return; }
  box.dataset.o = "1"; box.style.display = "grid";
  box.innerHTML = AVAIL.map((e) => '<button onclick="closeAll();react(\'' + mid + "','" + e + '\')">' + e + "</button>").join("");
  if (MYPREM) {
    client.invoke(new Api.messages.GetTopReactions({ limit: 40, hash: bigInt(0) })).then((r) => {
      (r.reactions || []).filter((x) => x.documentId != null).forEach((x) => {
        const id = String(x.documentId);
        box.insertAdjacentHTML("beforeend", '<button onclick="closeAll();react(\'' + mid + "','ce:" + id + '\')"><span class="ce" data-ce="' + id + '">⭐</span></button>');
      });
      ceHydrate(box);
    }).catch(() => {});
  }
};

/* ---------- панель эмодзи: категории, недавние, премиум ---------- */
const isEmo = (s) => /^\p{Emoji_Presentation}$/u.test(s);
const rng = (a, b) => { const o = []; for (let i = a; i <= b; i++) { const c = String.fromCodePoint(i); if (isEmo(c)) o.push(c); } return o; };
const flag = (cc) => String.fromCodePoint(...[...cc].map((ch) => 0x1F1E6 + ch.charCodeAt(0) - 65));
const sp = (t) => t.split(" ");
let ECATS = null;
function ecats() {
  if (ECATS) return ECATS;
  ECATS = [
    { i: "😀", e: [].concat(rng(0x1F600, 0x1F64F), rng(0x1F910, 0x1F93A), rng(0x1F970, 0x1F97A), sp("🥲 🫠 🫡 🫢 🫣 🫤 🥹")) },
    { i: "👍", e: sp("👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐 🖖 👋 🤝 🙏 ✍️ 💪 👏 🙌 👐 🤲 🫶 🫰 🫵 👊 ✊ 🤛 🤜 🤌 🤏 🖕 👀 👅 👄 🧠 🫀") },
    { i: "❤️", e: sp("❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✨ ⭐ 🌟 🔥 🎉 🎊") },
    { i: "🐶", e: [].concat(rng(0x1F400, 0x1F43F), rng(0x1F980, 0x1F9AF)) },
    { i: "🍔", e: [].concat(rng(0x1F345, 0x1F37F), rng(0x1F950, 0x1F96B), rng(0x1F32D, 0x1F32F)) },
    { i: "⚽", e: [].concat(sp("⚽ 🏀 🏈 ⚾ 🎾 🏐 🎮 🎲 🎯 🎵 🎶 🎤 🎧 🎸 🎹 🥇 🏆"), rng(0x1F3A0, 0x1F3CA)) },
    { i: "🚀", e: [].concat(rng(0x1F680, 0x1F6A4), rng(0x1F30D, 0x1F320), rng(0x1F3E0, 0x1F3F0)) },
    { i: "💡", e: [].concat(sp("📱 💻 ⌚ 📷 🎁 🔑 🔒 📌 ✏️ 📎 💰 💳"), rng(0x1F4A1, 0x1F4FF)) },
    { i: "✅", e: sp("✅ ❌ ⭕ ❗ ❓ ‼️ ⚠️ 🚫 ♻️ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🔞 🆗 🆒 🆕 🔝") },
    { i: "🇷🇺", e: sp("RU UA BY KZ UZ GE AM AZ US GB DE FR IT ES TR CN JP KR IN BR PL NL").map(flag) },
  ];
  return ECATS;
}
const REC_KEY = "tgyou_recent_emo";
const recents = () => { try { return JSON.parse(localStorage.getItem(REC_KEY) || "[]"); } catch (e) { return []; } };
let ETAB = "0";
function buildEmoPanel() {
  const el = $("#emo"); if (!el) return;
  const tabs = [{ k: "r", i: "🕒" }].concat(ecats().map((c, i) => ({ k: String(i), i: c.i })), [{ k: "ce", i: "⭐" }]);
  el.innerHTML = '<div class="etabs">' + tabs.map((t) => '<button data-k="' + t.k + '" onclick="AYU_etab(\'' + t.k + '\')">' + t.i + "</button>").join("") + '</div><div class="egrid" id="egrid"></div>';
  W.AYU_etab(recents().length ? "r" : "0");
}
W.AYU_etab = (k) => {
  ETAB = k;
  document.querySelectorAll("#emo .etabs button").forEach((b) => b.classList.toggle("on", b.dataset.k === k));
  const g = $("#egrid"); if (!g) return;
  g.className = "egrid"; g.scrollTop = 0;
  if (k === "ce") return cePanel(g);
  const list = k === "r" ? recents() : ecats()[Number(k)].e;
  g.innerHTML = list.length ? list.map((e) => '<button onclick="addEmo(\'' + e + '\')">' + e + "</button>").join("") : '<div class="cehint">Пока пусто</div>';
};
async function cePanel(g) {
  g.className = "egrid cep"; g.innerHTML = '<div class="cehint">Загрузка…</div>';
  try {
    let sets = ((await client.invoke(new Api.messages.GetEmojiStickers({ hash: bigInt(0) }))).sets || []).slice(0, 8);
    if (!sets.length) sets = ((await client.invoke(new Api.messages.GetFeaturedEmojiStickers({ hash: bigInt(0) }))).sets || []).map((x) => x.set || x).slice(0, 8);
    g.innerHTML = MYPREM ? "" : '<div class="cehint">Для отправки нужен Telegram Premium — без него эмодзи уйдёт обычным</div>';
    for (const st of sets) {
      if (ETAB !== "ce") return;
      const ss = await client.invoke(new Api.messages.GetStickerSet({ stickerset: new Api.InputStickerSetID({ id: st.id, accessHash: st.accessHash }), hash: 0 }));
      let h = '<div class="cest">' + esc(st.title) + '</div><div class="cegrid">';
      (ss.documents || []).slice(0, 48).forEach((d) => {
        const id = String(d.id), alt = altOf(d);
        const e = CE.get(id) || {}; if (!e.doc) { e.doc = d; CE.set(id, e); }
        h += '<button class="ceb" onclick="AYU_ce(\'' + id + "','" + esc(alt) + '\')">' + ceHtml(id, alt) + "</button>";
      });
      g.insertAdjacentHTML("beforeend", h + "</div>");
      ceHydrate(g);
    }
  } catch (e) { g.innerHTML = '<div class="cehint">Не удалось загрузить: ' + esc(errTxt(e)) + "</div>"; }
}

/* ---------- внешний вид «как в Telegram» ---------- */
const DOODLE = "<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240' fill='none' stroke='#8a8f98' stroke-opacity='.17' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='30' cy='34' r='12'/><path d='M88 28l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z'/><path d='M165 44c-9-15-31-2-20 13l20 17 20-17c11-15-11-28-20-13z'/><rect x='24' y='104' width='32' height='24' rx='7'/><path d='M96 116c0-11 15-11 15 0s15 11 15 0'/><circle cx='186' cy='116' r='6'/><circle cx='204' cy='104' r='4'/><path d='M40 186l11-15 11 15z'/><path d='M104 190h42M125 174v32'/><circle cx='196' cy='192' r='15'/><path d='M189 192h14M196 185v14'/><path d='M140 130c6-9 16-9 22 0'/><path d='M70 70l16 16M86 70L70 86'/></svg>";
const SKIN_CSS = `
.chbar{background:transparent!important;padding:8px 10px 6px!important;gap:8px}
.chbar>.ib{background:var(--s3);width:52px;height:52px;flex-shrink:0;color:var(--os)}
.chbar .who{background:var(--s3);border-radius:30px;min-height:52px;padding:4px 16px 4px 4px;gap:10px}
.chbar .who .av{width:44px;height:44px}
.chbar .nm{font-size:17px;line-height:1.15}.chbar .st{font-size:13px;line-height:1.15}
#pinbar .pinb{margin:2px 10px 4px;border:0;border-radius:22px;background:var(--s3);padding:8px 8px 8px 16px}
.msgs{background-color:var(--s1);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240' fill='none' stroke='%238a8f98' stroke-opacity='.17' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='30' cy='34' r='12'/%3E%3Cpath d='M88 28l5 11 12 1-9 8 3 12-11-6-11 6 3-12-9-8 12-1z'/%3E%3Cpath d='M165 44c-9-15-31-2-20 13l20 17 20-17c11-15-11-28-20-13z'/%3E%3Crect x='24' y='104' width='32' height='24' rx='7'/%3E%3Cpath d='M96 116c0-11 15-11 15 0s15 11 15 0'/%3E%3Ccircle cx='186' cy='116' r='6'/%3E%3Ccircle cx='204' cy='104' r='4'/%3E%3Cpath d='M40 186l11-15 11 15z'/%3E%3Cpath d='M104 190h42M125 174v32'/%3E%3Ccircle cx='196' cy='192' r='15'/%3E%3Cpath d='M189 192h14M196 185v14'/%3E%3Cpath d='M140 130c6-9 16-9 22 0'/%3E%3Cpath d='M70 70l16 16M86 70L70 86'/%3E%3C/svg%3E");background-size:240px 240px;padding:6px 10px}
.m{border-radius:20px;padding:8px 12px 6px}
.m.in{background:var(--s3);border-bottom-left-radius:6px}
.m.out{border-bottom-right-radius:6px}
.day{background:var(--s3);color:var(--os);font-weight:500}
.comp{background:transparent!important;padding:6px 10px 10px;padding-bottom:calc(10px + env(safe-area-inset-bottom))}
.inp{background:var(--s3)!important;border-radius:30px!important;min-height:56px!important}
.inp textarea{height:56px;padding:16px 4px}
.sb{width:56px!important;height:56px!important;background:var(--pc)!important;color:var(--onpc)!important}
.nav{margin:0 12px calc(10px + env(safe-area-inset-bottom));padding:8px 6px!important;border-radius:36px;background:var(--s3)!important;box-shadow:0 2px 12px rgba(0,0,0,.25)}
.nv{border-radius:28px;padding:6px 0}
.nv .pill{background:none!important;height:28px}
.nv.on{background:var(--sc);color:var(--onsc)}
.chips{background:var(--s2);margin:4px 14px 8px;border-radius:30px;padding:6px;gap:6px}
.chip{flex:1;justify-content:center;height:42px;border:0;border-radius:24px;font-size:16px}
.chip.on{background:var(--sc);color:var(--os)}
.ci{margin:0;border-radius:0;padding:10px 16px}
.fab{border-radius:22px;background:var(--pc);color:var(--onpc);bottom:calc(112px + env(safe-area-inset-bottom))}
.rxs{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.rx{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:16px;background:color-mix(in srgb,currentColor 16%,transparent);font-size:16px;font-weight:500}
.rx.me{background:var(--p);color:var(--onp)}
.rx b{font-weight:500;font-size:14px}
.rxa{display:inline-flex}.rxa i{width:20px;height:20px;border-radius:50%;background-size:cover;background-position:center;margin-left:-6px;font-style:normal;font-size:11px;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 0 0 2px var(--s3)}
.rxa i:first-child{margin-left:0}
.m.out .rxa i{box-shadow:0 0 0 2px var(--pc)}
.ce{display:inline-block}.cei{width:1.3em;height:1.3em;vertical-align:-.3em;object-fit:contain}
.rx .cei{width:20px;height:20px;vertical-align:middle}
.rxbar{display:flex;align-items:center;justify-content:space-around;padding:6px 4px;border-radius:30px;background:var(--s3);margin-bottom:8px}
.rxbar button{font-size:28px;width:44px;height:44px;border-radius:50%}
.rxbar .rxmore{font-size:22px;color:var(--osv)}
.rxall{max-height:230px;overflow-y:auto;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:8px}
.rxall button{font-size:28px;height:46px;border-radius:12px}.rxall .cei{width:30px;height:30px}
#emo.show{display:block;max-height:300px;padding-top:6px}
.etabs{display:flex;gap:4px;overflow-x:auto;padding:2px 0 6px;scrollbar-width:none}
.etabs button{flex-shrink:0;width:42px;height:38px;border-radius:14px;font-size:20px}
.etabs button.on{background:var(--sc)}
.egrid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;max-height:236px;overflow-y:auto}
.egrid.cep{display:block}
.egrid button{font-size:26px;height:44px;border-radius:12px}
.cegrid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px}
.ceb{display:flex;align-items:center;justify-content:center}.ceb .cei{width:32px;height:32px}
.cest{font-size:13px;font-weight:500;color:var(--p);padding:8px 6px 4px}
.cehint{grid-column:1/-1;padding:12px;color:var(--osv);font-size:14px;text-align:center}
`;

function patchSkin(O) {
  W.rxOf = function (m) { return TGM && m && m.rx ? rxHtml(m) : O.rxOf(m); };
  W.esc = function (x) { return O.esc(typeof x === "string" && x.indexOf("\uE000") >= 0 ? stripCE(x) : x); };
  W.fmt = function (t) {
    if (!TGM || typeof t !== "string" || t.indexOf("\uE000") < 0) return O.fmt(t);
    const out = []; let last = 0;
    t.replace(RE_CE, (m0, id, alt, off) => { out.push(O.fmt(t.slice(last, off)), ceHtml(id, alt)); last = off + m0.length; return m0; });
    out.push(O.fmt(t.slice(last)));
    return out.join("");
  };
  W.copyMsg = function (id) {
    const m = W.findMsg(id);
    if (m && m.text && m.text.indexOf("\uE000") >= 0) { const t = m.text; m.text = stripCE(t); try { O.copyMsg(id); } finally { m.text = t; } }
    else O.copyMsg(id);
  };
  W.editMsg = function (id) { O.editMsg(id); const ta = $("#ta"); if (ta && ta.value.indexOf("\uE000") >= 0) ta.value = stripCE(ta.value); };
  W.addEmo = function (e) {
    O.addEmo(e);
    try { const r = [e].concat(recents().filter((x) => x !== e)).slice(0, 32); localStorage.setItem(REC_KEY, JSON.stringify(r)); } catch (x) {}
  };
}

function decorateSkin() { ceHydrate(document.getElementById("msgs")); }

/* =====================================================================
   ПОДМЕНА ФУНКЦИЙ ПРИЛОЖЕНИЯ
   ===================================================================== */
function patch() {
  const O = {};
  ["hideBan", "showLogin", "openChat", "pushMsg", "pushTo", "sbClick", "markRead", "doDel", "logout", "getMedia", "react", "pinMsg",
    "setTyping", "typingPing", "startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat", "persist", "selDel", "selRead",
    "statusText", "doFwd", "openProfile", "sendBlob", "sendFile", "mention", "moreCards", "renderMsgs", "msgMenu2", "iBlock",
    "rxOf", "esc", "fmt", "copyMsg", "editMsg", "addEmo"].forEach((n) => { O[n] = W[n]; });
  patchSkin(O);

  // вход только через Telegram: экран входа Firebase никогда не показывается
  W.showLogin = function () { if (!TGM) showEntry(); };
  W.startApp = function () {}; // сессия Firebase не используется
  W.showBan = function () {};

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

  W.renderMsgs = function () { const r = O.renderMsgs.apply(this, arguments); decorate(); if (TGM) decorateSkin(); return r; };

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
      if (v) client.editMessage(ents[c.id], { message: id, text: v, parseMode: "md" })
        .catch(() => client.editMessage(ents[c.id], { message: id, text: v }))
        .then((m) => m && applyEdit(c, m)).catch((e) => W.toast(errTxt(e) || "Ошибка"));
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
    client.forwardMessages(ents[to.id], { messages: ids, fromPeer: ents[src.id] }).then((r) => { addSentAny(to, r); toast("Переслано"); }).catch((e) => toast(errTxt(e)));
    W.clrMsel();
  };

  W.react = function (mid, e) {
    if (!TGM) return O.react(mid, e);
    const c = W.chat(W.S.open), m = W.findMsg(mid); if (!m) return;
    const isCe = /^ce:/.test(e), doc = isCe ? e.slice(3) : null;
    const mine = (m.rx || []).some((r) => r.mine && r.k === e);
    const reaction = isCe ? new Api.ReactionCustomEmoji({ documentId: bigInt(doc) }) : new Api.ReactionEmoji({ emoticon: e });
    client.invoke(new Api.messages.SendReaction({ peer: ents[c.id], msgId: Number(mid), reaction: mine ? [] : [reaction] })).catch((err) => W.toast(errTxt(err)));
    // сразу показываем результат, сервер подтвердит позже
    m.rx = (m.rx || []).map((r) => (r.mine ? Object.assign({}, r, { n: r.n - 1, mine: false, who: r.who.filter((w) => w !== "me") }) : r)).filter((r) => r.n > 0);
    if (!mine) {
      const r = m.rx.find((x) => x.k === e);
      if (r) { r.n++; r.mine = true; r.who = r.who.concat("me").slice(0, 3); }
      else m.rx.push({ k: e, e: isCe ? null : e, d: doc, n: 1, mine: true, who: ["me"] });
    }
    m.react = mine ? {} : { me: e };
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
    const pend = addPending(c, {}, "📎 " + name + " (отправка…)");
    const f = new File([b], name, { type: b.type || "application/octet-stream" });
    client.sendFile(ents[c.id], { file: f, forceDocument: k === "f", supportsStreaming: true, replyTo })
      .then((r) => { W.toast("Отправлено"); c.msgs = c.msgs.filter((x) => x !== pend); addSentAny(c, r); try { afterSend(c); } catch (e) {} }).catch((e) => { dropPending(c, pend); W.toast("Ошибка отправки: " + errTxt(e)); });
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
    const row = $("#sheet") && $("#sheet").firstElementChild;
    if (row && row.querySelector("button") && !row.classList.contains("sec")) {
      row.outerHTML = '<div class="rxbar">' + AVAIL.slice(0, 6).map((e) => '<button onclick="closeAll();react(\'' + mid + "','" + e + '\')">' + e + "</button>").join("") + '<button class="rxmore" onclick="AYU_rxMore(\'' + mid + '\')">⌄</button></div><div class="rxall" id="rxall" style="display:none"></div>';
    }
    if (m.edits && m.edits.length) $("#sheet").insertAdjacentHTML("beforeend", W.si("edit", "История изменений (" + m.edits.length + ")", "AYU_hist('" + mid + "')"));
  };
}

/* ---------- автозапуск ---------- */
function boot() {
  patch();
  // всегда сразу входим через Telegram: по сохранённой сессии или с экрана ввода номера
  const t = setInterval(() => { if (typeof W.S === "object" && W.chat && W.renderMain) { clearInterval(t); startTG(); } }, 50);
}
boot();
