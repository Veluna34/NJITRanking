const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'rankd.db');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer (file uploads) ──────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── SQL.js setup ───────────────────────────────────────────────────────────
let db;

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS people (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      winner_id TEXT NOT NULL,
      loser_id TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  saveDb();
  console.log('✅ Database ready');
}

// ── Helpers ────────────────────────────────────────────────────────────────
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function getLeaderboard() {
  const people = dbAll('SELECT * FROM people ORDER BY created_at ASC');
  const stats = dbAll(`
    SELECT
      p.id,
      COUNT(CASE WHEN v.winner_id = p.id THEN 1 END) as wins,
      COUNT(CASE WHEN v.loser_id  = p.id THEN 1 END) as losses,
      COUNT(CASE WHEN v.winner_id = p.id OR v.loser_id = p.id THEN 1 END) as matchups
    FROM people p
    LEFT JOIN votes v ON v.winner_id = p.id OR v.loser_id = p.id
    GROUP BY p.id
  `);

  const statsMap = {};
  stats.forEach(s => { statsMap[s.id] = s; });

  return people.map(p => {
    const s = statsMap[p.id] || { wins: 0, losses: 0, matchups: 0 };
    const winRate = s.matchups > 0 ? Math.round((s.wins / s.matchups) * 100) : 0;
    return { ...p, wins: s.wins, losses: s.losses, matchups: s.matchups, winRate };
  }).sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    return b.matchups - a.matchups;
  });
}

// ── WebSocket broadcast ───────────────────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('🔌 Client connected');
  // Send full state on connect
  ws.send(JSON.stringify({ type: 'init', payload: { people: dbAll('SELECT * FROM people'), leaderboard: getLeaderboard() } }));
  ws.on('close', () => console.log('🔌 Client disconnected'));
});

// ── REST API ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Get all people
app.get('/api/people', (req, res) => {
  res.json(dbAll('SELECT * FROM people ORDER BY created_at ASC'));
});

// Add person
app.post('/api/people', upload.single('image'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const id = uuidv4();
  const image = req.file ? `/uploads/${req.file.filename}` : null;

  dbRun('INSERT INTO people (id, name, image) VALUES (?, ?, ?)', [id, name.trim(), image]);

  const person = { id, name: name.trim(), image };
  broadcast('person_added', person);
  res.json(person);
});

// Delete person
app.delete('/api/people/:id', (req, res) => {
  const { id } = req.params;
  const person = dbAll('SELECT * FROM people WHERE id = ?', [id])[0];
  if (!person) return res.status(404).json({ error: 'Not found' });

  // Remove image file if exists
  if (person.image) {
    const filePath = path.join(__dirname, 'public', person.image);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  dbRun('DELETE FROM people WHERE id = ?', [id]);
  dbRun('DELETE FROM votes WHERE winner_id = ? OR loser_id = ?', [id, id]);

  broadcast('person_deleted', { id });
  broadcast('leaderboard_update', getLeaderboard());
  res.json({ success: true });
});

// Cast vote
app.post('/api/vote', (req, res) => {
  const { winnerId, loserId } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'winnerId and loserId required' });

  const winner = dbAll('SELECT id FROM people WHERE id = ?', [winnerId])[0];
  const loser  = dbAll('SELECT id FROM people WHERE id = ?', [loserId])[0];
  if (!winner || !loser) return res.status(400).json({ error: 'Invalid person IDs' });

  dbRun('INSERT INTO votes (id, winner_id, loser_id) VALUES (?, ?, ?)', [uuidv4(), winnerId, loserId]);

  const lb = getLeaderboard();
  broadcast('leaderboard_update', lb);
  broadcast('vote_cast', { winnerId, loserId });
  res.json({ success: true, leaderboard: lb });
});

// Reset all votes
app.post('/api/reset-votes', (req, res) => {
  dbRun('DELETE FROM votes');
  broadcast('leaderboard_update', getLeaderboard());
  broadcast('votes_reset', {});
  res.json({ success: true });
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// ── Start ──────────────────────────────────────────────────────────────────
initDb().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 RANKD running at http://localhost:${PORT}`);
  });
});
