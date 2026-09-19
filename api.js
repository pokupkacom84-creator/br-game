// ============================================================================
// FLUX CLIENT API — заменяет Firebase
// ============================================================================
(function(global){
  'use strict';

  var API_URL = global.FLUX_API_URL || 'http://localhost:3000';
  var SOCKET_URL = API_URL;

  var state = {
    token: localStorage.getItem('flux_token') || null,
    user: null,
    socket: null,
    listeners: new Map(),
    chatListeners: new Map(),
    chats: new Map(),
    users: new Map(),
    unreadTotal: 0
  };

  function emit(event, data){
    var set = state.listeners.get(event);
    if(!set) return;
    set.forEach(fn => { try{ fn(data); }catch(e){ console.error(e); } });
  }

  function on(event, fn){
    if(!state.listeners.has(event)) state.listeners.set(event, new Set());
    state.listeners.get(event).add(fn);
    return () => state.listeners.get(event).delete(fn);
  }

  async function request(method, path, body){
    var headers = { 'Content-Type': 'application/json' };
    if(state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var res = await fetch(API_URL + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined
    });
    if(res.status === 401){ logout(); throw new Error('unauthorized'); }
    var data = await res.json().catch(() => ({}));
    if(!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, data });
    return data;
  }

  // ====================== AUTH ======================
  async function register(email, password){
    var r = await request('POST', '/api/auth/register', { email, password });
    state.token = r.token; state.user = r.user;
    localStorage.setItem('flux_token', r.token);
    connectSocket();
    emit('auth', r.user);
    return r.user;
  }

  async function login(email, password){
    var r = await request('POST', '/api/auth/login', { email, password });
    state.token = r.token; state.user = r.user;
    localStorage.setItem('flux_token', r.token);
    connectSocket();
    emit('auth', r.user);
    return r.user;
  }

  function logout(){
    if(state.socket){ state.socket.disconnect(); state.socket = null; }
    state.token = null; state.user = null;
    localStorage.removeItem('flux_token');
    emit('auth', null);
  }

  async function restoreSession(){
    if(!state.token) return null;
    try{
      var r = await request('GET', '/api/users/me');
      state.user = r.user;
      connectSocket();
      emit('auth', r.user);
      return r.user;
    } catch(e){ logout(); return null; }
  }

  // ====================== USERS ======================
  async function me(){ return (await request('GET', '/api/users/me')).user; }

  async function updateMe(patch){
    var r = await request('PATCH', '/api/users/me', patch);
    state.user = r.user;
    emit('me:updated', r.user);
    return r.user;
  }

  async function searchUsers(q){ return (await request('GET', '/api/users/search?q=' + encodeURIComponent(q))).users; }

  async function getUser(uid){
    if(state.users.has(uid)) return state.users.get(uid);
    var u = (await request('GET', '/api/users/' + uid)).user;
    state.users.set(uid, u);
    return u;
  }

  async function getUsers(uids){
    var need = uids.filter(u => !state.users.has(u));
    if(need.length){
      var r = await request('GET', '/api/users/batch?uids=' + need.join(','));
      r.users.forEach(u => state.users.set(u.uid, u));
    }
    return uids.map(u => state.users.get(u)).filter(Boolean);
  }

  // ====================== CHATS ======================
  async function listChats(){
    var r = await request('GET', '/api/chats');
    state.chats.clear();
    r.chats.forEach(c => state.chats.set(c.id, c));
    emit('chats', r.chats);
    return r.chats;
  }

  async function openDirect(otherUid){
    var r = await request('POST', '/api/chats/direct/' + otherUid);
    return r.chatId;
  }

  async function getChatMeta(chatId){ return (await request('GET', '/api/chats/' + chatId + '/meta')).meta; }
  async function togglePin(chatId){ return request('PATCH', '/api/chats/' + chatId + '/pin'); }
  async function toggleArchive(chatId){ return request('PATCH', '/api/chats/' + chatId + '/archive'); }
  async function setFolder(chatId, folder){ return request('PATCH', '/api/chats/' + chatId + '/folder', { folder }); }
  async function deleteChat(chatId){ return request('DELETE', '/api/chats/' + chatId); }
  async function clearChat(chatId){ return request('POST', '/api/chats/' + chatId + '/clear'); }
  async function markRead(chatId){ return request('POST', '/api/chats/' + chatId + '/read'); }
  async function pinMessage(chatId, msg){ return request('POST', '/api/chats/' + chatId + '/pin-message', { pinned: msg }); }

  // ====================== MESSAGES ======================
  async function getMessages(chatId, opts){
    opts = opts || {};
    var qs = '?limit=' + (opts.limit || 50);
    if(opts.before) qs += '&before=' + encodeURIComponent(opts.before);
    return (await request('GET', '/api/chats/' + chatId + '/messages' + qs)).messages;
  }

  async function sendMessage(chatId, msg){
    var r = await request('POST', '/api/chats/' + chatId + '/messages', msg);
    return r.message;
  }

  async function editMessage(msgId, text){
    return request('PATCH', '/api/messages/' + msgId, { text });
  }

  async function deleteMessage(msgId, mode){
    return request('DELETE', '/api/messages/' + msgId + '?mode=' + (mode || 'all'));
  }

  async function reactToMessage(msgId, emoji){
    return request('POST', '/api/messages/' + msgId + '/reactions', { emoji });
  }

  // ====================== DRAFTS ======================
  async function listDrafts(){ return (await request('GET', '/api/drafts')).drafts; }
  async function saveDraft(chatId, text){ return request('PUT', '/api/drafts/' + chatId, { text }); }

  // ====================== SOCKET ======================
  function connectSocket(){
    if(state.socket || !state.token) return;
    if(typeof io === 'undefined'){ console.warn('Socket.IO client not loaded'); return; }
    state.socket = io(SOCKET_URL, {
      auth: { token: state.token },
      transports: ['websocket','polling'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    state.socket.on('connect', () => {
      emit('socket:connected');
      // Переподписка на чаты
      state.chats.forEach(c => state.socket.emit('chat:join', c.id));
    });
    state.socket.on('disconnect', (r) => emit('socket:disconnected', r));
    state.socket.on('message:new', (m) => {
      emit('message:new', m);
      var chatId = m.chatId;
      var arr = state.chatListeners.get(chatId);
      if(arr) arr.forEach(fn => { try{ fn(m); }catch(e){} });
      // Обновляем локальный unread
      if(m.senderId !== (state.user && state.user.uid)){
        var c = state.chats.get(chatId);
        if(c){ c.unread = (c.unread || 0) + 1; c.lastMessage = m.text || ''; c.lastMessageTime = m.timestamp; }
      }
      emit('chats', Array.from(state.chats.values()));
    });
    state.socket.on('message:edit', (m) => emit('message:edit', m));
    state.socket.on('message:delete', (m) => emit('message:delete', m));
    state.socket.on('message:reaction', (r) => emit('message:reaction', r));
    state.socket.on('typing', (t) => emit('typing', t));
    state.socket.on('presence', (p) => {
      if(state.users.has(p.uid)){ var u = state.users.get(p.uid); u.online = p.online; u.lastSeen = p.at; }
      emit('presence', p);
    });
    state.socket.on('chat:read', (r) => emit('chat:read', r));
    state.socket.on('chat:pinned', (r) => emit('chat:pinned', r));
    state.socket.on('chat:new', (r) => { emit('chat:new', r); listChats().catch(()=>{}); });
  }

  function emitTyping(chatId){
    if(state.socket && state.socket.connected) state.socket.emit('typing', { chatId });
  }

  function joinChatRoom(chatId){
    if(state.socket && state.socket.connected) state.socket.emit('chat:join', chatId);
  }
  function leaveChatRoom(chatId){
    if(state.socket && state.socket.connected) state.socket.emit('chat:leave', chatId);
  }

  function onMessage(chatId, fn){
    if(!state.chatListeners.has(chatId)) state.chatListeners.set(chatId, new Set());
    state.chatListeners.get(chatId).add(fn);
    return () => { var s = state.chatListeners.get(chatId); if(s) s.delete(fn); };
  }

  // ====================== EXPORT ======================
  global.FluxAPI = {
    state, on, emit,
    register, login, logout, restoreSession,
    me, updateMe, searchUsers, getUser, getUsers,
    listChats, openDirect, getChatMeta, togglePin, toggleArchive, setFolder,
    deleteChat, clearChat, markRead, pinMessage,
    getMessages, sendMessage, editMessage, deleteMessage, reactToMessage,
    listDrafts, saveDraft,
    connectSocket, emitTyping, joinChatRoom, leaveChatRoom, onMessage
  };
})(window);
