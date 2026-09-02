'use strict';
const express   = require('express');
const http      = require('http');
const https     = require('https');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const os        = require('os');

// Load environment variables from .env if present
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of envLines) {
      const match = line.trim().match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch {}

// ───────────────────────────────────────────────
//  CONFIG & SUPABASE CREDENTIALS
// ───────────────────────────────────────────────
const PORT        = process.env.PORT || 3002;
const CANVAS_SIZE = 3000;
const DATA_DIR    = path.join(__dirname, 'data');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.bin');
const USERS_FILE  = path.join(DATA_DIR, 'users.json');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jtwbuempcdjrbqfgvaar.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0d2J1ZW1wY2RqcmJxZmd2YWFyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODMxMTg5OSwiZXhwIjoyMTAzODg3ODk5fQ.3RMyOTuazfC5z98SuzC9YTsiZpDaPv-vqGBWvc8TfhM';

// ───────────────────────────────────────────────
//  PALETTE  (64 colors, 2 rows of 32)
// ───────────────────────────────────────────────
const PALETTE = [
  // Row 1 (32 Colors: White #FFFFFF, Neutrals, Reds, Oranges, Yellows, Olives, Greens, Cyans, Ocean Blues, Violets)
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
//  SUPABASE REST & STORAGE HELPER
// ───────────────────────────────────────────────
function supabaseRequest(endpoint, method = 'GET', data = null, isRaw = false) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(endpoint, SUPABASE_URL);
      const isBuffer = Buffer.isBuffer(data);
      const postData = data ? (isBuffer ? data : JSON.stringify(data)) : null;

      const headers = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      };

      if (postData) {
        headers['Content-Type'] = isBuffer ? 'application/octet-stream' : 'application/json';
        headers['Content-Length'] = postData.length;
      }
      if (endpoint.includes('/storage/v1/object/') && method === 'POST') {
        headers['x-upsert'] = 'true';
      }
      if (endpoint.includes('/rest/v1/') && method === 'POST') {
        headers['Prefer'] = 'resolution=merge-duplicates';
      }

      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers,
        timeout: 10000
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (isRaw) return resolve({ status: res.statusCode, data: buf });
          try { resolve({ status: res.statusCode, data: JSON.parse(buf.toString('utf8')) }); }
          catch { resolve({ status: res.statusCode, data: buf.toString('utf8') }); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Supabase request timeout')); });
      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ───────────────────────────────────────────────
//  LOCAL & CLOUD DATA SETUP
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
let users = [{ id: 1, username: 'admin', password: 'admin123', role: 'admin' }];
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { saveUsersLocal(); }

function saveUsersLocal() {
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch {}
}

// Templates
let serverTemplates = [];
try {
  serverTemplates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  serverTemplates.forEach(t => { if (t && t.rawIndices) delete t.rawIndices; });
} catch { serverTemplates = []; }

function saveServerTemplatesLocal() {
  try {
    const clean = serverTemplates.map(t => {
      if (t && t.rawIndices) { const { rawIndices, ...rest } = t; return rest; }
      return t;
    });
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(clean));
  } catch {}
}

function saveCanvasLocal() {
  try {
    fs.writeFileSync(CANVAS_FILE, Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
  } catch {}
}

// ───────────────────────────────────────────────
//  CLOUD SYNC (SUPABASE)
// ───────────────────────────────────────────────
let isCloudCanvasDirty = false;
let cloudSaveTimer = null;

async function syncFromSupabase() {
  console.log('[Supabase] Sincronizando datos desde la nube...');
  
  // 1. Sync Canvas from Storage
  try {
    const res = await supabaseRequest('/storage/v1/object/public/bplace/canvas.bin', 'GET', null, true);
    if (res.status === 200 && res.data && res.data.length === CANVAS_SIZE * CANVAS_SIZE) {
      canvas = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.length);
      saveCanvasLocal();
      console.log('[Supabase] ✅ Lienzo descargado y sincronizado desde Storage (9 MB).');
    }
  } catch (e) {
    console.warn('[Supabase] No se pudo descargar canvas de Storage (usando copia local):', e.message);
  }

  // 2. Sync Templates from PostgreSQL
  try {
    const res = await supabaseRequest('/rest/v1/templates?select=*');
    if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
      serverTemplates = res.data.map(t => ({
        id: Number(t.id),
        name: t.name,
        origImageURL: t.orig_image_url,
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
        opacity: t.opacity,
        visible: t.visible,
        confirmed: t.confirmed,
        filterCI: t.filter_ci
      }));
      saveServerTemplatesLocal();
      console.log(`[Supabase] ✅ ${serverTemplates.length} plantillas sincronizadas desde PostgreSQL.`);
    }
  } catch (e) {
    console.warn('[Supabase] No se pudieron sincronizar plantillas (usando copia local):', e.message);
  }

  // 3. Sync Users from PostgreSQL
  try {
    const res = await supabaseRequest('/rest/v1/users?select=*');
    if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
      users = res.data.map(u => ({
        id: Number(u.id),
        username: u.username,
        password: u.password,
        role: u.role
      }));
      saveUsersLocal();
      console.log(`[Supabase] ✅ ${users.length} usuarios sincronizados desde PostgreSQL.`);
    }
  } catch (e) {
    console.warn('[Supabase] No se pudieron sincronizar usuarios:', e.message);
  }
}

async function uploadCanvasToSupabase() {
  if (!isCloudCanvasDirty) return;
  isCloudCanvasDirty = false;
  try {
    const buf = Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength);
    const res = await supabaseRequest('/storage/v1/object/bplace/canvas.bin', 'POST', buf);
    if (res.status === 200 || res.status === 201) {
      // Successfully uploaded to cloud
    }
  } catch (err) {
    console.warn('[Supabase] Error al subir canvas a Storage:', err.message);
  }
}

function scheduleSaveCanvas() {
  saveCanvasLocal();
  isCloudCanvasDirty = true;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(uploadCanvasToSupabase, 1000); // 1s debounce for cloud upload
}

// Background periodic sync
setInterval(uploadCanvasToSupabase, 30_000);
syncFromSupabase().catch(() => {});

// ───────────────────────────────────────────────
//  SESSIONS & AUTH
// ───────────────────────────────────────────────
const sessions  = new Map(); // token -> {id, username, role}
const connected = new Map(); // ws -> username

function genToken() { return crypto.randomBytes(32).toString('hex'); }

// ───────────────────────────────────────────────
//  EXPRESS APP & SERVER
// ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(express.json({ limit: '50mb' }));
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
app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'supabase-cloud', connectedUsers: connected.size }));
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
  res.set('Cache-Control', 'no-cache');
  res.send(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
});

// Users list (admin)
app.get('/api/users', adminMW, (_req, res) =>
  res.json(users.map(({ password: _p, ...u }) => u)));

// Create user (admin)
app.post('/api/users', adminMW, async (req, res) => {
  const { username, password, role = 'user' } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Faltan datos' });
  if (users.some(u => u.username === username)) return res.status(409).json({ error: 'Usuario ya existe' });
  
  const nu = { id: Date.now(), username, password, role };
  users.push(nu);
  saveUsersLocal();
  
  // Sync to Supabase
  try {
    await supabaseRequest('/rest/v1/users', 'POST', {
      id: nu.id,
      username: nu.username,
      password: nu.password,
      role: nu.role
    });
  } catch {}

  res.status(201).json({ id: nu.id, username, role });
});

// Delete user (admin)
app.delete('/api/users/:id', adminMW, async (req, res) => {
  const id  = Number(req.params.id);
  const idx = users.findIndex(u => u.id === id);
  if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
  if (users[idx].role === 'admin') return res.status(400).json({ error: 'No se puede borrar al admin' });
  
  users.splice(idx, 1);
  saveUsersLocal();
  
  // Delete from Supabase
  try {
    await supabaseRequest('/rest/v1/users?id=eq.' + id, 'DELETE');
  } catch {}

  res.json({ ok: true });
});

// Manual canvas save (admin)
app.post('/api/canvas/save', adminMW, (_req, res) => {
  scheduleSaveCanvas();
  uploadCanvasToSupabase();
  res.json({ ok: true });
});

// Clear canvas (admin)
app.post('/api/canvas/clear', adminMW, (_req, res) => {
  canvas.fill(0);
  scheduleSaveCanvas();
  broadcast({ type: 'clear' });
  res.json({ ok: true });
});

// Online count
app.get('/api/online', (_req, res) => res.json({ count: connected.size }));

// ───────────────────────────────────────────────
//  WEBSOCKET MULTIPLAYER (REALTIME 120 FPS)
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
          saveServerTemplatesLocal();
          broadcast({ type: 'template_add', template }, ws);
          
          // Sync to Supabase
          supabaseRequest('/rest/v1/templates', 'POST', {
            id: template.id,
            name: template.name,
            orig_image_url: template.origImageURL,
            x: template.x,
            y: template.y,
            w: template.w,
            h: template.h,
            opacity: template.opacity ?? 0.8,
            visible: template.visible !== false,
            confirmed: !!template.confirmed,
            filter_ci: template.filterCI ?? -1
          }).catch(() => {});
        }
        break;
      }
      case 'template_update': {
        const { id, updates } = msg;
        if (updates && updates.rawIndices) delete updates.rawIndices;
        const t = serverTemplates.find(t => t.id === id);
        if (t) {
          Object.assign(t, updates);
          saveServerTemplatesLocal();
          broadcast({ type: 'template_update', id, updates }, ws);

          // Sync to Supabase
          supabaseRequest('/rest/v1/templates?id=eq.' + id, 'PATCH', {
            x: t.x,
            y: t.y,
            w: t.w,
            h: t.h,
            opacity: t.opacity,
            visible: t.visible,
            confirmed: t.confirmed,
            filter_ci: t.filterCI
          }).catch(() => {});
        }
        break;
      }
      case 'template_delete': {
        const { id } = msg;
        serverTemplates = serverTemplates.filter(t => t.id !== id);
        saveServerTemplatesLocal();
        broadcast({ type: 'template_delete', id }, ws);

        // Delete from Supabase
        supabaseRequest('/rest/v1/templates?id=eq.' + id, 'DELETE').catch(() => {});
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
        canvas.fill(0);
        scheduleSaveCanvas();
        broadcast({ type: 'clear' }, ws);
        break;
      }
    }
  });

  ws.on('close', () => { connected.delete(ws); bcastOnline(); });
  ws.on('error', () => { connected.delete(ws); });
});

// ───────────────────────────────────────────────
//  START SERVER
// ───────────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
    console.log('\n╔═════════════════════════════════════════════════════╗');
    console.log('║  🎨  BPlace  —  Servidor en la Nube (Supabase)       ║');
    console.log('╠═════════════════════════════════════════════════════╣');
    console.log(`║  Local:     http://localhost:${PORT}                    ║`);
    ips.forEach(ip => console.log(`║  Red:       http://${ip.padEnd(23)}║`));
    console.log('╠═════════════════════════════════════════════════════╣');
    console.log(`║  Supabase:  ${SUPABASE_URL.padEnd(30)}║`);
    console.log(`║  Lienzo:    ${CANVAS_SIZE}×${CANVAS_SIZE} px (9 Megapíxeles)           ║`);
    console.log('╚═════════════════════════════════════════════════════╝\n');
  });
}

module.exports = app;
