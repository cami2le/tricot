const express = require('express'), Database = require('better-sqlite3');
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

const file = id => path.join(DATA, 'patrons', id + '.pdf');
const find = id => db.prepare('SELECT * FROM projects WHERE id=?').get(id);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.param('id', (q, r, next, v) => {
  q.pid = parseInt(v, 10);
  Number.isInteger(q.pid) ? next() : r.sendStatus(400);
});

app.get('/api/projects', (q, r) =>
  r.json(db.prepare('SELECT id,name,rangs,materials,pattern_name FROM projects ORDER BY id DESC').all()));

app.post('/api/projects', (q, r) => {
  const name = String(q.body.name || '').trim();
  if (!name) return r.sendStatus(400);
  const i = db.prepare('INSERT INTO projects(name) VALUES(?)').run(name);
  r.status(201).json(find(i.lastInsertRowid));
});

app.get('/api/projects/:id', (q, r) => {
  const p = find(q.pid);
  p ? r.json(p) : r.sendStatus(404);
});

app.patch('/api/projects/:id', (q, r) => {
  if (!find(q.pid)) return r.sendStatus(404);
  const { name, rangs, materials } = q.body;
  db.prepare(`UPDATE projects SET name=COALESCE(?,name), rangs=COALESCE(?,rangs),
              materials=COALESCE(?,materials) WHERE id=?`)
    .run(name?.trim() || null, rangs != null ? Math.max(0, parseInt(rangs, 10) || 0) : null,
         materials ?? null, q.pid);
  r.json(find(q.pid));
});

app.delete('/api/projects/:id', (q, r) => {
  db.prepare('DELETE FROM projects WHERE id=?').run(q.pid);
  fs.rmSync(file(q.pid), { force: true });
  r.sendStatus(204);
});

app.put('/api/projects/:id/pattern', express.raw({ type: () => true, limit: '50mb' }), (q, r) => {
  if (!find(q.pid)) return r.sendStatus(404);
  if (!Buffer.isBuffer(q.body) || q.body.subarray(0, 4).toString() !== '%PDF')
    return r.status(400).send('Fichier PDF requis');
  fs.writeFileSync(file(q.pid), q.body);
  const name = decodeURIComponent(q.get('x-filename') || 'patron.pdf').slice(0, 200);
  db.prepare('UPDATE projects SET pattern_name=? WHERE id=?').run(name, q.pid);
  r.json(find(q.pid));
});

app.get('/api/projects/:id/pattern', (q, r) => {
  const p = find(q.pid);
  if (!p?.pattern_name || !fs.existsSync(file(q.pid))) return r.sendStatus(404);
  r.type('application/pdf').sendFile(file(q.pid));
});

app.delete('/api/projects/:id/pattern', (q, r) => {
  fs.rmSync(file(q.pid), { force: true });
  db.prepare('UPDATE projects SET pattern_name=NULL WHERE id=?').run(q.pid);
  r.sendStatus(204);
});

app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Compteur tricot prêt'));
