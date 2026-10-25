const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const webpush = require('web-push');
const zlib = require('zlib');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25e6 }); // ~18MB files after base64

// Only index.html is public (keeps server.js and data.json private)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Everything the phone needs is served from here, so there are no extra files to upload.
const SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch (err) {}
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const ios = /iPhone|iPad/.test(self.navigator.userAgent);
    if (!ios && wins.some((w) => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(d.title || 'MsgStudio', { body: d.body || '', tag: d.tag, renotify: true, icon: '/icon-192.png', badge: '/icon-192.png', data: { id: d.id } });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { await wins[0].focus(); wins[0].postMessage({ open: id }); }
    else await clients.openWindow('/?c=' + encodeURIComponent(id || ''));
  })());
});`;
app.get('/sw.js', (req, res) => res.type('js').send(SW));
app.get('/manifest.json', (req, res) => res.json({
  name: 'MsgStudio', short_name: 'MsgStudio', start_url: '/', display: 'standalone',
  background_color: '#0d1017', theme_color: '#0d1017',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
}));

// App icon drawn in code (amber chat bubble with three dots) and sent as a PNG
const crc32 = (buf) => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let r = ~0;
  for (const x of buf) r = t[(r ^ x) & 255] ^ (r >>> 8);
  return ~r >>> 0;
};
const makeIcon = (size) => {
  const row = size * 4 + 1, raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size - 0.5, v = y / size - 0.5;
    let c = [13, 16, 23];
    if (u * u + v * v < 0.32 * 0.32) c = [242, 179, 91];
    for (const dx of [-0.16, 0, 0.16]) if ((u - dx) ** 2 + v * v < 0.055 ** 2) c = [13, 16, 23];
    raw.set([c[0], c[1], c[2], 255], y * row + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const b = Buffer.concat([Buffer.from(type), data]), o = Buffer.alloc(b.length + 8);
    o.writeUInt32BE(data.length, 0); b.copy(o, 4); o.writeUInt32BE(crc32(b), b.length + 4);
    return o;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const icons = {};
app.get('/icon-:size.png', (req, res) => {
  const n = +req.params.size;
  if (![180, 192, 512].includes(n)) return res.sendStatus(404);
  res.type('png').set('Cache-Control', 'public, max-age=86400').send(icons[n] || (icons[n] = makeIcon(n)));
});

// ---- Storage: JSON file. Render's free disk is wiped on redeploy; attach a
// Render Disk and set DATA_FILE=/data/data.json to keep data permanently.
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
let db = { users: {}, sessions: {}, convs: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch {}
let timer;
const save = () => {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFile(DB_FILE, JSON.stringify(db), () => {}), 500);
};

// Private admin page: set ADMIN_KEY in Render, then visit /admin/users?key=YOUR_KEY
app.get('/admin/users', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.sendStatus(404);
  res.json(Object.values(db.users).map((u) => u.username));
});

// ---- Phone notifications (web push). The keys are made automatically the first
// time the server starts and saved with your data, so there is nothing to set up.
db.subs = db.subs || {};
if (!db.vapid) { db.vapid = webpush.generateVAPIDKeys(); save(); }
const VAPID = db.vapid;
webpush.setVapidDetails('mailto:admin@msgstudio.app', VAPID.publicKey, VAPID.privateKey);

function notify(c, msg) {
  const sender = db.users[msg.from];
  const title = c.type === 'dm' ? sender.displayName : `${sender.displayName} in ${c.name}`;
  const body = (msg.text || '📎 ' + (msg.file ? msg.file.name : '')).slice(0, 120);
  const payload = JSON.stringify({ title, body, id: c.id, tag: c.id });
  for (const m of c.members) {
    if (m === msg.from) continue;
    for (const sub of [...(db.subs[m] || [])]) {
      webpush.sendNotification(sub, payload).catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) {
          db.subs[m] = db.subs[m].filter((x) => x.endpoint !== sub.endpoint);
          save();
        }
      });
    }
  }
}

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const isOnline = (n) => (io.sockets.adapter.rooms.get('u:' + n)?.size || 0) > 0;
const pub = (u) => ({
  username: u.username, displayName: u.displayName, bio: u.bio,
  color: u.color, avatar: u.avatar, online: isOnline(u.username),
});
const view = (c) => {
  const last = c.messages[c.messages.length - 1];
  return {
    id: c.id, type: c.type, name: c.name,
    members: c.members.map((m) => pub(db.users[m])),
    last: last && { from: last.from, text: last.deleted ? 'Message deleted' : last.text, file: last.file ? last.file.name : '', ts: last.ts },
  };
};
const FILE_RE = /^data:[\w.+\/-]+;base64,[A-Za-z0-9+\/=]*$/;

// ---- Group calls (mesh WebRTC: everyone connects to everyone, so keep rooms small)
const gcalls = {}; // convId -> { video, users:Set }
const gstate = (c) => {
  const g = gcalls[c.id];
  for (const m of c.members) io.to('u:' + m).emit('gcall:state', { id: c.id, users: g ? [...g.users] : [], video: g ? g.video : false });
};
const gleave = (user, id) => {
  const g = gcalls[id];
  if (!g || !g.users.delete(user)) return;
  for (const u of g.users) io.to('u:' + u).emit('gcall:left', { id, user });
  if (!g.users.size) delete gcalls[id];
  if (db.convs[id]) gstate(db.convs[id]);
};

io.on('connection', (s) => {
  let me = null;

  const enter = (name) => {
    me = name;
    s.join('u:' + name);
    for (const c of Object.values(db.convs)) if (c.members.includes(name)) s.join('c:' + c.id);
    io.emit('presence', { username: name, online: true });
    for (const [gid, g] of Object.entries(gcalls)) {
      const gc = db.convs[gid];
      if (gc && gc.members.includes(name)) s.emit('gcall:state', { id: gid, users: [...g.users], video: g.video });
    }
  };
  const start = (name, cb, token) => {
    if (!token) {
      token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = name;
      save();
    }
    enter(name);
    cb({ ok: true, token, me: pub(db.users[name]) });
  };
  const pushConv = (c) => {
    for (const m of c.members) {
      io.in('u:' + m).socketsJoin('c:' + c.id);
      io.to('u:' + m).emit('conv', view(c));
    }
  };

  const on = (ev, fn, open) =>
    s.on(ev, (d, cb) => {
      cb = typeof cb === 'function' ? cb : () => {};
      if (!me && !open) return cb({ error: 'Please sign in again' });
      try { fn(d || {}, cb); } catch (e) { console.error(e); cb({ error: 'Server error' }); }
    });

  on('register', ({ username, password }, cb) => {
    username = String(username || '').toLowerCase().trim();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return cb({ error: 'Username must be 3-20 letters, numbers or underscores' });
    if (String(password || '').length < 6) return cb({ error: 'Password must be at least 6 characters' });
    if (db.users[username]) return cb({ error: 'That username is taken' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[username] = {
      username, salt, hash: hashPw(password, salt),
      displayName: username, bio: '', color: '#f2b35b', avatar: '',
    };
    start(username, cb);
  }, true);

  on('login', ({ username, password }, cb) => {
    const u = db.users[String(username || '').toLowerCase().trim()];
    const bad = () => cb({ error: 'Wrong username or password' });
    if (!u) return bad();
    const a = Buffer.from(hashPw(String(password || ''), u.salt), 'hex');
    if (!crypto.timingSafeEqual(a, Buffer.from(u.hash, 'hex'))) return bad();
    start(u.username, cb);
  }, true);

  on('resume', (token, cb) => {
    const n = db.sessions[token];
    if (!n || !db.users[n]) return cb({ error: 'expired' });
    start(n, cb, token);
  }, true);

  on('search', ({ q }, cb) => {
    q = String(q || '').toLowerCase().trim();
    if (!q) return cb({ users: [] });
    const users = Object.values(db.users)
      .filter((u) => u.username !== me && u.username.includes(q))
      .sort((a, b) => (a.username.startsWith(q) ? 0 : 1) - (b.username.startsWith(q) ? 0 : 1))
      .slice(0, 8).map(pub);
    cb({ users });
  });

  on('list', (_, cb) => {
    const convs = Object.values(db.convs).filter((c) => c.members.includes(me))
      .map(view).sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
    cb({ convs });
  });

  on('openDm', ({ username }, cb) => {
    username = String(username || '').toLowerCase().trim();
    if (!db.users[username]) return cb({ error: `No user named "${username}"` });
    if (username === me) return cb({ error: "You can't message yourself" });
    const id = 'dm:' + [me, username].sort().join(':');
    if (!db.convs[id]) {
      db.convs[id] = { id, type: 'dm', name: '', members: [me, username], messages: [] };
      save();
    }
    pushConv(db.convs[id]);
    cb({ ok: true, conv: view(db.convs[id]) });
  });

  on('createGroup', ({ name, members }, cb) => {
    name = String(name || '').trim().slice(0, 40);
    if (!name) return cb({ error: 'Give the group a name' });
    const list = [...new Set((members || []).map((m) => String(m).toLowerCase().trim()))];
    const missing = list.filter((m) => !db.users[m]);
    if (missing.length) return cb({ error: `Unknown user: ${missing.join(', ')}` });
    const all = [...new Set([me, ...list])];
    if (all.length < 3) return cb({ error: 'Add at least two other people' });
    const id = 'g:' + crypto.randomBytes(6).toString('hex');
    db.convs[id] = { id, type: 'group', name, members: all, messages: [] };
    save();
    pushConv(db.convs[id]);
    cb({ ok: true, conv: view(db.convs[id]) });
  });

  on('history', ({ id }, cb) => {
    const c = db.convs[id];
    if (!c || !c.members.includes(me)) return cb({ error: 'No access' });
    cb({ messages: c.messages.slice(-200) });
  });

  on('send', ({ id, text, file, replyTo }, cb) => {
    const c = db.convs[id];
    if (!c || !c.members.includes(me)) return cb({ error: 'No access' });
    text = String(text || '').slice(0, 4000);
    const rm = text.trim().match(/^\/roll(?:\s+(\d{1,4}))?$/i);
    if (rm) { const n = Math.max(2, +rm[1] || 6); text = `🎲 rolled a ${crypto.randomInt(1, n + 1)} (1-${n})`; }
    else if (/^\/flip$/i.test(text.trim())) text = `🪙 ${crypto.randomInt(2) ? 'Heads' : 'Tails'}!`;
    let f = null;
    if (file) {
      if (typeof file.data !== 'string' || file.data.length > 21e6 || !FILE_RE.test(file.data))
        return cb({ error: 'That file could not be sent' });
      f = { name: String(file.name || 'file').slice(0, 120), type: String(file.type || ''), data: file.data };
    }
    if (!text && !f) return cb({ error: 'Empty message' });
    const q = replyTo && c.messages.find((x) => x.id === replyTo && !x.deleted);
    const msg = {
      id: crypto.randomBytes(6).toString('hex'), from: me, text, file: f, ts: Date.now(), reactions: {},
      reply: q ? { id: q.id, from: q.from, text: (q.text || '').slice(0, 120), file: q.file ? q.file.name : '' } : null,
    };
    c.messages.push(msg);
    if (c.messages.length > 500) c.messages.shift();
    save();
    io.to('c:' + id).emit('message', { id, msg });
    notify(c, msg);
    cb({ ok: true });
  });

  on('profile', ({ displayName, bio, color, avatar }, cb) => {
    const u = db.users[me];
    u.displayName = String(displayName || u.username).trim().slice(0, 30) || u.username;
    u.bio = String(bio || '').slice(0, 160);
    if (/^#[0-9a-f]{6}$/i.test(color)) u.color = color;
    if (avatar === '' || (typeof avatar === 'string' && avatar.length < 120000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(avatar)))
      u.avatar = avatar;
    save();
    io.emit('user', pub(u));
    cb({ ok: true, me: pub(u) });
  });

  on('typing', ({ id, on: isOn }) => {
    const c = db.convs[id];
    if (c && c.members.includes(me)) s.to('c:' + id).emit('typing', { id, from: me, on: !!isOn });
  });

  on('react', ({ id, mid, emoji }, cb) => {
    const c = db.convs[id];
    if (!c || !c.members.includes(me) || typeof emoji !== 'string' || !emoji || emoji.length > 8) return cb({ error: 'No access' });
    const m = c.messages.find((x) => x.id === mid && !x.deleted);
    if (!m) return cb({ error: 'Message not found' });
    m.reactions = m.reactions || {};
    const arr = m.reactions[emoji] || (m.reactions[emoji] = []);
    const i = arr.indexOf(me);
    if (i >= 0) arr.splice(i, 1); else arr.push(me);
    if (!arr.length) delete m.reactions[emoji];
    save();
    io.to('c:' + id).emit('reaction', { id, mid, reactions: m.reactions });
    cb({ ok: true });
  });

  on('delete', ({ id, mid }, cb) => {
    const c = db.convs[id];
    const m = c && c.members.includes(me) && c.messages.find((x) => x.id === mid);
    if (!m || m.from !== me) return cb({ error: 'You can only delete your own messages' });
    Object.assign(m, { deleted: true, text: '', file: null, reactions: {}, reply: null });
    for (const x of c.messages) if (x.reply && x.reply.id === mid) { x.reply.text = 'Message deleted'; x.reply.file = ''; }
    save();
    io.to('c:' + id).emit('deleted', { id, mid });
    pushConv(c);
    cb({ ok: true });
  });

  on('gcall:join', ({ id, video }, cb) => {
    const c = db.convs[id];
    if (!c || c.type !== 'group' || !c.members.includes(me)) return cb({ error: 'No access' });
    let g = gcalls[id];
    const fresh = !g;
    if (!g) g = gcalls[id] = { video: !!video, users: new Set() };
    if (!g.users.has(me) && g.users.size >= 6) return cb({ error: 'Group calls are limited to 6 people' });
    const peers = [...g.users].filter((u) => u !== me);
    g.users.add(me);
    if (fresh) for (const m of c.members) if (m !== me) io.to('u:' + m).emit('gcall:ring', { id, from: me, video: g.video });
    gstate(c);
    cb({ ok: true, peers, video: g.video });
  });
  on('gcall:signal', ({ id, to, data }) => {
    const g = gcalls[id];
    if (g && g.users.has(me) && g.users.has(to)) io.to('u:' + to).emit('gcall:signal', { id, from: me, data });
  });
  on('gcall:leave', ({ id }) => gleave(me, id));

  on('push:key', (_, cb) => cb({ key: VAPID.publicKey }));
  on('push:sub', ({ sub }, cb) => {
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return cb({ error: 'Bad subscription' });
    for (const u of Object.keys(db.subs)) db.subs[u] = db.subs[u].filter((x) => x.endpoint !== sub.endpoint);
    (db.subs[me] = db.subs[me] || []).push(sub);
    save();
    cb({ ok: true });
  });
  on('push:unsub', ({ endpoint }) => {
    db.subs[me] = (db.subs[me] || []).filter((x) => x.endpoint !== endpoint);
    save();
  });

  // ---- 1-to-1 calls: server only relays WebRTC signaling
  on('call:invite', ({ to, video }, cb) => {
    if (!db.users[to] || !isOnline(to)) return cb({ error: `${to} is offline right now` });
    io.to('u:' + to).emit('call:incoming', { from: me, video: !!video });
    cb({ ok: true });
  });
  for (const ev of ['call:accept', 'call:signal', 'call:end']) {
    on(ev, ({ to, data }) => io.to('u:' + to).emit(ev, { from: me, data }));
  }

  s.on('disconnect', () => {
    if (me && !isOnline(me)) {
      for (const gid of Object.keys(gcalls)) gleave(me, gid);
      io.emit('presence', { username: me, online: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`MsgStudio running on port ${PORT}`));
