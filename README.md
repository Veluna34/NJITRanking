# RANKD 🏆

Real-time head-to-head ranking app. Add people with photos, vote 1v1, and watch the leaderboard update live for everyone connected.

## Stack
- **Backend**: Node.js + Express
- **Database**: SQLite (via sql.js) — saved to `rankd.db`
- **Real-time sync**: WebSockets (ws)
- **File uploads**: multer (stored in `public/uploads/`)
- **Frontend**: Vanilla HTML/CSS/JS (served from `public/`)

## Quick Start

```bash
# Install dependencies
npm install

# Run the server
npm start

# Open in browser
http://localhost:3000
```

## How it works
- Everyone visits the same URL (your server's IP or domain)
- When someone adds a person → everyone sees them instantly
- When someone votes → leaderboard updates live for all connected users
- All data is stored in `rankd.db` (SQLite file on the server)
- Photos are stored in `public/uploads/`

## Hosting Options

### Local network (simplest)
Run `npm start`, then others on your WiFi can visit `http://YOUR_LOCAL_IP:3000`
Find your IP with `ipconfig` (Windows) or `ifconfig` (Mac/Linux)

### Railway (free cloud hosting)
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. It auto-detects Node.js and runs `npm start`
4. Get a public URL that anyone on the internet can visit

### Render (free cloud hosting)
1. Push to GitHub
2. Go to render.com → New Web Service → connect repo
3. Build command: `npm install` | Start command: `node server.js`

### VPS / any server
```bash
npm install
PORT=3000 node server.js
# Or use pm2 to keep it running:
npm install -g pm2
pm2 start server.js --name rankd
```

## Environment Variables
- `PORT` — port to run on (default: 3000)

## Notes
- SQLite db file (`rankd.db`) is created automatically on first run
- Uploaded images persist in `public/uploads/` — back this up!
- The app uses WebSockets for real-time sync — make sure your host supports them (Railway and Render both do)
