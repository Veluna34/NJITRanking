const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer ─────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Database ───────────────────────────────────────────────────────────────
const db = new Database('rankd.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    winner_id TEXT NOT NULL,
    loser_id TEXT NOT NULL,
    voter_id TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    username TEXT,
    person_id TEXT,
    photo TEXT,
    status TEXT DEFAULT 'pending',
    deny_reason TEXT,
    session_token TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

// Migrate: add voter_id column if it doesn't exist
try {
  db.exec('ALTER TABLE votes ADD COLUMN voter_id TEXT');
} catch(e) {
  // Column already exists, ignore
}

console.log('✅ Database ready');

// ── Helpers ────────────────────────────────────────────────────────────────
function getLeaderboard() {
  const people = db.prepare('SELECT * FROM people ORDER BY created_at ASC').all();
  const stats = db.prepare(`
    SELECT
      p.id,
      COUNT(CASE WHEN v.winner_id = p.id THEN 1 END) as wins,
      COUNT(CASE WHEN v.loser_id  = p.id THEN 1 END) as losses,
      COUNT(CASE WHEN v.winner_id = p.id OR v.loser_id = p.id THEN 1 END) as matchups
    FROM people p
    LEFT JOIN votes v ON v.winner_id = p.id OR v.loser_id = p.id
    GROUP BY p.id
  `).all();

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

function getUserFromToken(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM users WHERE session_token = ?').get(token) || null;
}

// ── WebSocket ──────────────────────────────────────────────────────────────
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', ws => {
  console.log('🔌 Client connected');
  ws.send(JSON.stringify({
    type: 'init',
    payload: {
      people: db.prepare('SELECT * FROM people').all(),
      leaderboard: getLeaderboard()
    }
  }));
  ws.on('close', () => console.log('🔌 Client disconnected'));
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  if (user.status !== 'approved') return res.status(403).json({ error: 'Account not approved', status: user.status, deny_reason: user.deny_reason });
  req.user = user;
  next();
}

// ── Auth Routes ────────────────────────────────────────────────────────────

// Signup
app.post('/api/signup', upload.single('photo'), async (req, res) => {
  try {
    const { email, password, username, person_id } = req.body;

    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (!email.toLowerCase().endsWith('@njit.edu')) return res.status(400).json({ error: 'Must use an @njit.edu email' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    // If no existing person selected, must have photo + username
    if (!person_id) {
      if (!req.file) return res.status(400).json({ error: 'Photo required when not selecting an existing person' });
      if (!username || !username.trim()) return res.status(400).json({ error: 'Username required when not selecting an existing person' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    let finalPersonId = person_id || null;
    let photo = null;

    // If they uploaded a photo + username, create a new person
    if (!person_id && req.file) {
      const newPersonId = uuidv4();
      photo = `/uploads/${req.file.filename}`;
      db.prepare('INSERT INTO people (id, name, image) VALUES (?, ?, ?)').run(newPersonId, username.trim(), photo);
      finalPersonId = newPersonId;
      broadcast('person_added', { id: newPersonId, name: username.trim(), image: photo });
    }

    db.prepare(`
      INSERT INTO users (id, email, password_hash, username, person_id, photo, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, email.toLowerCase(), password_hash, username ? username.trim() : null, finalPersonId, photo);

    // Notify admin of new pending user
    broadcast('new_application', { id, email: email.toLowerCase(), username, status: 'pending' });

    res.json({ success: true, message: 'Account created! Awaiting admin approval.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = uuidv4();
    db.prepare('UPDATE users SET session_token = ? WHERE id = ?').run(token, user.id);

    res.json({
      success: true,
      token,
      status: user.status,
      deny_reason: user.deny_reason,
      person_id: user.person_id,
      username: user.username,
      email: user.email
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
app.get('/api/me', (req, res) => {
  const token = req.headers['x-session-token'];
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.json({
    id: user.id,
    email: user.email,
    username: user.username,
    person_id: user.person_id,
    status: user.status,
    deny_reason: user.deny_reason
  });
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) db.prepare('UPDATE users SET session_token = NULL WHERE session_token = ?').run(token);
  res.json({ success: true });
});

// ── Admin User Management ──────────────────────────────────────────────────

// Get all users (admin)
app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT id, email, username, person_id, photo, status, deny_reason, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

// Approve user
app.post('/api/users/:id/approve', (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET status = ?, deny_reason = NULL WHERE id = ?').run('approved', id);

  broadcast('application_updated', { id, status: 'approved', deny_reason: null });
  res.json({ success: true });
});

// Deny user
app.post('/api/users/:id/deny', (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Deny reason required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  db.prepare('UPDATE users SET status = ?, deny_reason = ? WHERE id = ?').run('denied', reason.trim(), id);

  broadcast('application_updated', { id, status: 'denied', deny_reason: reason.trim() });
  res.json({ success: true });
});

// Delete user
app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── People Routes ──────────────────────────────────────────────────────────
app.get('/api/people', (req, res) => {
  res.json(db.prepare('SELECT * FROM people ORDER BY created_at ASC').all());
});

app.post('/api/people', upload.single('image'), (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const id = uuidv4();
  const image = req.file ? `/uploads/${req.file.filename}` : null;

  db.prepare('INSERT INTO people (id, name, image) VALUES (?, ?, ?)').run(id, name.trim(), image);

  const person = { id, name: name.trim(), image };
  broadcast('person_added', person);
  res.json(person);
});

app.delete('/api/people/:id', (req, res) => {
  const { id } = req.params;
  const person = db.prepare('SELECT * FROM people WHERE id = ?').get(id);
  if (!person) return res.status(404).json({ error: 'Not found' });

  if (person.image) {
    const filePath = path.join(__dirname, 'public', person.image);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  db.prepare('DELETE FROM people WHERE id = ?').run(id);
  db.prepare('DELETE FROM votes WHERE winner_id = ? OR loser_id = ?').run(id, id);

  broadcast('person_deleted', { id });
  broadcast('leaderboard_update', getLeaderboard());
  res.json({ success: true });
});

// ── Vote Route ─────────────────────────────────────────────────────────────
app.post('/api/vote', (req, res) => {
  const token = req.headers['x-session-token'];
  const user = getUserFromToken(token);

  if (!user) return res.status(401).json({ error: 'Must be logged in to vote' });
  if (user.status !== 'approved') return res.status(403).json({ error: 'Account not approved yet' });

  const { winnerId, loserId } = req.body;
  if (!winnerId || !loserId) return res.status(400).json({ error: 'winnerId and loserId required' });

  // Block voting for own person
  if (user.person_id && (user.person_id === winnerId || user.person_id === loserId)) {
    return res.status(403).json({ error: 'You cannot vote in a matchup that includes yourself' });
  }

  const winner = db.prepare('SELECT id FROM people WHERE id = ?').get(winnerId);
  const loser = db.prepare('SELECT id FROM people WHERE id = ?').get(loserId);
  if (!winner || !loser) return res.status(400).json({ error: 'Invalid person IDs' });

  db.prepare('INSERT INTO votes (id, winner_id, loser_id, voter_id) VALUES (?, ?, ?, ?)').run(uuidv4(), winnerId, loserId, user.id);

  const lb = getLeaderboard();
  broadcast('leaderboard_update', lb);
  broadcast('vote_cast', { winnerId, loserId });
  res.json({ success: true, leaderboard: lb });
});

// ── Reset Votes ────────────────────────────────────────────────────────────
app.post('/api/reset-votes', (req, res) => {
  db.prepare('DELETE FROM votes').run();
  broadcast('leaderboard_update', getLeaderboard());
  broadcast('votes_reset', {});
  res.json({ success: true });
});

app.get('/api/leaderboard', (req, res) => {
  res.json(getLeaderboard());
});

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 RANKD running at http://localhost:${PORT}`);
});