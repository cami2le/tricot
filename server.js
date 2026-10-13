const express = require('express'), Database = require('better-sqlite3');
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(path.join(DATA, 'patrons'), { recursive: true });
const db = new Database(path.join(DATA, 'tricot.db'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  rangs INTEGER NOT NULL DEFAULT 0,
  materials TEXT NOT NULL DEFAULT '',
  pattern_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);`);
if (!db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'user_id'))
  db.exec('ALTER TABLE projects ADD COLUMN user_id INTEGER');

const file = id => path.join(DATA, 'patrons', id + '.pdf');
const find = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id);
const own = q => db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(q.pid, q.user.id);

// --- Comptes et sessions ---
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hash = pw => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const check = (pw, stored) => {
  const [s, h] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
};
const sid = q => (q.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([k]) => k === 'sid')?.[1];
const userOf = q => {
  const t = sid(q); return t && db.prepare(
    'SELECT u.id,u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?').get(sha(t), Date.now()) || null;
};
const startSession = (q, r, uid) => {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), uid, Date.now() + 30 * 864e5);
  r.cookie('sid', t, { httpOnly: true, sameSite: 'lax', secure: q.secure, maxAge: 30 * 864e5 });
};
const nbUsers = () => db.prepare('SELECT COUNT(*) n FROM users').get().n;
const canRegister = () => nbUsers() === 0 || process.env.ALLOW_SIGNUP === 'true';
const fails = new Map();
const limited = k => { const f = fails.get(k); return f && f.n >= 10 && Date.now() - f.t < 9e5; };
const fail = k => { const f = fails.get(k); fails.set(k, f && Date.now() - f.t < 9e5 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.param('id', (q, r, next, v) => {
  q.pid = parseInt(v, 10);
  Number.isInteger(q.pid) ? next() : r.sendStatus(400);
});

app.get('/api/me', (q, r) => r.json({ user: userOf(q)?.username || null, canRegister: canRegister(), first: nbUsers() === 0 }));

app.post('/api/register', (q, r) => {
  if (!canRegister()) return r.status(403).send('Les inscriptions sont fermées.');
  const { username, password } = q.body;
  if (typeof username !== 'string' || !/^[\w.-]{3,32}$/.test(username))
    return r.status(400).send('Nom d’utilisateur : 3 à 32 caractères (lettres, chiffres, _ . -).');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200)
    return r.status(400).send('Mot de passe : 8 caractères minimum.');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) return r.status(409).send('Ce nom est déjà pris.');
  const first = nbUsers() === 0;
  const id = db.prepare('INSERT INTO users(username,password) VALUES(?,?)').run(username, hash(password)).lastInsertRowid;
  if (first) db.prepare('UPDATE projects SET user_id=? WHERE user_id IS NULL').run(id);
  startSession(q, r, id);
  r.json({ user: username });
});

app.post('/api/login', (q, r) => {
  if (limited(q.ip)) return r.status(429).send('Trop de tentatives. Réessaie dans 15 minutes.');
  const { username, password } = q.body;
  const u = typeof username === 'string' && typeof password === 'string'
    ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
  if (!u || !check(password, u.password)) { fail(q.ip); return r.status(401).send('Identifiants incorrects.'); }
  fails.delete(q.ip);
  startSession(q, r, u.id);
  r.json({ user: u.username });
});

app.post('/api/logout', (q, r) => {
  const t = sid(q);
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(t));
  r.clearCookie('sid');
  r.sendStatus(204);
});

// --- Projets (réservés au compte connecté) ---
app.use('/api/projects', (q, r, next) => { q.user = userOf(q); q.user ? next() : r.sendStatus(401); });

app.get('/api/projects', (q, r) =>
  r.json(db.prepare('SELECT id,name,rangs,materials,pattern_name FROM projects WHERE user_id=? ORDER BY id DESC').all(q.user.id)));

app.post('/api/projects', (q, r) => {
  const name = String(q.body.name || '').trim();
  if (!name) return r.sendStatus(400);
  const i = db.prepare('INSERT INTO projects(name,user_id) VALUES(?,?)').run(name, q.user.id);
  r.status(201).json(find(i.lastInsertRowid));
});

app.get('/api/projects/:id', (q, r) => {
  const p = own(q);
  p ? r.json(p) : r.sendStatus(404);
});

app.patch('/api/projects/:id', (q, r) => {
  if (!own(q)) return r.sendStatus(404);
  const { name, rangs, materials } = q.body;
  db.prepare(`UPDATE projects SET name=COALESCE(?,name), rangs=COALESCE(?,rangs),
              materials=COALESCE(?,materials) WHERE id=?`)
    .run(name?.trim() || null, rangs != null ? Math.max(0, parseInt(rangs, 10) || 0) : null,
      materials ?? null, q.pid);
  r.json(find(q.pid));
});

app.delete('/api/projects/:id', (q, r) => {
  if (!own(q)) return r.sendStatus(404);
  db.prepare('DELETE FROM projects WHERE id=?').run(q.pid);
  fs.rmSync(file(q.pid), { force: true });
  r.sendStatus(204);
});

app.put('/api/projects/:id/pattern', express.raw({ type: () => true, limit: '50mb' }), (q, r) => {
  if (!own(q)) return r.sendStatus(404);
  if (!Buffer.isBuffer(q.body) || q.body.subarray(0, 4).toString() !== '%PDF')
    return r.status(400).send('Fichier PDF requis');
  fs.writeFileSync(file(q.pid), q.body);
  const name = decodeURIComponent(q.get('x-filename') || 'patron.pdf').slice(0, 200);
  db.prepare('UPDATE projects SET pattern_name=? WHERE id=?').run(name, q.pid);
  r.json(find(q.pid));
});

app.get('/api/projects/:id/pattern', (q, r) => {
  const p = own(q);
  if (!p?.pattern_name || !fs.existsSync(file(q.pid))) return r.sendStatus(404);
  r.type('application/pdf').sendFile(file(q.pid));
});

app.delete('/api/projects/:id/pattern', (q, r) => {
  if (!own(q)) return r.sendStatus(404);
  fs.rmSync(file(q.pid), { force: true });
  db.prepare('UPDATE projects SET pattern_name=NULL WHERE id=?').run(q.pid);
  r.sendStatus(204);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Compteur tricot prêt'));