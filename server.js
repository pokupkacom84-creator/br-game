
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ====== КОНСТАНТЫ ======
const WORLD = 3200;
const ZONE_START_R = 1500;
const ZONE_END_R = 120;
const ZONE_SHRINK = 22;         // px/сек
const TICK_MS = 50;             // 20 Hz
const MAX_PLAYERS = 10;
const COUNTDOWN_MS = 5000;

// ====== КОМНАТЫ ======
const rooms = new Map();

function genCode(){
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<5;i++) s += c[Math.floor(Math.random()*c.length)];
  return s;
}

function makeRoom(){
  let code;
  do { code = genCode(); } while (rooms.has(code));
  const room = {
    code,
    hostId: null,
    state: 'lobby',                   // lobby | countdown | playing | ended
    players: new Map(),               // socketId -> player
    zone: { x: WORLD/2, y: WORLD/2, r: ZONE_START_R },
    countdownEnds: 0,
    tickTimer: null,
    zoneTimer: null,
    startedAt: 0
  };
  rooms.set(code, room);
  return room;
}

function publicPlayers(room){
  const arr = [];
  for (const [id, p] of room.players){
    arr.push({
      id, name: p.name, x: p.x, y: p.y, angle: p.angle,
      hp: p.hp, alive: p.alive, weapon: p.weapon, kills: p.kills
    });
  }
  return arr;
}

function broadcastRoom(room){
  io.to(room.code).emit('room', {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    players: publicPlayers(room),
    zone: room.zone,
    countdownEnds: room.countdownEnds
  });
}

function stopMatch(room){
  if (room.tickTimer) clearInterval(room.tickTimer);
  if (room.zoneTimer) clearInterval(room.zoneTimer);
  room.tickTimer = null;
  room.zoneTimer = null;
}

function destroyRoom(room){
  stopMatch(room);
  io.to(room.code).emit('room-destroyed');
  rooms.delete(room.code);
}

// ====== ИГРОВОЙ ЦИКЛ ======
function startMatch(room){
  room.state = 'countdown';
  room.countdownEnds = Date.now() + COUNTDOWN_MS;
  room.zone = { x: WORLD/2, y: WORLD/2, r: ZONE_START_R };

  // спавн по кругу
  const list = [...room.players.values()];
  list.forEach((p, i) => {
    const a = (i / list.length) * Math.PI * 2 + Math.random()*0.3;
    const r = 900 + Math.random()*300;
    p.x = WORLD/2 + Math.cos(a)*r;
    p.y = WORLD/2 + Math.sin(a)*r;
    p.hp = 100;
    p.alive = true;
    p.kills = 0;
    p.weapon = 'pistol';
    p.angle = 0;
  });

  broadcastRoom(room);

  setTimeout(() => {
    if (room.state !== 'countdown') return;
    room.state = 'playing';
    room.startedAt = Date.now();
    broadcastRoom(room);

    // тик зоны + счётчик
    room.zoneTimer = setInterval(() => {
      if (room.state !== 'playing') return;
      room.zone.r = Math.max(ZONE_END_R, room.zone.r - ZONE_SHRINK * (TICK_MS/1000));

      // урон от зоны
      let changed = false;
      for (const p of room.players.values()){
        if (!p.alive) continue;
        const d = Math.hypot(p.x - room.zone.x, p.y - room.zone.y);
        if (d > room.zone.r){
          p.hp = Math.max(0, p.hp - 7 * (TICK_MS/1000));
          changed = true;
          if (p.hp <= 0){
            p.alive = false;
            io.to(room.code).emit('kill', { killer: 'ZONE', victim: p.id, victimName: p.name });
          }
        }
      }
      if (changed) broadcastRoom(room);

      // проверка победы
      const alive = [...room.players.values()].filter(p => p.alive);
      if (alive.length <= 1 && room.state === 'playing'){
        room.state = 'ended';
        broadcastRoom(room);
        stopMatch(room);
        setTimeout(() => {
          if (room.state !== 'ended') return;
          // возврат в лобби
          for (const p of room.players.values()){
            p.alive = true; p.hp = 100; p.kills = 0;
            p.x = WORLD/2; p.y = WORLD/2;
          }
          room.state = 'lobby';
          room.zone = { x: WORLD/2, y: WORLD/2, r: ZONE_START_R };
          broadcastRoom(room);
        }, 6000);
      }
    }, TICK_MS);
  }, COUNTDOWN_MS);
}

// ====== SOCKET.IO ======
io.on('connection', socket => {
  console.log('connected', socket.id);
  let room = null;

  socket.on('create-room', ({ name }, cb) => {
    if (room) return cb({ error: 'Уже в комнате' });
    const r = makeRoom();
    const cleanName = String(name || 'Player').slice(0,12);

    const p = {
      id: socket.id, name: cleanName,
      x: WORLD/2, y: WORLD/2, angle: 0,
      hp: 100, alive: true, weapon: 'pistol', kills: 0
    };
    r.players.set(socket.id, p);
    r.hostId = socket.id;

    room = r;
    socket.join(r.code);
    cb({ ok: true, code: r.code, you: socket.id });
    broadcastRoom(r);
  });

  socket.on('join-room', ({ name, code }, cb) => {
    if (room) return cb({ error: 'Уже в комнате' });
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return cb({ error: 'Комната не найдена' });
    if (r.players.size >= MAX_PLAYERS) return cb({ error: 'Комната заполнена' });
    if (r.state !== 'lobby') return cb({ error: 'Матч уже идёт' });

    const cleanName = String(name || 'Player').slice(0,12);
    const p = {
      id: socket.id, name: cleanName,
      x: WORLD/2, y: WORLD/2, angle: 0,
      hp: 100, alive: true, weapon: 'pistol', kills: 0
    };
    r.players.set(socket.id, p);
    room = r;
    socket.join(r.code);
    cb({ ok: true, code: r.code, you: socket.id });
    broadcastRoom(r);
  });

  socket.on('start-match', () => {
    if (!room || room.hostId !== socket.id) return;
    if (room.state !== 'lobby') return;
    if (room.players.size < 2) return;
    startMatch(room);
  });

  // клиент присылает своё состояние ~20 раз/сек
  socket.on('state', s => {
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p || !p.alive) return;
    p.x = s.x; p.y = s.y; p.angle = s.angle;
    // не релеим сразу — рассылка в тике
  });

  // смена оружия
  socket.on('weapon', wk => {
    if (!room || room.state !== 'playing') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.weapon = wk;
    broadcastRoom(room);
  });

  // выстрел — просто релей для визуала у остальных
  socket.on('shot', s => {
    if (!room || room.state !== 'playing') return;
    socket.to(room.code).emit('shot', {
      owner: socket.id, x: s.x, y: s.y, angle: s.angle, weapon: s.weapon
    });
  });

  // попадание — стреляющий сообщает серверу
  socket.on('hit', ({ targetId, dmg }) => {
    if (!room || room.state !== 'playing') return;
    const shooter = room.players.get(socket.id);
    const target = room.players.get(targetId);
    if (!shooter || !target || !target.alive || !shooter.alive) return;
    if (shooter.id === target.id) return;

    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp <= 0){
      target.alive = false;
      shooter.kills++;
      io.to(room.code).emit('kill', {
        killer: shooter.id, killerName: shooter.name,
        victim: target.id, victimName: target.name
      });
    }
    broadcastRoom(room);
  });

  socket.on('leave', () => handleLeave());
  socket.on('disconnect', () => handleLeave());

  function handleLeave(){
    if (!room) return;
    const wasHost = room.hostId === socket.id;
    room.players.delete(socket.id);
    socket.leave(room.code);

    if (room.players.size === 0){
      destroyRoom(room);
      room = null;
      return;
    }

    if (wasHost){
      // передаём хоста первому
      room.hostId = room.players.keys().next().value;
    }
    if (room.state === 'playing' || room.state === 'countdown'){
      // если остался один — завершаем
      const alive = [...room.players.values()].filter(p => p.alive);
      if (alive.length <= 1) {
        // игровой цикл сам обработает
      }
    }
    broadcastRoom(room);
    room = null;
  }
});

// ====== ЗАПУСК ======
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log('Server on port ' + PORT));
