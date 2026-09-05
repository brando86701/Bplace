'use strict';
const express   = require('express');
const http      = require('http');
const https     = require('https');
const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const os        = require('os');
const { gzipSync, gunzipSync } = require('zlib');

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
        headers['Content-Length'] = Buffer.byteLength(postData);
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
        timeout: 60000
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
const serverStampOps = new Map();
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

let isLocalCanvasDirty = false;
let localSaveTimer = null;
let localSaveInFlight = false;

function flushCanvasLocalAsync() {
  localSaveTimer = null;
  if (!isLocalCanvasDirty || localSaveInFlight) return;
  isLocalCanvasDirty = false;
  localSaveInFlight = true;
  // Copy once per grouped save so later pixel writes cannot mutate the data
  // while Node is streaming it to disk.
  const snapshot = Buffer.from(canvas);
  fs.writeFile(CANVAS_FILE, snapshot, err => {
    localSaveInFlight = false;
    if (err) console.warn('[Local] No se pudo guardar el lienzo:', err.message);
    if (isLocalCanvasDirty && !localSaveTimer) {
      localSaveTimer = setTimeout(flushCanvasLocalAsync, 1000);
    }
  });
}

// ───────────────────────────────────────────────
//  CLOUD SYNC (SUPABASE)
// ───────────────────────────────────────────────
let isCloudCanvasDirty = false;
let cloudSaveTimer = null;

async function syncFromSupabase() {
  console.log('[Supabase] Sincronizando datos desde la nube...');
  
  // 1. Sync Canvas from Storage (try canvas.bin.gz then canvas.bin)
  try {
    let res = await supabaseRequest('/storage/v1/object/public/bplace/canvas.bin.gz?t=' + Date.now(), 'GET', null, true);
    if (res.status === 200 && res.data) {
      const decompressed = gunzipSync(res.data);
      if (decompressed.length === CANVAS_SIZE * CANVAS_SIZE) {
        canvas = new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.length);
        saveCanvasLocal();
        console.log(`[Supabase] ✅ Lienzo descargado y descomprimido desde Storage (${(res.data.length / 1024).toFixed(1)} KB).`);
      }
    } else {
      res = await supabaseRequest('/storage/v1/object/public/bplace/canvas.bin?t=' + Date.now(), 'GET', null, true);
      if (res.status === 200 && res.data && res.data.length === CANVAS_SIZE * CANVAS_SIZE) {
        canvas = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.length);
        saveCanvasLocal();
        console.log('[Supabase] ✅ Lienzo descargado desde Storage (9 MB).');
      }
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
        filterCI: -1
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

let isUploadingToCloud = false;

async function uploadCanvasToSupabase() {
  if (!isCloudCanvasDirty || isUploadingToCloud) return;
  isUploadingToCloud = true;
  isCloudCanvasDirty = false;
  try {
    const compressed = gzipSync(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
    const res = await supabaseRequest('/storage/v1/object/bplace/canvas.bin.gz', 'POST', compressed);
    if (res.status === 200 || res.status === 201) {
      console.log(`[Supabase] ✅ Lienzo guardado exitosamente en Storage CDN (${(compressed.length / 1024).toFixed(1)} KB).`);
    } else {
      throw new Error('Storage HTTP ' + res.status);
    }
  } catch (err) {
    isCloudCanvasDirty = true;
    console.warn('[Supabase] Aviso al sincronizar canvas con Storage:', err.message);
  } finally {
    isUploadingToCloud = false;
  }
}

function scheduleSaveCanvas() {
  isLocalCanvasDirty = true;
  if (!localSaveTimer && !localSaveInFlight) {
    localSaveTimer = setTimeout(flushCanvasLocalAsync, 1000);
  }
  isCloudCanvasDirty = true;
  if (!cloudSaveTimer) {
    cloudSaveTimer = setTimeout(() => {
      cloudSaveTimer = null;
      uploadCanvasToSupabase();
    }, 5000);
  }
}

async function refreshServerCanvasFromStorage() {
  try {
    let res = await supabaseRequest('/storage/v1/object/public/bplace/canvas.bin.gz?t=' + Date.now(), 'GET', null, true);
    if (res.status === 200 && res.data) {
      const decompressed = gunzipSync(res.data);
      if (decompressed.length === CANVAS_SIZE * CANVAS_SIZE) {
        canvas = new Uint8Array(decompressed.buffer, decompressed.byteOffset, decompressed.length);
        saveCanvasLocal();
        return true;
      }
    }
    res = await supabaseRequest('/storage/v1/object/public/bplace/canvas.bin?t=' + Date.now(), 'GET', null, true);
    if (res.status === 200 && res.data && res.data.length === CANVAS_SIZE * CANVAS_SIZE) {
      canvas = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.length);
      saveCanvasLocal();
      return true;
    }
  } catch (e) {
    console.warn('[Supabase] No se pudo recuperar el checkpoint:', e.message);
  }
  return false;
}

function finishStampCheckpoint(p) {
  const received = serverStampOps.get(p && p.opId)?.size || 0;
  serverStampOps.delete(p && p.opId);
  if (p && received >= Number(p.totalChunks || 0)) {
    scheduleSaveCanvas();
    uploadCanvasToSupabase();
  } else if (p && p.uploaded) {
    setTimeout(refreshServerCanvasFromStorage, 600);
  }
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

// Mobile upload transport; saves to local canvas and forwards compressed payload to Storage.
app.post('/api/canvas/compressed', express.raw({ type: 'application/gzip', limit: '10mb' }), async (req, res) => {
  try {
    const snapshot = gunzipSync(req.body, { maxOutputLength: CANVAS_SIZE * CANVAS_SIZE });
    if (snapshot.length !== CANVAS_SIZE * CANVAS_SIZE) return res.sendStatus(400);
    canvas = new Uint8Array(snapshot.buffer, snapshot.byteOffset, snapshot.length);
    saveCanvasLocal();
    const result = await supabaseRequest('/storage/v1/object/bplace/canvas.bin.gz', 'POST', req.body);
    if (result.status !== 200 && result.status !== 201) return res.sendStatus(502);
    res.sendStatus(200);
  } catch (error) {
    res.sendStatus(400);
  }
});

// Compress the canonical snapshot before sending it to clients.
app.get('/api/canvas/compact', async (_req, res) => {
  try {
    const compressed = gzipSync(Buffer.from(canvas.buffer, canvas.byteOffset, canvas.byteLength));
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Encoding', 'gzip');
    res.set('Cache-Control', 'no-store');
    res.send(compressed);
  } catch (error) {
    res.status(502).json({ error: 'Canvas unavailable' });
  }
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

// Clear canvas
app.post('/api/canvas/clear', (_req, res) => {
  console.log('[API] 🗑️ Limpiando canvas');
  canvas.fill(0);
  saveCanvasLocal();
  broadcast({ type: 'clear' });
  forwardToSupabaseRealtime('clear', {});
  scheduleSaveCanvas();
  uploadCanvasToSupabase();
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
        if (template) template.filterCI = -1;
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
        if (updates) {
          delete updates.filterCI;
          delete updates.filterActive;
        }
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
            confirmed: t.confirmed
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
          forwardToSupabaseRealtime('pixel', { x, y, c: ci });
        }
        break;
      }
      case 'fill': {
        const { x, y, c: ci } = msg;
        executeFloodFillServer(x, y, ci);
        broadcast({ type: 'fill', x, y, c: ci }, ws);
        scheduleSaveCanvas();
        forwardToSupabaseRealtime('fill', { x, y, c: ci });
        break;
      }
      case 'stamp_template': {
        const tpl = serverTemplates.find(t => t.id === msg.id);
        if (tpl && tpl.rawIndices) {
          applyStampServer(tpl, msg.x, msg.y, msg.filterCI);
        }
        broadcast({ type: 'stamp_template', ...msg }, ws);
        scheduleSaveCanvas();
        forwardToSupabaseRealtime('stamp_template', msg);
        break;
      }
      case 'stamp_chunk': {
        if (applyStampChunkServer(msg)) {
          broadcast({ type: 'stamp_chunk', ...msg }, ws);
          forwardToSupabaseRealtime('stamp_chunk', msg);
        }
        break;
      }
      case 'stamp_checkpoint': {
        broadcast({ type: 'stamp_checkpoint', ...msg }, ws);
        forwardToSupabaseRealtime('stamp_checkpoint', msg);
        finishStampCheckpoint(msg);
        break;
      }
      case 'shape': {
        if (msg.type === 'rect') {
          const lx = Math.max(0, Math.min(msg.x0, msg.x1));
          const rx = Math.min(CANVAS_SIZE - 1, Math.max(msg.x0, msg.x1));
          const ty = Math.max(0, Math.min(msg.y0, msg.y1));
          const by = Math.min(CANVAS_SIZE - 1, Math.max(msg.y0, msg.y1));
          const w = rx - lx + 1;
          if (msg.fill) {
            for (let y = ty; y <= by; y++) {
              canvas.fill(msg.c, y * CANVAS_SIZE + lx, y * CANVAS_SIZE + lx + w);
            }
          } else {
            for (let x = lx; x <= rx; x++) {
              canvas[ty * CANVAS_SIZE + x] = msg.c;
              canvas[by * CANVAS_SIZE + x] = msg.c;
            }
            for (let y = ty + 1; y < by; y++) {
              canvas[y * CANVAS_SIZE + lx] = msg.c;
              canvas[y * CANVAS_SIZE + rx] = msg.c;
            }
          }
        } else if (msg.type === 'circle') {
          const cx = msg.cx, cy = msg.cy, a = Math.max(0, msg.a), b = Math.max(0, msg.b), ci = msg.c;
          if (msg.fill) {
            for (let dy = -b; dy <= b; dy++) {
              const py = cy + dy;
              if (py < 0 || py >= CANVAS_SIZE) continue;
              const xs = Math.round(a * Math.sqrt(Math.max(0, 1 - (dy * dy) / (b * b + 0.0001))));
              const lx = Math.max(0, cx - xs);
              const rx = Math.min(CANVAS_SIZE - 1, cx + xs);
              const w = rx - lx + 1;
              if (w > 0) canvas.fill(ci, py * CANVAS_SIZE + lx, py * CANVAS_SIZE + lx + w);
            }
          }
        } else if (msg.type === 'line') {
          const sz = msg.size || 1;
          bresenhamLineServer(msg.x0, msg.y0, msg.x1, msg.y1, (x, y) => {
            paintBrushServer(x, y, msg.c, sz);
          });
        }
        broadcast({ type: 'shape', ...msg }, ws);
        scheduleSaveCanvas();
        forwardToSupabaseRealtime('shape', msg);
        break;
      }
      case 'lines_batch': {
        const p = msg.lines || msg.payload;
        if (Array.isArray(p)) {
          for (let i = 0; i < p.length; i += 6) {
            const x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3], ci = p[i + 4], sz = p[i + 5] || 1;
            bresenhamLineServer(x0, y0, x1, y1, (x, y) => {
              paintBrushServer(x, y, ci, sz);
            });
          }
          broadcast({ type: 'lines_batch', lines: p }, ws);
          scheduleSaveCanvas();
          forwardToSupabaseRealtime('lines_batch', p);
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
        console.log('[WS] 🗑️ Limpiando canvas por cliente WS');
        canvas.fill(0);
        saveCanvasLocal();
        broadcast({ type: 'clear' }, ws);
        forwardToSupabaseRealtime('clear', {});
        scheduleSaveCanvas();
        uploadCanvasToSupabase();
        break;
      }
    }
  });

  ws.on('close', () => { connected.delete(ws); bcastOnline(); });
  ws.on('error', () => { connected.delete(ws); });
});

// ───────────────────────────────────────────────
//  SUPABASE REALTIME CLOUD BRIDGE
// ───────────────────────────────────────────────
let wsCloudBridge = null;
let srvRef = 1000;
let cloudHeartbeatInterval = null;

function forwardToSupabaseRealtime(event, payload) {
  if (wsCloudBridge && wsCloudBridge.readyState === WebSocket.OPEN) {
    try {
      wsCloudBridge.send(JSON.stringify({
        topic: 'realtime:bplace',
        event: 'broadcast',
        payload: { type: 'broadcast', event, payload },
        ref: 'srv_fwd_' + (srvRef++)
      }));
    } catch {}
  }
}

function bresenhamLineServer(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function paintBrushServer(cx, cy, ci, brushSize) {
  if (ci < 0 || ci >= PALETTE.length) return;
  const sz = brushSize || 1;
  if (sz === 1) {
    if (cx >= 0 && cx < CANVAS_SIZE && cy >= 0 && cy < CANVAS_SIZE) {
      canvas[cy * CANVAS_SIZE + cx] = ci;
    }
    return;
  }
  const r = Math.floor(sz / 2);
  const minX = Math.max(0, cx - r);
  const maxX = Math.min(CANVAS_SIZE - 1, cx + r);
  const minY = Math.max(0, cy - r);
  const maxY = Math.min(CANVAS_SIZE - 1, cy + r);
  const w = maxX - minX + 1;
  if (w <= 0 || minY > maxY) return;
  for (let py = minY; py <= maxY; py++) {
    const rowOffset = py * CANVAS_SIZE + minX;
    canvas.fill(ci, rowOffset, rowOffset + w);
  }
}

function executeFloodFillServer(sx, sy, ni) {
  if (sx < 0 || sx >= CANVAS_SIZE || sy < 0 || sy >= CANVAS_SIZE || ni < 0 || ni >= PALETTE.length) return;
  const idx0 = sy * CANVAS_SIZE + sx;
  const oi = canvas[idx0];
  if (oi === ni) return;

  const stack = [idx0];
  while (stack.length > 0) {
    const idx = stack.pop();
    if (canvas[idx] !== oi) continue;
    const y = Math.floor(idx / CANVAS_SIZE);
    const x = idx % CANVAS_SIZE;

    let lx = x;
    while (lx > 0 && canvas[y * CANVAS_SIZE + (lx - 1)] === oi) lx--;
    let rx = x;
    while (rx < CANVAS_SIZE - 1 && canvas[y * CANVAS_SIZE + (rx + 1)] === oi) rx++;

    const fillWidth = rx - lx + 1;
    const rowOffset = y * CANVAS_SIZE + lx;
    canvas.fill(ni, rowOffset, rowOffset + fillWidth);

    if (y > 0) {
      let scanAbove = false;
      const aboveOffset = (y - 1) * CANVAS_SIZE;
      for (let i = lx; i <= rx; i++) {
        if (canvas[aboveOffset + i] === oi) {
          if (!scanAbove) { stack.push(aboveOffset + i); scanAbove = true; }
        } else { scanAbove = false; }
      }
    }
    if (y < CANVAS_SIZE - 1) {
      let scanBelow = false;
      const belowOffset = (y + 1) * CANVAS_SIZE;
      for (let i = lx; i <= rx; i++) {
        if (canvas[belowOffset + i] === oi) {
          if (!scanBelow) { stack.push(belowOffset + i); scanBelow = true; }
        } else { scanBelow = false; }
      }
    }
  }
}

function applyStampServer(tpl, startX, startY, filterCI) {
  if (!tpl || !tpl.rawIndices) return;
  const W = Math.round(tpl.w);
  const H = Math.round(tpl.h);
  const ox = Math.round(startX);
  const oy = Math.round(startY);

  for (let py = 0; py < H; py++) {
    const y = oy + py;
    if (y < 0 || y >= CANVAS_SIZE) continue;
    const rowOffset = y * CANVAS_SIZE;
    const tplRow = py * W;
    for (let px = 0; px < W; px++) {
      const x = ox + px;
      if (x < 0 || x >= CANVAS_SIZE) continue;
      const ci = tpl.rawIndices[tplRow + px];
      if (ci < 0 || ci >= PALETTE.length) continue;
      if (filterCI >= 0 && ci !== filterCI) continue;
      canvas[rowOffset + x] = ci;
    }
  }
}

function applyStampChunkServer(p) {
  if (!p || typeof p.data !== 'string' || p.data.length > 24000) return false;
  const W = Math.max(1, Math.round(Number(p.w) || 0));
  const ox = Math.round(Number(p.x) || 0), oy = Math.round(Number(p.y) || 0);
  const offset = Math.max(0, Math.round(Number(p.offset) || 0));
  const filterCI = Number.isInteger(p.filterCI) ? p.filterCI : -1;
  let bytes;
  try { bytes = Buffer.from(p.data, 'base64'); } catch { return false; }
  for (let i = 0; i < bytes.length; i++) {
    const absolute = offset + i;
    const x = ox + (absolute % W), y = oy + Math.floor(absolute / W);
    const ci = bytes[i];
    if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE || ci === 255 || ci >= PALETTE.length) continue;
    if (filterCI >= 0 && ci !== filterCI) continue;
    canvas[y * CANVAS_SIZE + x] = ci;
  }
  if (p.opId !== undefined) {
    let op = serverStampOps.get(p.opId);
    if (!op) { op = new Set(); serverStampOps.set(p.opId, op); }
    op.add(offset);
  }
  return true;
}

function connectServerToSupabaseRealtime() {
  const wsUrl = `wss://jtwbuempcdjrbqfgvaar.supabase.co/realtime/v1/websocket?apikey=${SUPABASE_KEY}&vsn=1.0.0`;
  try {
    wsCloudBridge = new WebSocket(wsUrl);

    wsCloudBridge.on('open', () => {
      console.log('[Supabase Realtime] ✅ Servidor puente conectado a la red global de Supabase.');
      wsCloudBridge.send(JSON.stringify({
        topic: 'realtime:bplace',
        event: 'phx_join',
        payload: { config: { broadcast: { self: false } } },
        ref: 'srv_join'
      }));

      if (cloudHeartbeatInterval) clearInterval(cloudHeartbeatInterval);
      cloudHeartbeatInterval = setInterval(() => {
        if (wsCloudBridge && wsCloudBridge.readyState === WebSocket.OPEN) {
          wsCloudBridge.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: 'srv_hb' }));
        }
      }, 25000);
    });

    wsCloudBridge.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'broadcast' && msg.payload) {
          const { event: ev, payload: p } = msg.payload;
          if (ev === 'pixel' && p) {
            if (p.x >= 0 && p.x < CANVAS_SIZE && p.y >= 0 && p.y < CANVAS_SIZE && p.c >= 0 && p.c < PALETTE.length) {
              canvas[p.y * CANVAS_SIZE + p.x] = p.c;
              broadcast({ type: 'pixel', x: p.x, y: p.y, c: p.c });
              scheduleSaveCanvas();
            }
          } else if (ev === 'shape' && p) {
            if (p.type === 'rect') {
              const lx = Math.max(0, Math.min(p.x0, p.x1));
              const rx = Math.min(CANVAS_SIZE - 1, Math.max(p.x0, p.x1));
              const ty = Math.max(0, Math.min(p.y0, p.y1));
              const by = Math.min(CANVAS_SIZE - 1, Math.max(p.y0, p.y1));
              const w = rx - lx + 1;
              if (p.fill) {
                for (let y = ty; y <= by; y++) {
                  const rowOffset = y * CANVAS_SIZE + lx;
                  canvas.fill(p.c, rowOffset, rowOffset + w);
                }
              } else {
                for (let x = lx; x <= rx; x++) {
                  canvas[ty * CANVAS_SIZE + x] = p.c;
                  canvas[by * CANVAS_SIZE + x] = p.c;
                }
                for (let y = ty + 1; y < by; y++) {
                  canvas[y * CANVAS_SIZE + lx] = p.c;
                  canvas[y * CANVAS_SIZE + rx] = p.c;
                }
              }
            } else if (p.type === 'circle') {
              const cx = p.cx, cy = p.cy, a = Math.max(0, p.a), b = Math.max(0, p.b), ci = p.c;
              if (p.fill) {
                for (let dy = -b; dy <= b; dy++) {
                  const py = cy + dy;
                  if (py < 0 || py >= CANVAS_SIZE) continue;
                  const xs = Math.round(a * Math.sqrt(Math.max(0, 1 - (dy * dy) / (b * b + 0.0001))));
                  const lx = Math.max(0, cx - xs);
                  const rx = Math.min(CANVAS_SIZE - 1, cx + xs);
                  const w = rx - lx + 1;
                  if (w > 0) {
                    const rowOffset = py * CANVAS_SIZE + lx;
                    canvas.fill(ci, rowOffset, rowOffset + w);
                  }
                }
              }
            } else if (p.type === 'line') {
              const sz = p.size || 1;
              bresenhamLineServer(p.x0, p.y0, p.x1, p.y1, (x, y) => {
                paintBrushServer(x, y, p.c, sz);
              });
            }
            broadcast({ type: 'shape', ...p });
            scheduleSaveCanvas();
          } else if (ev === 'fill' && p) {
            executeFloodFillServer(p.x, p.y, p.c);
            broadcast({ type: 'fill', x: p.x, y: p.y, c: p.c });
            scheduleSaveCanvas();
          } else if (ev === 'stamp_chunk' && p) {
            if (applyStampChunkServer(p)) broadcast({ type: 'stamp_chunk', ...p });
          } else if (ev === 'stamp_checkpoint' && p) {
            broadcast({ type: 'stamp_checkpoint', ...p });
            finishStampCheckpoint(p);
          } else if (ev === 'stamp_template' && p) {
            const tpl = serverTemplates.find(t => t.id === p.id);
            if (tpl && tpl.rawIndices) {
              applyStampServer(tpl, p.x, p.y, p.filterCI);
            }
            broadcast({ type: 'stamp_template', ...p });
            scheduleSaveCanvas();
          } else if (ev === 'lines_batch' && Array.isArray(p)) {
            const len = p.length;
            for (let i = 0; i < len; i += 6) {
              const x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3], ci = p[i + 4], sz = p[i + 5] || 1;
              bresenhamLineServer(x0, y0, x1, y1, (x, y) => {
                paintBrushServer(x, y, ci, sz);
              });
            }
            broadcast({ type: 'lines_batch', lines: p });
            scheduleSaveCanvas();
          } else if (ev === 'flat_batch' && Array.isArray(p)) {
            const len = p.length;
            for (let i = 0; i < len; i += 3) {
              const x = p[i], y = p[i + 1], ci = p[i + 2];
              if (x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE && ci >= 0 && ci < PALETTE.length) {
                canvas[y * CANVAS_SIZE + x] = ci;
              }
            }
            broadcast({ type: 'flat_batch', pixels: p });
            scheduleSaveCanvas();
          } else if (ev === 'batch' && p && Array.isArray(p.pixels)) {
            p.pixels.forEach(px => {
              if (px.x >= 0 && px.x < CANVAS_SIZE && px.y >= 0 && px.y < CANVAS_SIZE && px.c >= 0 && px.c < PALETTE.length) {
                canvas[px.y * CANVAS_SIZE + px.x] = px.c;
              }
            });
            broadcast({ type: 'batch', pixels: p.pixels });
          } else if (ev === 'template_add' && p && p.template) {
            p.template.filterCI = -1;
            if (!serverTemplates.some(t => t.id === p.template.id)) {
              serverTemplates.push(p.template);
              saveTemplates();
              broadcast({ type: 'template_add', template: p.template });
            }
          } else if (ev === 'template_update' && p && p.id && p.updates) {
            delete p.updates.filterCI;
            delete p.updates.filterActive;
            delete p.updates.visible;
            const tpl = serverTemplates.find(t => t.id === p.id);
            if (tpl) {
              Object.assign(tpl, p.updates);
              saveTemplates();
              broadcast({ type: 'template_update', id: p.id, updates: p.updates });
            }
          } else if (ev === 'template_delete' && p && p.id) {
            serverTemplates = serverTemplates.filter(t => t.id !== p.id);
            saveTemplates();
            broadcast({ type: 'template_delete', id: p.id });
          } else if (ev === 'clear') {
            console.log('[Supabase Realtime] 🗑️ Limpiando canvas por evento remoto');
            canvas.fill(0);
            saveCanvasLocal();
            broadcast({ type: 'clear' });
            scheduleSaveCanvas();
            uploadCanvasToSupabase();
          }
        }
      } catch {}
    });

    wsCloudBridge.on('close', () => {
      if (cloudHeartbeatInterval) {
        clearInterval(cloudHeartbeatInterval);
        cloudHeartbeatInterval = null;
      }
      setTimeout(connectServerToSupabaseRealtime, 3000);
    });
    wsCloudBridge.on('error', () => {
      if (wsCloudBridge) wsCloudBridge.close();
    });
  } catch (err) {
    console.warn('[Supabase Realtime] Error al inicializar puente:', err);
    setTimeout(connectServerToSupabaseRealtime, 4000);
  }
}

connectServerToSupabaseRealtime();

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
