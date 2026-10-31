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
const ERR = {
  PHONE_CODE_INVALID: "Неверный код",
  PHONE_CODE_EXPIRED: "Код устарел, запросите новый",
  PHONE_CODE_EMPTY: "Введите код",
  PASSWORD_HASH_INVALID: "Неверный пароль",
  PHONE_NUMBER_INVALID: "Неверный номер",
  PHONE_NUMBER_BANNED: "Этот номер заблокирован в Telegram",
  PHONE_NUMBER_FLOOD: "Слишком много запросов кода для этого номера. Подождите несколько часов",
  PHONE_NUMBER_UNOCCUPIED: "Этот номер не зарегистрирован в Telegram",
  API_ID_INVALID: "Неверные API ID / API HASH",
  API_ID_PUBLISHED_FLOOD: "Ключ API временно заблокирован из-за лимитов. Нужен свой API ID",
  SEND_CODE_UNAVAILABLE: "Telegram больше не может отправить код. Подождите и попробуйте позже",
  FLOOD: "Слишком много попыток, подождите",
};

const LOG = [];
function dbg(m) {
  console.log("[TG login]", m);
  LOG.push(m);
  const e = $("#tgst");
  if (e) e.textContent = LOG.slice(-6).join("\n");
}

function tr(e) {
  console.error("[TG login]", e);
  LOG.push("ОШИБКА: " + String((e && (e.errorMessage || e.message)) || e));
  if (e && e.seconds) return "Слишком много попыток. Подождите " + e.seconds + " сек.";
  const m = String((e && e.errorMessage) || (e && e.message) || e);
  return ERR[m] || m;
}

function typeName(t) {
  const n = (t && (t.className || (t.constructor && t.constructor.name))) || "";
  if (!n) return "";
  if (/App/.test(n)) return "app";
  if (/Sms/.test(n)) return "sms";
  if (/FlashCall|MissedCall/.test(n)) return "flash";
  if (/Call/.test(n)) return "call";
  if (/Email/.test(n)) return "email";
  return "other";
}

const HOW = {
  app: "Код отправлен в приложение Telegram: откройте чат «Telegram» на устройстве, где вы уже вошли",
  sms: "Код отправлен по SMS",
  call: "Telegram позвонит и продиктует код",
  flash: "Код — последние цифры номера входящего звонка",
  email: "Код отправлен на вашу почту",
  other: "Код отправлен. Проверьте приложение Telegram и SMS",
};
const NEXT = { app: "в приложение", sms: "по SMS", call: "звонком", flash: "звонком", email: "на почту", other: "другим способом" };

function loginHtml(step, info) {
  const T = {
    phone: ["Введите номер телефона в международном формате", "phone", "+7 900 000 00 00", "tel"],
    code: [HOW[info.type] || HOW.other, "code", "Код", "numeric"],
    password: ["Включена двухэтапная проверка. Введите пароль", "pw", "Пароль", "text"],
  }[step];
  const img = (document.querySelector("#login img") || {}).src || "";
  let h = '<div class="auth"><div class="big">' + (img ? '<img src="' + img + '" alt="">' : "") + "</div><h2>Telegram You</h2><p>" + T[0] + "</p>";
  h += '<div class="afield"><input id="tgi" ' + (step === "password" ? 'type="password"' : "") + ' inputmode="' + T[3] + '" placeholder="' + T[2] + '" autocomplete="off"></div>';
  h += '<button class="tb f aw" id="tgb">Далее</button>';
  if (step === "phone") {
    h += '<button class="tb aw" id="tgqr" style="margin-top:8px">Войти без кода (через приложение Telegram)</button>';
  }
  if (step === "code") {
    h += '<button class="tb aw" id="tgr" style="margin-top:8px">Отправить код повторно' + (info.next ? " (" + (NEXT[info.next] || "") + ")" : "") + "</button>";
    h += '<button class="tb aw" id="tgback" style="margin-top:4px">Другой номер</button>';
  }
  h += '<div id="tgst" style="white-space:pre-wrap;font-size:11px;opacity:.6;margin-top:12px;text-align:left;word-break:break-all"></div>';
  h += '<div class="aerr" id="aerr"></div></div>';
  return h;
}

// возвращает {v} (введённое значение) | {resend:true} | {back:true}
function ask(step, err, info) {
  return new Promise((res) => {
    const el = $("#login");
    el.style.display = "flex";
    el.innerHTML = loginHtml(step, info || {});
    $("#aerr").textContent = err || "";
    const st = $("#tgst"); if (st) st.textContent = LOG.slice(-6).join("\n");
    const inp = $("#tgi"), btn = $("#tgb"), rb = $("#tgr"), bb = $("#tgback");
    const go = () => { const v = inp.value.trim(); if (!v) return; btn.disabled = true; btn.textContent = "…"; res({ v }); };
    btn.onclick = go;
    inp.onkeydown = (e) => { if (e.keyCode === 13) go(); };
    if (rb) rb.onclick = () => { rb.disabled = true; rb.textContent = "…"; res({ resend: true }); };
    if (bb) bb.onclick = () => res({ back: true });
    const qb = $("#tgqr");
    if (qb) qb.onclick = () => res({ qr: true });
    setTimeout(() => inp.focus(), 100);
  });
}

function cleanPhone(raw) {
  let d = raw.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1); // 8 900... -> +7 900...
  return "+" + d;
}

async function signInPassword(A) {
  let err = "";
  while (true) {
    const { v } = await ask("password", err);
    let perr = null;
    try {
      await client.signInWithPassword(A, { password: async () => v, onError: async (e) => { perr = e; return true; } });
      return;
    } catch (e) { err = tr(perr || e); }
  }
}

// библиотека QR подгружается только когда нужна, чтобы её сбой не ломал остальное
function loadQr() {
  if (W.qrcode) return Promise.resolve(W.qrcode);
  return new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
    sc.onload = () => (W.qrcode ? res(W.qrcode) : rej(new Error("библиотека QR не найдена")));
    sc.onerror = () => rej(new Error("не удалось загрузить библиотеку QR"));
    document.head.appendChild(sc);
  });
}

function qrSvg(lib, text) {
  const q = lib(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(), m = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + m) + " " + (r + m) + "h1v1h-1z";
  const size = n + m * 2;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + " " + size + '" shape-rendering="crispEdges" style="width:100%;max-width:280px;background:#fff;border-radius:12px"><path d="' + d + '" fill="#000"/></svg>';
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Вход без кода: открываем tg://login?token=... в приложении Telegram и подтверждаем вход там
async function qrLogin(A) {
  const el = $("#login");
  el.style.display = "flex";
  el.innerHTML = '<div class="auth"><h2>Telegram You</h2>' +
    "<p>Откройте этот сайт на другом экране (компьютер или второй телефон) и отсканируйте QR в Telegram: Настройки → Устройства → Сканировать QR.</p>" +
    '<div id="tgqr" style="margin:12px auto;max-width:280px;min-height:120px"></div>' +
    '<button class="tb aw" id="tgqback" style="margin-top:8px">Назад</button>' +
    '<div id="tgqt" style="user-select:all;word-break:break-all;font-size:10px;opacity:.4;margin-top:12px;text-align:left"></div>' +
    '<div id="tgst" style="white-space:pre-wrap;font-size:11px;opacity:.6;margin-top:12px;text-align:left"></div>' +
    '<div class="aerr" id="aerr"></div></div>';
  let link = "", pwErr = "", qerr = null, cancelled = false;
  $("#tgqback").onclick = () => { cancelled = true; location.reload(); };
  dbg("вход через приложение: ждём токен…");
  try {
    await client.signInUserWithQrCode(A, {
      qrCode: async ({ token }) => {
        link = "tg://login?token=" + b64url(token);
        const t = $("#tgqt"); if (t) t.textContent = link;
        loadQr().then((lib) => {
          const box = $("#tgqr"); if (box) box.innerHTML = qrSvg(lib, link);
          dbg("QR обновлён, сканируйте");
        }).catch((e) => dbg("ОШИБКА QR: " + e.message));
      },
      password: async () => (await ask("password", pwErr)).v,
      onError: async (e) => {
        const m = String((e && e.errorMessage) || (e && e.message) || e);
        if (m === "PASSWORD_HASH_INVALID") { pwErr = ERR[m]; return false; }
        qerr = e; return true;
      },
    });
  } catch (e) { throw qerr || e; }
  if (cancelled) throw new Error("Отменено");
}

async function connect() {
  const saved = localStorage.getItem(SKEY) || "";
  client = new TelegramClient(new StringSession(saved), API_ID, API_HASH, { connectionRetries: 5, useWSS: true });
  const el = $("#login");
  el.style.display = "flex";
  el.innerHTML = '<div class="auth"><h2>Telegram You</h2><p>Подключение к Telegram…</p><div id="tgst" style="white-space:pre-wrap;font-size:11px;opacity:.6;margin-top:12px;text-align:left"></div></div>';
  dbg("1/3 подключение к серверам Telegram…");
  await Promise.race([
    client.connect(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("Нет соединения с Telegram (таймаут 20 с). Проверьте интернет или VPN")), 20000)),
  ]);
  dbg("2/3 соединение есть");

  if (!(await client.checkAuthorization())) {
    const A = { apiId: API_ID, apiHash: API_HASH };
    let err = "";
    outer: while (true) {
      // шаг 1: номер + отправка кода
      let phone, hash, info;
      while (true) {
        const a0 = await ask("phone", err); err = "";
        if (a0.qr) {
          try { await qrLogin(A); break outer; } catch (e) { err = tr(e); continue; }
        }
        phone = cleanPhone(a0.v);
        dbg("запрос кода на " + phone + "…");
        try {
          const r = await client.sendCode(A, phone);
          dbg("3/3 код запрошен. В приложение: " + (r.isCodeViaApp ? "да" : "нет (SMS)"));
          hash = r.phoneCodeHash;
          info = { type: r.isCodeViaApp ? "app" : "sms", next: "" };
          break;
        } catch (e) { err = tr(e); }
      }
      // шаг 2: код / повтор / смена номера
      while (true) {
        const a = await ask("code", err, info); err = "";
        if (a.back) continue outer;
        if (a.resend) {
          try {
            const r = await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: hash }));
            dbg("повтор: способ=" + typeName(r.type) + ", дальше=" + (typeName(r.nextType) || "нет"));
            hash = r.phoneCodeHash || hash;
            info = { type: typeName(r.type) || "other", next: typeName(r.nextType) };
            err = "Код отправлен повторно";
          } catch (e) { err = tr(e); }
          continue;
        }
        try {
          const res = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: a.v }));
          if (res && res.className === "auth.AuthorizationSignUpRequired") {
            err = "Этот номер не зарегистрирован в Telegram. Сначала зарегистрируйтесь в официальном приложении";
            continue outer;
          }
          break outer;
        } catch (e) {
          if (e && e.errorMessage === "SESSION_PASSWORD_NEEDED") {
            await signInPassword(A);
            break outer;
          }
          err = tr(e);
          if (e && e.errorMessage === "PHONE_CODE_EXPIRED") info = { type: info.type, next: info.next };
        }
      }
    }
  }
  localStorage.setItem(SKEY, client.session.save());
}

/* ---------- локальная «база» профиля в режиме Telegram ----------
   В режиме Telegram нет входа в Firebase (auth = null), поэтому любая запись
   в Firebase даёт permission denied. Подменяем db на локальное хранилище. */
const LKEY = "tgyou_local_db";
let LDB = null;
function mkLocalDb() {
  let tree = {};
  try { tree = JSON.parse(localStorage.getItem(LKEY) || "{}") || {}; } catch (e) {}
  const keys = (p) => String(p || "").split("/").filter(Boolean);
  const get = (p) => keys(p).reduce((o, k) => (o == null || typeof o !== "object" ? undefined : o[k]), tree);
  const save = () => { try { localStorage.setItem(LKEY, JSON.stringify(tree)); } catch (e) { W.toast("Не хватает памяти для сохранения"); } };
  const put = (p, v) => {
    const ks = keys(p); if (!ks.length) return;
    let o = tree;
    for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== "object") o[ks[i]] = {}; o = o[ks[i]]; }
    if (v == null) delete o[ks[ks.length - 1]]; else o[ks[ks.length - 1]] = v;
  };
  const snap = (p) => { const v = get(p); return { val: () => (v === undefined ? null : v), exists: () => v !== undefined }; };
  const ref = (p) => {
    p = p || "";
    const r = {
      key: keys(p).pop() || null,
      child: (c) => ref(p + "/" + c),
      set: (v) => { put(p, v); save(); return Promise.resolve(); },
      update: (u) => { Object.keys(u || {}).forEach((k) => put(p + "/" + k, u[k])); save(); return Promise.resolve(); },
      remove: () => { put(p, null); save(); return Promise.resolve(); },
      once: () => Promise.resolve(snap(p)),
      on: () => {}, off: () => {},
      push: () => ref(p + "/" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      transaction: (fn) => {
        const cur = get(p); const nv = fn(cur === undefined ? null : cur);
        if (nv !== undefined) { put(p, nv); save(); }
        return Promise.resolve({ committed: nv !== undefined, snapshot: snap(p) });
      },
      onDisconnect: () => ({ set: () => Promise.resolve(), remove: () => Promise.resolve() }),
    };
    r.limitToLast = () => r;
    return r;
  };
  return { ref, val: (p) => { const v = get(p); return v === undefined ? null : v; } };
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
  let me;
  try { me = await client.getMe(); } catch (e) {
    console.error("[TG] getMe failed", e);
    localStorage.removeItem(SKEY); TGM = false;
    W.showLogin("auth"); W.aerr && W.aerr({ message: "Сессия недействительна, войдите заново" });
    return;
  }
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ") || me.username || "Я";
  W.ME = { uid: "me", name, email: me.phone ? "+" + me.phone : "" };
  TGME = W.ME;
  W.S.name = name;
  W.S.phone = W.ME.email;
  LDB = LDB || mkLocalDb();
  W.db = LDB; // профиль, аватар и фон хранятся локально, без Firebase
  const lu = LDB.val("users/me") || {};
  W.S.me = { name: lu.name || name, username: lu.username || me.username || "", bio: lu.bio || "", bday: lu.bday || null, priv: lu.priv || {}, blocked: lu.blocked || {} };
  if (lu.avatar) W.S.me.avatar = lu.avatar;
  W.S.name = W.S.me.name;
  W.S.cover = LDB.val("covers/me") || null; W.S.tab = "chats"; W.S.open = null; W.S.chats = [];
  W.S.admin = false;
  $("#login").style.display = "none";
  W.renderMain();
  client.downloadProfilePhoto("me", { isBig: false }).then((b) => {
    if (b && b.length && !W.S.me.avatar) { W.S.me.avatar = "data:image/jpeg;base64," + btoa(String.fromCharCode(...new Uint8Array(b))); W.refreshMe(); }
  }).catch(() => {});
  try { await loadDialogs(); } catch (e) { console.error("[TG] dialogs", e); W.toast("Не удалось загрузить чаты"); }
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

function addTgBtn() {
  if (TGM) return;
  const lg = $("#login");
  if (!lg || getComputedStyle(lg).display === "none") return;
  const el = lg.querySelector(".auth");
  if (!el || el.querySelector("#tgstart")) return;
  const b = document.createElement("button");
  b.id = "tgstart"; b.className = "tb f aw"; b.style.marginTop = "12px"; b.textContent = "Войти через Telegram";
  b.onclick = startTG;
  const er = el.querySelector("#aerr");
  if (er) el.insertBefore(b, er); else el.appendChild(b);
}

function patch() {
  const O = {};
  ["hideBan", "showLogin", "openChat", "pushMsg", "pushTo", "sbClick", "markRead", "doDel", "logout", "getMedia",
    "react", "pinMsg", "setTyping", "typingPing", "startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat"].forEach((n) => { O[n] = W[n]; });

  W.showLogin = function (step, mode) {
    if (TGM) return; // Firebase не должен перекрывать вход через Telegram
    O.showLogin(step, mode);
    addTgBtn();
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
      localStorage.removeItem(SKEY); localStorage.removeItem(LKEY); location.reload();
    });
  };

  ["startCall", "newChatDlg", "toggleBlock", "clearHist", "delChat"].forEach((n) => {
    W[n] = function () { return TGM ? NOPE() : O[n].apply(this, arguments); };
  });
}

/* ---------- автозапуск ---------- */
function boot() {
  patch();
  setInterval(addTgBtn, 600); // кнопка входа через Telegram всегда на экране входа
  if (localStorage.getItem(SKEY)) {
    // есть сохранённая сессия Telegram – входим автоматически
    const t = setInterval(() => { if (typeof W.S === "object" && W.chat) { clearInterval(t); startTG(); } }, 50);
  }
}
boot();
