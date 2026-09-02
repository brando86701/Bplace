'use strict';
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const os        = require('os');

// ───────────────────────────────────────────────
//  CONFIG
// ───────────────────────────────────────────────
const PORT        = process.env.PORT || 3002;
const CANVAS_SIZE = 3000;
const DATA_DIR    = path.join(__dirname, 'data');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.bin');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

// ───────────────────────────────────────────────
//  PALETTE  (64 colors, 2 rows of 32)
// ───────────────────────────────────────────────
const PALETTE = [
  // Row 1 (32 Colors: Index 0 is White #FFFFFF, Neutrals, Reds, Oranges, Yellows, Olives, Greens, Cyans, Ocean Blues, Violets)
  '#FFFFFF','#D2D2D2','#B4B4B4','#787878','#3C3C3C','#000000',
  '#510000','#8C0000','#E50000','#FF5050','#FF7D7D',
  '#FFAA00','#FF8C00','#FFC800','#FFEA00','#FFFF80',
  '#556B2F','#6E8B3D','#8CA64E','#1B7A2B','#00A651','#52D053',
  '#00A896','#00C4B4','#00D9E8','#0066CC','#0099FF','#66C2FF',
  '#2B1B54','#5B2599','#8B35C2','#B967EB',
  
  // Row 2 (32 Colors: Magentas, Pinks, Browns, Skin Tones, Sage, Navies, Plums, Slate Grays, Sand)
  '#4C0027','#8A004F','#D9006C','#FF3399','#FF99DD',
  '#802B00','#A64200','#D96600',
  '#4A3625','#735238','#A67C52','#D9B38C','#F2D6B3','#FFE0BD',
  '#293330','#4A5953','#7B8C84','#122640','#1D3F66','#2D6299',
  '#4D1A4D','#732673','#AA3CAA','#D966D9','#E699E6',
  '#2E3A4E','#4E5D78','#8496B8','#3D3731','#6B6358','#A39989','#D4CDBF'
];

// ───────────────────────────────────────────────
//  DATA SETUP
// ───────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Canvas: Uint8Array of palette indices (0 = white = #FFFFFF)
let canvas;
try {
  const raw = fs.readFileSync(CANVAS_FILE);
  canvas = raw.length === CANVAS_SIZE * CANVAS_SIZE
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.length)
    : new Uint8Array(CANVAS_SIZE * CANVAS_SIZE);
} catch { canvas = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE); }

// Users
let users;
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
catch {
  users = [{ id: 1, username: 'admin', password: 'admin123', role: 'admin' }];
  saveUsers();
}

function saveUsers() { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }

// Templates
let serverTemplates = [];
try {
  serverTemplates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  serverTemplates.forEach(t => { if (t && t.rawIndices) delete t.rawIndices; });
} catch { serverTemplates = []; }
function saveServerTemplates() {
  try {
    const clean = serverTemplates.map(t => {
      if (t && t.rawIndices) {
        const { rawIndices, ...rest } = t;
        return rest;
      }
      return t;
    });
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(clean));
  } catch (err) {
    console.error('[Error] Falló al guardar plantillas:', err);
  }
}

function saveCanvas() {
  try {
    fs.writeFileSync(CANVAS_FILE, Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
  } catch (err) {
    console.error('[Error] Falló al guardar canvas:', err);
  }
}

let saveCanvasTimer = null;
function scheduleSaveCanvas() {
  if (saveCanvasTimer) clearTimeout(saveCanvasTimer);
  saveCanvasTimer = setTimeout(saveCanvas, 500); // Save 500ms after last change
}

setInterval(saveCanvas, 15_000); // auto-save every 15 s

// ───────────────────────────────────────────────
//  SESSIONS
// ───────────────────────────────────────────────
const sessions   = new Map(); // token -> {id, username, role}
const connected  = new Map(); // ws -> username

function genToken() { return crypto.randomBytes(32).toString('hex'); }

// ───────────────────────────────────────────────
//  EXPRESS
// ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware
function authMW(req, res, next) {
  const tok  = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = sessions.get(tok);
  if (!sess) return res.status(401).json({ error: 'No autorizado' });
  req.user = sess; next();
}
function adminMW(req, res, next) {
  authMW(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo admin' });
    next();
  });
}

// ── Routes ──────────────────────────────────────
// Health (lets the frontend detect server mode)
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'server' }));

// Palette
app.get('/api/palette', (_req, res) => res.json(PALETTE));

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = users.find(u => u.username === username && u.password === password);
  if (!u) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const tok = genToken();
  sessions.set(tok, { id: u.id, username: u.username, role: u.role });
  res.json({ token: tok, username: u.username, role: u.role });
});

// Logout
app.post('/api/logout', authMW, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace('Bearer ', ''));
  res.json({ ok: true });
});

// Canvas binary download
app.get('/api/canvas', (_req, res) => {
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(canvas.length));
  res.send(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
});

// Users list (admin)
app.get('/api/users', adminMW, (_req, res) =>
  res.json(users.map(({ password: _p, ...u }) => u)));

// Create user (admin)
app.post('/api/users', adminMW, (req, res) => {
  const { username, password, role = 'user' } = req.body || {};
  if (!username?.trim() || !password)
    return res.status(400).json({ error: 'Faltan datos' });
  if (users.some(u => u.username === username))
    return res.status(409).json({ error: 'Usuario ya existe' });
  const nu = { id: Date.now(), username, password, role };
  users.push(nu);  saveUsers();
  res.status(201).json({ id: nu.id, username, role });
});

// Delete user (admin)
app.delete('/api/users/:id', adminMW, (req, res) => {
  const id  = Number(req.params.id);
  const idx = users.findIndex(u => u.id === id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  if (users[idx].role === 'admin')
    return res.status(400).json({ error: 'No se puede borrar al admin' });
  users.splice(idx, 1); saveUsers();
  res.json({ ok: true });
});

// Manual canvas save (admin)
app.post('/api/canvas/save', adminMW, (_req, res) => { saveCanvas(); res.json({ ok: true }); });

// Clear canvas (admin)
app.post('/api/canvas/clear', adminMW, (_req, res) => {
  canvas.fill(0);  saveCanvas();
  broadcast({ type: 'clear' });
  res.json({ ok: true });
});

// Online count
app.get('/api/online', (_req, res) => res.json({ count: connected.size }));

// ───────────────────────────────────────────────
//  WEBSOCKET
// ───────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function broadcast(msg, skip = null) {
  const d = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if (c !== skip && c.readyState === WebSocket.OPEN) c.send(d);
  });
}
function bcastOnline() { broadcast({ type: 'online', count: connected.size }); }

wss.on('connection', ws => {
  // Give a random username to anonymous users
  const guestUsername = "Guest_" + Math.floor(Math.random() * 10000);
  connected.set(ws, guestUsername);
  bcastOnline();
  
  // Send welcome message and current templates list
  ws.send(JSON.stringify({ type: 'auth_ok', username: guestUsername, role: 'user' }));
  ws.send(JSON.stringify({ type: 'templates_list', templates: serverTemplates }));

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'auth': {
        // Optional auth, but still support it
        const s = sessions.get(msg.token);
        if (s) {
          connected.delete(ws);
          connected.set(ws, s.username);
          ws.send(JSON.stringify({ type: 'auth_ok', username: s.username, role: s.role }));
          bcastOnline();
        }
        break;
      }
      case 'template_add': {
        const { template } = msg;
        if (template && template.rawIndices) delete template.rawIndices;
        if (template && !serverTemplates.some(t => t.id === template.id)) {
          serverTemplates.push(template);
          saveServerTemplates();
          broadcast({ type: 'template_add', template }, ws);
        }
        break;
      }
      case 'template_update': {
        const { id, updates } = msg;
        if (updates && updates.rawIndices) delete updates.rawIndices;
        const t = serverTemplates.find(t => t.id === id);
        if (t) {
          Object.assign(t, updates);
          saveServerTemplates();
          broadcast({ type: 'template_update', id, updates }, ws);
        }
        break;
      }
      case 'template_delete': {
        const { id } = msg;
        serverTemplates = serverTemplates.filter(t => t.id !== id);
        saveServerTemplates();
        broadcast({ type: 'template_delete', id }, ws);
        break;
      }
      case 'pixel': {
        const { x, y, c: ci } = msg;
        if (x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE &&
            ci >= 0 && ci < PALETTE.length) {
          canvas[y * CANVAS_SIZE + x] = ci;
          broadcast({ type: 'pixel', x, y, c: ci }, ws);
          scheduleSaveCanvas();
        }
        break;
      }
      case 'batch': {
        const ok = (msg.pixels || []).filter(p =>
          p.x >= 0 && p.x < CANVAS_SIZE && p.y >= 0 && p.y < CANVAS_SIZE &&
          p.c >= 0 && p.c < PALETTE.length);
        ok.forEach(p => { canvas[p.y * CANVAS_SIZE + p.x] = p.c; });
        if (ok.length) {
          broadcast({ type: 'batch', pixels: ok }, ws);
          scheduleSaveCanvas();
        }
        break;
      }
      case 'clear': {
        // Clear the canvas and broadcast to everyone
        canvas.fill(0);
        saveCanvas();
        broadcast({ type: 'clear' }, ws);
        break;
      }
    }
  });

  ws.on('close', () => { connected.delete(ws); bcastOnline(); });
  ws.on('error', () => { connected.delete(ws); });
});

// ───────────────────────────────────────────────
//  START
// ───────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║  🎨  BPlace  —  Servidor activo      ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}       ║`);
  ips.forEach(ip => console.log(`║  Red:     http://${ip.padEnd(18)}║`));
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Admin:   admin / admin123           ║');
  console.log(`║  Canvas:  ${CANVAS_SIZE}×${CANVAS_SIZE} px               ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
