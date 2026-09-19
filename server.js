// ============================================================================
// FLUX SERVER — MongoDB + Socket.IO
// ============================================================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '30d';

// ============================ MODELS ============================
const UserSchema = new mongoose.Schema({
  uid: { type: String, default: () => uuidv4(), unique: true, index: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  passwordHash: { type: String, required: true },
  name: { type: String, default: '' },
  username: { type: String, unique: true, sparse: true, lowercase: true, index: true },
  avatarId: { type: String, default: 'a1' },
  photoURL: { type: String, default: '' },
  bio: { type: String, default: '' },
  status: { type: String, default: '' },
  pubkey: { type: Object, default: null },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  hideOnline: { type: Boolean, default: false }
}, { timestamps: true });

const ChatSchema = new mongoose.Schema({
  type: { type: String, enum: ['direct','group','channel','saved'], default: 'direct' },
  members: [{ type: String, index: true }],
  admins: [{ type: String }],
  name: { type: String, default: '' },
  avatarId: { type: String, default: '' },
  pinned: { type: Object, default: null },
  enc: { type: Object, default: null }
}, { timestamps: true });

const MessageSchema = new mongoose.Schema({
  chatId: { type: String, required: true, index: true },
  senderId: { type: String, required: true, index: true },
  type: { type: String, default: 'text' },
  text: { type: String, default: '' },
  ciphertext: { type: String, default: '' },
  iv: { type: String, default: '' },
  encrypted: { type: Boolean, default: false },
  replyTo: { type: Object, default: null },
  forwardedFrom: { type: Object, default: null },
  reactions: { type: Object, default: {} },
  deleted: { type: Boolean, default: false },
  deletedFor: [{ type: String }],
  editedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
MessageSchema.index({ chatId: 1, createdAt: -1 });

const UserChatSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  chatId: { type: String, required: true, index: true },
  otherUid: { type: String, default: '' },
  lastMessage: { type: String, default: '' },
  lastMessageTime: { type: Date, default: Date.now, index: true },
  lastSender: { type: String, default: '' },
  lastType: { type: String, default: 'text' },
  unread: { type: Number, default: 0 },
  pinned: { type: Boolean, default: false },
  archived: { type: Boolean, default: false },
  folder: { type: String, default: 'personal' },
  clearedAt: { type: Date, default: null }
}, { timestamps: true });
UserChatSchema.index({ userId: 1, chatId: 1 }, { unique: true });

const DraftSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  chatId: { type: String, required: true, index: true },
  text: { type: String, default: '' },
  ts: { type: Date, default: Date.now }
}, { timestamps: true });
DraftSchema.index({ userId: 1, chatId: 1 }, { unique: true });

const User = mongoose.model('User', UserSchema);
const Chat = mongoose.model('Chat', ChatSchema);
const Message = mongoose.model('Message', MessageSchema);
const UserChat = mongoose.model('UserChat', UserChatSchema);
const Draft = mongoose.model('Draft', DraftSchema);

// ============================ APP ============================
const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));

const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 30, message: 'Слишком много попыток' });
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 300 });

function signToken(user){
  return jwt.sign({ uid: user.uid, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function authMiddleware(req, res, next){
  var h = req.headers.authorization || '';
  var token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'no_token' });
  try{
    var payload = jwt.verify(token, JWT_SECRET);
    req.uid = payload.uid;
    next();
  } catch(e){ res.status(401).json({ error: 'invalid_token' }); }
}

function publicUser(u){
  if(!u) return null;
  return {
    uid: u.uid, name: u.name, username: u.username, avatarId: u.avatarId,
    photoURL: u.photoURL, bio: u.bio, status: u.status,
    online: u.online, lastSeen: u.lastSeen, hideOnline: u.hideOnline, pubkey: u.pubkey
  };
}

// ============================ AUTH ============================
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try{
    var { email, password } = req.body;
    if(!email || !password || password.length < 6) return res.status(400).json({ error: 'invalid' });
    var exists = await User.findOne({ email: email.toLowerCase() });
    if(exists) return res.status(409).json({ error: 'email_taken' });
    var passwordHash = await bcrypt.hash(password, 10);
    var user = await User.create({ email: email.toLowerCase(), passwordHash });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch(e){ console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try{
    var { email, password } = req.body;
    var user = await User.findOne({ email: (email||'').toLowerCase() });
    if(!user) return res.status(404).json({ error: 'user_not_found' });
    var ok = await bcrypt.compare(password, user.passwordHash);
    if(!ok) return res.status(401).json({ error: 'wrong_password' });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch(e){ console.error(e); res.status(500).json({ error: 'server' }); }
});

// ============================ USERS ============================
app.get('/api/users/me', authMiddleware, async (req, res) => {
  var u = await User.findOne({ uid: req.uid });
  res.json({ user: publicUser(u) });
});

app.patch('/api/users/me', authMiddleware, async (req, res) => {
  try{
    var patch = {};
    ['name','avatarId','photoURL','bio','status','hideOnline','pubkey'].forEach(k => {
      if(req.body[k] !== undefined) patch[k] = req.body[k];
    });
    if(req.body.username !== undefined){
      var uname = String(req.body.username).toLowerCase().replace(/^@/,'');
      if(!/^[a-z0-9_]{3,32}$/.test(uname)) return res.status(400).json({ error: 'invalid_username' });
      var taken = await User.findOne({ username: uname, uid: { $ne: req.uid } });
      if(taken) return res.status(409).json({ error: 'username_taken' });
      patch.username = uname;
    }
    var u = await User.findOneAndUpdate({ uid: req.uid }, patch, { new: true });
    res.json({ user: publicUser(u) });
  } catch(e){ res.status(500).json({ error: 'server' }); }
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  var q = String(req.query.q || '').trim().toLowerCase().replace(/^@/,'');
  if(q.length < 1) return res.json({ users: [] });
  var users = await User.find({
    username: new RegExp('^' + q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')),
    uid: { $ne: req.uid }
  }).limit(30).select('uid name username avatarId photoURL bio status online lastSeen hideOnline');
  res.json({ users: users.map(publicUser) });
});

app.get('/api/users/batch', authMiddleware, async (req, res) => {
  var uids = String(req.query.uids || '').split(',').filter(Boolean).slice(0, 200);
  if(!uids.length) return res.json({ users: [] });
  var users = await User.find({ uid: { $in: uids } }).select('uid name username avatarId photoURL bio status online lastSeen hideOnline');
  res.json({ users: users.map(publicUser) });
});

app.get('/api/users/:uid', authMiddleware, async (req, res) => {
  var u = await User.findOne({ uid: req.params.uid });
  if(!u) return res.status(404).json({ error: 'not_found' });
  res.json({ user: publicUser(u) });
});

// ============================ CHATS ============================
app.get('/api/chats', authMiddleware, async (req, res) => {
  var list = await UserChat.find({ userId: req.uid }).sort({ pinned: -1, lastMessageTime: -1 }).lean();
  res.json({ chats: list.map(c => ({
    id: c.chatId, otherUid: c.otherUid, lastMessage: c.lastMessage,
    lastMessageTime: c.lastMessageTime, lastSender: c.lastSender,
    lastType: c.lastType, unread: c.unread, pinned: c.pinned,
    archived: c.archived, folder: c.folder, clearedAt: c.clearedAt
  }))});
});

app.post('/api/chats/direct/:uid', authMiddleware, async (req, res) => {
  try{
    var other = req.params.uid;
    if(other === req.uid) return res.status(400).json({ error: 'self' });
    var members = [req.uid, other].sort();
    var existing = await Chat.findOne({ type: 'direct', members: { $all: members, $size: 2 } });
    if(existing){
      return res.json({ chatId: existing._id.toString() });
    }
    var chat = await Chat.create({ type: 'direct', members });
    var chatId = chat._id.toString();
    await UserChat.insertMany([
      { userId: req.uid, chatId, otherUid: other, lastMessageTime: new Date() },
      { userId: other, chatId, otherUid: req.uid, lastMessageTime: new Date() }
    ]);
    broadcastToUser(other, 'chat:new', { chatId, fromUid: req.uid });
    res.json({ chatId });
  } catch(e){ console.error(e); res.status(500).json({ error: 'server' }); }
});

app.get('/api/chats/:id/meta', authMiddleware, async (req, res) => {
  var chat = await Chat.findById(req.params.id).lean();
  if(!chat) return res.status(404).json({ error: 'not_found' });
  res.json({ meta: chat });
});

app.patch('/api/chats/:id/pin', authMiddleware, async (req, res) => {
  var uc = await UserChat.findOne({ userId: req.uid, chatId: req.params.id });
  if(!uc) return res.status(404).json({ error: 'not_found' });
  uc.pinned = !uc.pinned;
  await uc.save();
  res.json({ pinned: uc.pinned });
});

app.patch('/api/chats/:id/archive', authMiddleware, async (req, res) => {
  var uc = await UserChat.findOne({ userId: req.uid, chatId: req.params.id });
  if(!uc) return res.status(404).json({ error: 'not_found' });
  uc.archived = !uc.archived;
  await uc.save();
  res.json({ archived: uc.archived });
});

app.patch('/api/chats/:id/folder', authMiddleware, async (req, res) => {
  var uc = await UserChat.findOne({ userId: req.uid, chatId: req.params.id });
  if(!uc) return res.status(404).json({ error: 'not_found' });
  uc.folder = String(req.body.folder || 'personal');
  await uc.save();
  res.json({ folder: uc.folder });
});

app.delete('/api/chats/:id', authMiddleware, async (req, res) => {
  await UserChat.deleteOne({ userId: req.uid, chatId: req.params.id });
  res.json({ ok: true });
});

app.post('/api/chats/:id/clear', authMiddleware, async (req, res) => {
  await UserChat.updateOne({ userId: req.uid, chatId: req.params.id }, { clearedAt: new Date(), unread: 0 });
  res.json({ ok: true });
});

// ============================ MESSAGES ============================
app.get('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  try{
    var limit = Math.min(parseInt(req.query.limit) || 50, 100);
    var q = { chatId: req.params.id, deletedFor: { $ne: req.uid } };
    if(req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
    var uc = await UserChat.findOne({ userId: req.uid, chatId: req.params.id });
    if(uc && uc.clearedAt) q.createdAt = Object.assign(q.createdAt || {}, { $gt: uc.clearedAt });
    var msgs = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    msgs.reverse();
    res.json({ messages: msgs.map(m => ({
      id: m._id.toString(), senderId: m.senderId, type: m.type,
      text: m.text, ciphertext: m.ciphertext, iv: m.iv, encrypted: m.encrypted,
      replyTo: m.replyTo, forwardedFrom: m.forwardedFrom, reactions: m.reactions,
      editedAt: m.editedAt, timestamp: m.createdAt.getTime()
    }))});
  } catch(e){ console.error(e); res.status(500).json({ error: 'server' }); }
});

app.post('/api/chats/:id/messages', authMiddleware, async (req, res) => {
  try{
    var chat = await Chat.findById(req.params.id);
    if(!chat) return res.status(404).json({ error: 'not_found' });
    if(!chat.members.includes(req.uid)) return res.status(403).json({ error: 'not_member' });
    if(chat.type === 'channel' && !chat.admins.includes(req.uid)) return res.status(403).json({ error: 'not_admin' });

    var body = req.body || {};
    var msg = await Message.create({
      chatId: req.params.id, senderId: req.uid,
      type: body.type || 'text', text: body.text || '',
      ciphertext: body.ciphertext || '', iv: body.iv || '',
      encrypted: !!body.encrypted,
      replyTo: body.replyTo || null,
      forwardedFrom: body.forwardedFrom || null
    });
    var preview = msg.type === 'sticker' ? ('Стикер ' + msg.text) : (msg.text || 'Вложение').slice(0, 80);

    // Обновляем UserChat у всех участников
    var updates = chat.members.map(uid => {
      var isMine = uid === req.uid;
      return UserChat.updateOne(
        { userId: uid, chatId: req.params.id },
        {
          $set: { lastMessage: preview, lastMessageTime: msg.createdAt, lastSender: req.uid, lastType: msg.type, otherUid: uid === req.uid ? (chat.members.find(m => m !== uid) || '') : req.uid },
          ...(isMine ? { $set_unread: 0 } : { $inc: { unread: 1 } })
        },
        { upsert: true }
      );
    });
    // Fix: unread=0 for sender, inc for others
    await UserChat.updateOne({ userId: req.uid, chatId: req.params.id }, { unread: 0 });
    await Promise.all(chat.members.filter(u => u !== req.uid).map(uid =>
      UserChat.updateOne({ userId: uid, chatId: req.params.id }, { $inc: { unread: 1 } }, { upsert: true })
    ));

    var payload = {
      id: msg._id.toString(), chatId: req.params.id, senderId: req.uid,
      type: msg.type, text: msg.text, ciphertext: msg.ciphertext, iv: msg.iv,
      encrypted: msg.encrypted, replyTo: msg.replyTo, forwardedFrom: msg.forwardedFrom,
      reactions: {}, editedAt: null, timestamp: msg.createdAt.getTime()
    };
    chat.members.forEach(uid => broadcastToUser(uid, 'message:new', payload));
    res.json({ message: payload });
  } catch(e){ console.error(e); res.status(500).json({ error: 'server' }); }
});

app.patch('/api/messages/:id', authMiddleware, async (req, res) => {
  var msg = await Message.findById(req.params.id);
  if(!msg) return res.status(404).json({ error: 'not_found' });
  if(msg.senderId !== req.uid) return res.status(403).json({ error: 'not_owner' });
  if(req.body.text !== undefined) msg.text = req.body.text;
  msg.editedAt = new Date();
  await msg.save();
  var chat = await Chat.findById(msg.chatId);
  chat.members.forEach(uid => broadcastToUser(uid, 'message:edit', { id: msg._id.toString(), chatId: msg.chatId, text: msg.text, editedAt: msg.editedAt }));
  res.json({ ok: true });
});

app.delete('/api/messages/:id', authMiddleware, async (req, res) => {
  var msg = await Message.findById(req.params.id);
  if(!msg) return res.status(404).json({ error: 'not_found' });
  var mode = req.query.mode || 'all';
  if(mode === 'me'){
    if(!msg.deletedFor.includes(req.uid)) msg.deletedFor.push(req.uid);
    await msg.save();
    return res.json({ ok: true });
  }
  if(msg.senderId !== req.uid) return res.status(403).json({ error: 'not_owner' });
  msg.deleted = true; msg.text = ''; msg.replyTo = null; msg.reactions = {};
  await msg.save();
  var chat = await Chat.findById(msg.chatId);
  chat.members.forEach(uid => broadcastToUser(uid, 'message:delete', { id: msg._id.toString(), chatId: msg.chatId }));
  res.json({ ok: true });
});

app.post('/api/messages/:id/reactions', authMiddleware, async (req, res) => {
  var msg = await Message.findById(req.params.id);
  if(!msg) return res.status(404).json({ error: 'not_found' });
  var emoji = String(req.body.emoji || '');
  var current = msg.reactions[req.uid];
  if(current === emoji) delete msg.reactions[req.uid];
  else msg.reactions[req.uid] = emoji;
  msg.markModified('reactions');
  await msg.save();
  var chat = await Chat.findById(msg.chatId);
  chat.members.forEach(uid => broadcastToUser(uid, 'message:reaction', { id: msg._id.toString(), chatId: msg.chatId, reactions: msg.reactions }));
  res.json({ reactions: msg.reactions });
});

app.post('/api/chats/:id/read', authMiddleware, async (req, res) => {
  await UserChat.updateOne({ userId: req.uid, chatId: req.params.id }, { unread: 0 });
  var chat = await Chat.findById(req.params.id);
  if(chat) chat.members.forEach(uid => broadcastToUser(uid, 'chat:read', { chatId: req.params.id, by: req.uid, at: Date.now() }));
  res.json({ ok: true });
});

app.post('/api/chats/:id/pin-message', authMiddleware, async (req, res) => {
  var chat = await Chat.findById(req.params.id);
  if(!chat) return res.status(404).json({ error: 'not_found' });
  chat.pinned = req.body.pinned || null;
  await chat.save();
  chat.members.forEach(uid => broadcastToUser(uid, 'chat:pinned', { chatId: req.params.id, pinned: chat.pinned }));
  res.json({ pinned: chat.pinned });
});

// ============================ DRAFTS ============================
app.get('/api/drafts', authMiddleware, async (req, res) => {
  var drafts = await Draft.find({ userId: req.uid }).lean();
  res.json({ drafts: drafts.map(d => ({ chatId: d.chatId, text: d.text, ts: d.ts })) });
});

app.put('/api/drafts/:chatId', authMiddleware, async (req, res) => {
  var text = String(req.body.text || '');
  if(!text){ await Draft.deleteOne({ userId: req.uid, chatId: req.params.chatId }); return res.json({ ok: true }); }
  await Draft.updateOne({ userId: req.uid, chatId: req.params.chatId }, { text, ts: new Date() }, { upsert: true });
  res.json({ ok: true });
});

// ============================ HEALTH ============================
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ============================ SOCKET.IO ============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET','POST'] },
  pingInterval: 25000, pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

const userSockets = new Map(); // uid -> Set<socketId>

function broadcastToUser(uid, event, payload){
  var sids = userSockets.get(uid);
  if(!sids) return;
  sids.forEach(sid => { var s = io.sockets.sockets.get(sid); if(s) s.emit(event, payload); });
}

io.use((socket, next) => {
  var token = socket.handshake.auth && socket.handshake.auth.token;
  if(!token) return next(new Error('no_token'));
  try{
    var payload = jwt.verify(token, JWT_SECRET);
    socket.uid = payload.uid;
    next();
  } catch(e){ next(new Error('invalid_token')); }
});

io.on('connection', async (socket) => {
  var uid = socket.uid;
  if(!userSockets.has(uid)) userSockets.set(uid, new Set());
  userSockets.get(uid).add(socket.id);

  // Присоединяемся ко всем чатам
  var chats = await UserChat.find({ userId: uid }).select('chatId').lean();
  chats.forEach(c => socket.join('chat:' + c.chatId));

  // Присутствие
  await User.updateOne({ uid }, { online: true, lastSeen: new Date() });
  broadcastPresence(uid, true);

  socket.on('typing', (data) => {
    if(!data || !data.chatId) return;
    socket.to('chat:' + data.chatId).emit('typing', { chatId: data.chatId, uid, at: Date.now() });
  });

  socket.on('chat:join', (chatId) => { socket.join('chat:' + chatId); });
  socket.on('chat:leave', (chatId) => { socket.leave('chat:' + chatId); });

  socket.on('disconnect', async () => {
    var set = userSockets.get(uid);
    if(set){ set.delete(socket.id); if(!set.size) userSockets.delete(uid); }
    if(!userSockets.has(uid)){
      await User.updateOne({ uid }, { online: false, lastSeen: new Date() });
      broadcastPresence(uid, false);
    }
  });
});

async function broadcastPresence(uid, online){
  // Рассылаем всем, у кого есть чат с этим uid
  var chats = await UserChat.find({ otherUid: uid }).select('userId').lean();
  var uids = [...new Set(chats.map(c => c.userId))];
  uids.forEach(peer => broadcastToUser(peer, 'presence', { uid, online, at: Date.now() }));
}

// ============================ START ============================
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/flux')
  .then(() => {
    server.listen(PORT, () => console.log('🚀 Flux server on :' + PORT));
  })
  .catch(e => { console.error('Mongo connect failed', e); process.exit(1); });
