const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 25e6 }); // ~18MB files after base64

// Only index.html is public (keeps server.js and data.json private)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

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
