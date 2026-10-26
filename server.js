const express = require('express'), Database = require('better-sqlite3'), crypto = require('crypto');
const archiver = require('archiver');
const fs = require('fs'), path = require('path');

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
  created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
const have = db.prepare('PRAGMA table_info(projects)').all().map(c => c.name);
for (const [c, d] of [['user_id', 'INTEGER'], ['objectif', 'INTEGER NOT NULL DEFAULT 0'], ['steps', "TEXT NOT NULL DEFAULT '[]'"],
  ['statut', "TEXT NOT NULL DEFAULT 'en_cours'"], ['extras', 'INTEGER NOT NULL DEFAULT 0'], ['compteurs', "TEXT NOT NULL DEFAULT '[]'"], ['debut', 'INTEGER NOT NULL DEFAULT 0']])
  if (!have.includes(c)) db.exec(`ALTER TABLE projects ADD COLUMN ${c} ${d}`);
db.exec('CREATE TABLE IF NOT EXISTS activity(project_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(project_id, day))');
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);`);
const purge = () => db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
purge(); setInterval(purge, 36e5).unref();

// ---- comptes : mots de passe (scrypt), sessions (cookie), limite d'essais ----
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = pw => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split(':'), a = crypto.scryptSync(pw, salt, 64), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const cookies = q => Object.fromEntries((q.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]).map(([k, ...v]) => [k, v.join('=')]));
const startSession = (q, r, uid) => {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sha(t), uid, Date.now() + 30 * 864e5);
  r.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}` + (q.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
};
const currentUser = q => {
  const t = cookies(q).sid;
  return t ? db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?').get(sha(t), Date.now()) : null;
};
const fails = new Map(), ipOf = q => q.headers['cf-connecting-ip'] || q.ip;
const blocked = q => { const f = fails.get(ipOf(q)); return f && f.n >= 10 && Date.now() - f.t < 9e5; };
const addFail = q => { const k = ipOf(q), f = fails.get(k); fails.set(k, f && Date.now() - f.t < 9e5 ? { n: f.n + 1, t: f.t } : { n: 1, t: Date.now() }); };
const noUsers = () => !db.prepare('SELECT 1 FROM users').get();

const file = id => path.join(DATA, 'patrons', id + '.pdf');
const find = (id, uid) => db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(id, uid);
const mine = q => find(q.pid, q.user.id);
const out = p => ({ ...p, steps: JSON.parse(p.steps), compteurs: JSON.parse(p.compteurs) });

const app = express();
app.use(express.json());
// Anti-cache : chaque fichier de l'interface est appelé avec une empreinte (?v=...) qui change dès qu'il est modifié
const PUB = path.join(__dirname, 'public');
const version = () => {
  const h = crypto.createHash('sha1');
  for (const f of fs.readdirSync(PUB).sort()) h.update(fs.readFileSync(path.join(PUB, f)));
  return h.digest('hex').slice(0, 8);
};
app.get(['/', '/index.html'], (q, r) => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8')
    .replace(/(href|src)="(style\.css|app\.js|favicon\.svg|apple-touch-icon\.png)"/g, `$1="$2?v=${version()}"`);
  r.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(PUB, { setHeaders: r => r.setHeader('Cache-Control', 'no-cache') }));
app.param('id', (q, r, next, v) => {
  q.pid = parseInt(v, 10);
  Number.isInteger(q.pid) ? next() : r.sendStatus(400);
});

app.get('/api/me', (q, r) =>
  r.json({ user: currentUser(q)?.username ?? null, first: noUsers(), canRegister: process.env.ALLOW_SIGNUP === 'true' }));

app.post('/api/register', (q, r) => {
  const first = noUsers();
  if (!first && process.env.ALLOW_SIGNUP !== 'true') return r.status(403).send('Les inscriptions sont fermées');
  if (blocked(q)) return r.status(429).send('Trop d’essais, réessaie dans 15 minutes');
  const username = String(q.body.username || ''), password = String(q.body.password || '');
  if (!/^[a-z0-9_.-]{3,30}$/i.test(username)) return r.status(400).send('Identifiant : 3 à 30 caractères (lettres, chiffres, . _ -)');
  if (password.length < 8 || password.length > 200) return r.status(400).send('Mot de passe : 8 caractères minimum');
  try {
    const i = db.prepare('INSERT INTO users(username,hash) VALUES(?,?)').run(username, hashPw(password));
    if (first) db.prepare('UPDATE projects SET user_id=? WHERE user_id IS NULL').run(i.lastInsertRowid);
    startSession(q, r, i.lastInsertRowid);
    r.json({ user: { id: i.lastInsertRowid, username } });
  } catch { r.status(409).send('Cet identifiant existe déjà'); }
});

app.post('/api/login', (q, r) => {
  if (blocked(q)) return r.status(429).send('Trop d’essais, réessaie dans 15 minutes');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(q.body.username || ''));
  if (!u || !checkPw(String(q.body.password || '').slice(0, 200), u.hash)) {
    addFail(q);
    return r.status(401).send('Identifiant ou mot de passe incorrect');
  }
  startSession(q, r, u.id);
  r.json({ user: { id: u.id, username: u.username } });
});

app.post('/api/logout', (q, r) => {
  const t = cookies(q).sid;
  if (t) db.prepare('DELETE FROM sessions WHERE token=?').run(sha(t));
  r.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0');
  r.sendStatus(204);
});

// ---- projets : réservés à l'utilisateur connecté, chacun voit les siens ----
app.use('/api/projects', (q, r, next) => { q.user = currentUser(q); q.user ? next() : r.sendStatus(401); });

app.get('/api/projects', (q, r) =>
  r.json(db.prepare('SELECT id,name,rangs,objectif,materials,pattern_name,statut FROM projects WHERE user_id=? ORDER BY id DESC').all(q.user.id)));

app.post('/api/projects', (q, r) => {
  const name = String(q.body.name || '').trim();
  if (!name) return r.sendStatus(400);
  const i = db.prepare('INSERT INTO projects(name,user_id) VALUES(?,?)').run(name, q.user.id);
  r.status(201).json(find(i.lastInsertRowid, q.user.id));
});

app.get('/api/projects/:id', (q, r) => {
  const p = mine(q);
  p ? r.json(out(p)) : r.sendStatus(404);
});

const STATUTS = ['en_cours', 'pause', 'termine'];
const int = v => v != null ? Math.max(0, parseInt(v, 10) || 0) : null;
const cleanSteps = s => Array.isArray(s) ? JSON.stringify(s.slice(0, 100).map(x => ({ longueur: int(x.longueur) ?? 1, repetitions: Math.min(99, Math.max(1, int(x.repetitions) || 1)), faites: int(x.faites) || 0, texte: String(x.texte || '').slice(0, 200), fait: !!x.fait }))) : null;
const cleanCompteurs = c => Array.isArray(c) ? JSON.stringify(c.slice(0, 20).map(x => ({ nom: String(x.nom || '').slice(0, 60), valeur: int(x.valeur) ?? 0 }))) : null;
app.patch('/api/projects/:id', (q, r) => {
  const cur = mine(q);
  if (!cur) return r.sendStatus(404);
  const { name, rangs, materials, objectif, steps, statut, extras, compteurs, jour, debut } = q.body;
  const nr = int(rangs);
  db.prepare(`UPDATE projects SET name=COALESCE(?,name), rangs=COALESCE(?,rangs), materials=COALESCE(?,materials),
              objectif=COALESCE(?,objectif), steps=COALESCE(?,steps), statut=COALESCE(?,statut),
              extras=COALESCE(?,extras), compteurs=COALESCE(?,compteurs), debut=COALESCE(?,debut) WHERE id=? AND user_id=?`)
    .run(name?.trim() || null, nr, materials ?? null, int(objectif), cleanSteps(steps),
         STATUTS.includes(statut) ? statut : null, extras == null ? null : +!!extras, cleanCompteurs(compteurs), int(debut), q.pid, q.user.id);
  if (nr != null && nr !== cur.rangs) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(jour || '') ? jour : new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO activity(project_id,day,n) VALUES(?,?,MAX(0,?))
                ON CONFLICT(project_id,day) DO UPDATE SET n=MAX(0,n+?)`).run(q.pid, day, nr - cur.rangs, nr - cur.rangs);
  }
  r.json(out(mine(q)));
});

app.delete('/api/projects/:id', (q, r) => {
  if (mine(q)) {
    db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(q.pid, q.user.id);
    db.prepare('DELETE FROM activity WHERE project_id=?').run(q.pid);
    fs.rmSync(file(q.pid), { force: true });
  }
  r.sendStatus(204);
});

app.put('/api/projects/:id/pattern', express.raw({ type: () => true, limit: '50mb' }), (q, r) => {
  if (!mine(q)) return r.sendStatus(404);
  if (!Buffer.isBuffer(q.body) || q.body.subarray(0, 4).toString() !== '%PDF')
    return r.status(400).send('Fichier PDF requis');
  fs.writeFileSync(file(q.pid), q.body);
  const name = decodeURIComponent(q.get('x-filename') || 'patron.pdf').slice(0, 200);
  db.prepare('UPDATE projects SET pattern_name=? WHERE id=?').run(name, q.pid);
  r.json(mine(q));
});

app.get('/api/projects/:id/pattern', (q, r) => {
  const p = mine(q);
  if (!p?.pattern_name || !fs.existsSync(file(q.pid))) return r.sendStatus(404);
  r.type('application/pdf').sendFile(file(q.pid));
});

app.delete('/api/projects/:id/pattern', (q, r) => {
  if (mine(q)) {
    fs.rmSync(file(q.pid), { force: true });
    db.prepare('UPDATE projects SET pattern_name=NULL WHERE id=?').run(q.pid);
  }
  r.sendStatus(204);
});

app.get('/api/projects/:id/export', (q, r) => {
  const p = mine(q);
  if (!p) return r.sendStatus(404);
  const steps = JSON.parse(p.steps);
  const txt = [`Projet : ${p.name}`, `Rangs tricotés : ${p.rangs}${p.objectif ? ' / ' + p.objectif : ''}`, '',
    'Matériel :', p.materials || '(non renseigné)', '', 'Étapes :',
    ...(steps.length ? steps.map(s => `- ${s.longueur != null ? (s.longueur ? s.longueur + ' rangs puis ' : 'tout de suite : ') : 'rang ' + s.rang + ' : '}${s.texte}${s.repetitions > 1 ? ' (x' + s.repetitions + ')' : ''}${s.fait ? ' (fait)' : ''}`) : ['(aucune)']),
    '', p.pattern_name ? 'Patron : ' + p.pattern_name : 'Patron : aucun'].join('\r\n');
  r.attachment(p.name.replace(/[\/\\:*?"<>|]/g, '-') + '.zip');
  const z = archiver('zip');
  z.on('error', () => r.destroy());
  z.pipe(r);
  z.append(txt, { name: 'projet.txt' });
  if (p.pattern_name && fs.existsSync(file(q.pid))) z.file(file(q.pid), { name: p.pattern_name.replace(/[\/\\]/g, '-') });
  z.finalize();
});

app.get('/api/projects/:id/stats', (q, r) => {
  if (!mine(q)) return r.sendStatus(404);
  r.json(db.prepare('SELECT day, n FROM activity WHERE project_id=? ORDER BY day DESC LIMIT 60').all(q.pid));
});

app.post('/api/password', (q, r) => {
  const u = currentUser(q);
  if (!u) return r.sendStatus(401);
  if (blocked(q)) return r.status(429).send('Trop d’essais, réessaie dans 15 minutes');
  const row = db.prepare('SELECT hash FROM users WHERE id=?').get(u.id);
  const nouveau = String(q.body.nouveau || '');
  if (!checkPw(String(q.body.ancien || '').slice(0, 200), row.hash)) { addFail(q); return r.status(403).send('Ancien mot de passe incorrect'); }
  if (nouveau.length < 8 || nouveau.length > 200) return r.status(400).send('Nouveau mot de passe : 8 caractères minimum');
  db.prepare('UPDATE users SET hash=? WHERE id=?').run(hashPw(nouveau), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id=? AND token<>?').run(u.id, sha(cookies(q).sid));
  r.sendStatus(204);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Compteur tricot prêt'));
