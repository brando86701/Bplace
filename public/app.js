/* BPlace v2 - app.js
   Features: template persistence (IDB), multiple templates, sliding panel,
             resize handles, cross-stitch view, color filter */
'use strict';

/* === Constants === */
const CS          = 3000;
const MIN_Z       = 0.04;
const MAX_Z       = 50;
const DB_NAME     = 'bplace_v2';
const DB_VER      = 2;           // bumped to add templates store
const DB_STORE    = 'canvas';
const DB_TPL      = 'templates';
const MAX_TPLS    = 8;           // allow more templates
const MAX_RECENT  = 8;
const MAX_FAVS    = 8;
const STITCH_CELL = 4;
const STITCH_GAP  = 1;

const BASE_PALETTE = [
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

/* === WebSocket Multiplayer (Supabase Realtime Edge Network) === */
const SUPABASE_CONFIG = {
  url: 'https://jtwbuempcdjrbqfgvaar.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0d2J1ZW1wY2RqcmJxZmd2YWFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMTE4OTksImV4cCI6MjEwMzg4Nzg5OX0.562ZWgCbV2eOcDptn_LrT-ONv6DF4yFgZGY6ttiZsjg',
  cdnCanvas: 'https://jtwbuempcdjrbqfgvaar.supabase.co/storage/v1/object/public/bplace/canvas.bin'
};

let ws = null;
let wsReady = false;
let sbHeartbeatInterval = null;
let sbMsgRef = 1;
let wsBatch = [];
let wsFlushTimer = null;
let presenceUsers = new Set();

function connectSupabaseRealtime() {
  if (sbHeartbeatInterval) { clearInterval(sbHeartbeatInterval); sbHeartbeatInterval = null; }
  const url = `wss://jtwbuempcdjrbqfgvaar.supabase.co/realtime/v1/websocket?apikey=${SUPABASE_CONFIG.anonKey}&vsn=1.0.0`;
  
  try {
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      console.log('[Supabase Realtime] Conectado a la red Edge global');
      wsReady = true;
      updateOnlineChip(1);

      const userId = 'usr_' + Math.random().toString(36).substring(2, 9);
      // Join realtime channel with broadcast & presence
      ws.send(JSON.stringify({
        topic: 'realtime:bplace',
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: userId } } },
        ref: String(sbMsgRef++)
      }));

      // Start 25s heartbeat ping to keep connection alive
      sbHeartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(sbMsgRef++) }));
        }
      }, 25000);
    });

    ws.addEventListener('message', async e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      
      // Handle presence (live user count across all devices)
      if (msg.event === 'presence_state') {
        presenceUsers = new Set(Object.keys(msg.payload || {}));
        updateOnlineChip(Math.max(1, presenceUsers.size));
      } else if (msg.event === 'presence_diff') {
        const joins = Object.keys(msg.payload?.joins || {});
        const leaves = Object.keys(msg.payload?.leaves || {});
        joins.forEach(k => presenceUsers.add(k));
        leaves.forEach(k => presenceUsers.delete(k));
        updateOnlineChip(Math.max(1, presenceUsers.size));
      }

      // Handle real-time broadcast events
      if (msg.event === 'broadcast' && msg.payload) {
        const payloadData = msg.payload;
        const ev = payloadData.event;
        const p = payloadData.payload;
        if (!p) return;
        
        if (ev === 'pixel') {
          applyRemotePixel(p.x, p.y, p.c);
        } else if (ev === 'shape') {
          if (p.type === 'rect') {
            paintRect(p.x0, p.y0, p.x1, p.y1, p.c, p.fill);
          } else if (p.type === 'circle') {
            paintEllipse(p.cx, p.cy, p.a, p.b, p.c, p.fill);
          } else if (p.type === 'line') {
            const prev = brushSize;
            brushSize = p.size || 1;
            bresenhamLine(p.x0, p.y0, p.x1, p.y1, (x, y) => paintBrush(x, y, p.c));
            brushSize = prev;
          }
          markDirty();
          scheduleIDBSave();
        } else if (ev === 'flat_batch' && Array.isArray(p)) {
          const len = p.length;
          for (let i = 0; i < len; i += 3) {
            const x = p[i], y = p[i + 1], ci = p[i + 2];
            if (x >= 0 && x < CS && y >= 0 && y < CS && ci >= 0 && ci < palRGB.length) {
              offCtx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
              offCtx.fillRect(x, y, 1, 1);
              if (canvasData) canvasData[y * CS + x] = ci;
            }
          }
          markDirty();
          scheduleIDBSave();
        } else if (ev === 'batch') {
          (p.pixels || []).forEach(px => applyRemotePixel(px.x, px.y, px.c));
        } else if (ev === 'clear') {
          if (canvasData) { canvasData.fill(0); offCtx.fillStyle='#FFFFFF'; offCtx.fillRect(0,0,CS,CS); markDirty(); }
        } else if (ev === 'template_add') {
          if (p.template && !templates.some(t => t.id === p.template.id)) {
            await addTemplateFromData(p.template);
            renderTemplateList();
            markDirty();
          }
        } else if (ev === 'template_update') {
          const tpl = templates.find(t => t.id === p.id);
          if (tpl && p.updates) {
            Object.assign(tpl, p.updates);
            if (p.updates.confirmed && !tpl.confirmed) {
              tpl.confirmed = true;
              const { canvas, rawIndices } = buildPaletteCanvas(tpl.origImage, Math.max(10, Math.round(tpl.w)), Math.max(10, Math.round(tpl.h)));
              tpl.canvas = canvas; tpl.rawIndices = rawIndices;
              tpl.stitchCanvas = makeStitchCanvas(rawIndices, tpl.w, tpl.h);
            }
            syncTplInputs(tpl);
            renderTemplateList();
            markDirty();
          }
        } else if (ev === 'template_delete') {
          templates = templates.filter(t => t.id !== p.id);
          renderTemplateList();
          markDirty();
        }
      }
    });

    ws.addEventListener('close', () => {
      wsReady = false;
      updateOnlineChip(null);
      if (sbHeartbeatInterval) clearInterval(sbHeartbeatInterval);
      setTimeout(connectSupabaseRealtime, 2500);
    });

    ws.addEventListener('error', () => { if (ws) ws.close(); });
  } catch (err) {
    console.warn('[Supabase Realtime] Error al conectar:', err);
    setTimeout(connectSupabaseRealtime, 3500);
  }
}

function wsConnect() {
  connectSupabaseRealtime();
}

function sendWSShape(shapeData) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    topic: 'realtime:bplace',
    event: 'broadcast',
    payload: { type: 'broadcast', event: 'shape', payload: shapeData },
    ref: String(sbMsgRef++)
  }));
}

function queueWSPixel(x, y, ci) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  wsBatch.push({ x, y, c: ci });
  if (!wsFlushTimer) {
    wsFlushTimer = setTimeout(flushWSPixels, 20);
  }
}

function flushWSPixels() {
  wsFlushTimer = null;
  if (!wsBatch.length) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      if (wsBatch.length === 1) {
        ws.send(JSON.stringify({
          topic: 'realtime:bplace',
          event: 'broadcast',
          payload: { type: 'broadcast', event: 'pixel', payload: wsBatch[0] },
          ref: String(sbMsgRef++)
        }));
      } else {
        const flat = new Array(wsBatch.length * 3);
        for (let i = 0; i < wsBatch.length; i++) {
          const idx = i * 3;
          flat[idx] = wsBatch[i].x;
          flat[idx + 1] = wsBatch[i].y;
          flat[idx + 2] = wsBatch[i].c;
        }
        for (let i = 0; i < flat.length; i += 6000) {
          const chunk = flat.slice(i, i + 6000);
          ws.send(JSON.stringify({
            topic: 'realtime:bplace',
            event: 'broadcast',
            payload: { type: 'broadcast', event: 'flat_batch', payload: chunk },
            ref: String(sbMsgRef++)
          }));
        }
      }
    } catch (e) {
      console.warn('[WS] flush error', e);
    }
  }
  wsBatch = [];
}

function wsSendPixel(x, y, ci) {
  queueWSPixel(x, y, ci);
}

function applyRemotePixel(x, y, ci) {
  if (x < 0 || x >= CS || y < 0 || y >= CS) return;
  setPixelPalette(x, y, ci);
  markDirty();
  scheduleIDBSave();
}

async function addTemplateFromData(saved, list = templates) {
  try {
    const img = await loadImg(saved.origImageURL);
    const tpl = {
      id: saved.id,
      name: saved.name,
      origImage: img,
      origImageURL: saved.origImageURL,
      x: saved.x,
      y: saved.y,
      w: saved.w,
      h: saved.h,
      opacity: saved.opacity ?? 0.8,
      visible: saved.visible !== false,
      confirmed: !!saved.confirmed,
      filterActive: saved.filterCI >= 0,
      filterCI: saved.filterCI ?? -1,
      filterCanvas: null,
      canvas: null,
      rawIndices: null,
      stitchCanvas: null,
    };
    if (tpl.confirmed) {
      const W = Math.max(10, Math.round(tpl.w));
      const H = Math.max(10, Math.round(tpl.h));
      const { canvas, rawIndices } = buildPaletteCanvas(img, W, H);
      tpl.canvas = canvas;
      tpl.rawIndices = rawIndices;
      tpl.stitchCanvas = makeStitchCanvas(rawIndices, W, H);
      if (tpl.filterCI >= 0) {
        tpl.filterCanvas = makeFilterStitchCanvas(rawIndices, W, H, tpl.filterCI);
      }
    }
    list.push(tpl);
  } catch (e) {
    console.warn('Could not load remote template', saved.name, e);
  }
}

function sendTemplateUpdate(tpl) {
  if (!wsReady) return;
  ws.send(JSON.stringify({
    type: 'template_update',
    id: tpl.id,
    updates: {
      x: tpl.x,
      y: tpl.y,
      w: tpl.w,
      h: tpl.h,
      opacity: tpl.opacity,
      visible: tpl.visible,
      confirmed: tpl.confirmed
    }
  }));
}

function updateOnlineChip(count) {
  let chip = document.getElementById('online-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.id = 'online-chip';
    chip.className = 'chip chip-online';
    chip.title = 'Estado de conexión';
    const chips = document.querySelector('.tb-info-chips');
    if (chips) chips.appendChild(chip);
  }
  if (!wsReady) {
    chip.textContent = '⬤ conectando…';
    chip.style.color = 'var(--danger)';
  } else if (count !== null && count !== undefined && count > 0) {
    chip.textContent = '⬤ ' + count + ' en línea';
    chip.style.color = 'var(--success)';
  } else {
    chip.textContent = '⬤ en línea';
    chip.style.color = 'var(--success)';
  }
}

async function loadCanvasFromServer() {
  // 1. Try local server endpoint
  try {
    const res = await fetch('/api/canvas', { cache: 'no-cache' });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const data = new Uint8Array(buf);
      if (data.length === CS * CS) {
        buildCanvasFromData(data);
        markDirty();
        return true;
      }
    }
  } catch (e) {}

  // 2. Fallback: Supabase Storage Global CDN (works on Vercel or when server is remote)
  try {
    const cdnUrl = SUPABASE_CONFIG.cdnCanvas + '?t=' + Date.now();
    const res = await fetch(cdnUrl, { cache: 'no-cache' });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const data = new Uint8Array(buf);
      if (data.length === CS * CS) {
        buildCanvasFromData(data);
        markDirty();
        return true;
      }
    }
  } catch (e) {
    console.warn('[CDN] No se pudo cargar canvas desde Supabase CDN', e);
  }

  return false;
}

function hexToRGB(h) {
  h = h.replace('#', '');
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

let paletteHex = [...BASE_PALETTE];
let palRGB     = paletteHex.map(hexToRGB);
let palRGBStrings = palRGB.map(([r, g, b]) => 'rgb(' + r + ',' + g + ',' + b + ')');
let palUint32  = new Uint32Array(BASE_PALETTE.length);

function initPaletteUint32() {
  palUint32 = new Uint32Array(palRGB.length);
  for (let i = 0; i < palRGB.length; i++) {
    const [r, g, b] = palRGB[i];
    // In little-endian RGBA memory: byte 0=R, byte 1=G, byte 2=B, byte 3=A (255)
    palUint32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
}
initPaletteUint32();

/* === Global State === */
let offscreen = null, offCtx = null;
let PAL_ID    = [];
let canvasData = null;
let isLightThemeCached = false;
let coordDisplayEl = null, zoomDisplayEl = null, pxCursorEl = null;
let lastCoordX = -999, lastCoordY = -999;
let cachedCanvasRect = null;

let vx = 0, vy = 0, vz = 1;
let panning = false, panX = 0, panY = 0;
let drawing  = false, drawLX = -1, drawLY = -1;
let shapeStart = null;
let spaceHeld  = false, spLX = -1, spLY = -1;
let canvasLocked = false;

let tool        = 'brush';
let brushSize   = 1;
let shapeFilled = true;

let currentColorHex = '#000000';
let bgColorHex      = '#FFFFFF';
let recentColors    = [];
let favColors       = [];

let templates   = [];
let exportScale = 1;
let idbSaveTmr  = null;
let idb         = null;
let dirty = false, rafId = null;
let tplSaveTmr  = null;
let paintModeActive = false; // When false, canvas is navigation-only (no drawing)

/* Resize state */
let resizeTpl    = null;
let resizeHandle = null;
let resizeStart  = null;

/* Body drag (unconfirmed only) */
let tplDragId = null, tplDragOX = 0, tplDragOY = 0;

/* === DOM === */
const $ = id => document.getElementById(id);
const mainCanvas  = $('main-canvas');
const ghostCanvas = $('ghost-canvas');
const ctx         = mainCanvas.getContext('2d');
const ghostCtx    = ghostCanvas.getContext('2d');
const wrap        = $('canvas-wrap');

/* === Utilities === */
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function inCanvas(x, y)   { return x >= 0 && x < CS && y >= 0 && y < CS; }
function s2c(sx, sy)      { return { x: Math.floor(sx / vz + vx), y: Math.floor(sy / vz + vy) }; }
function setProgress(p)   { $('ld-bar').style.width = p + '%'; }
function setLoadTxt(t)    { $('ld-txt').textContent = t; }
function hideLoading() {
  const el = $('loading'); el.classList.add('fade');
  setTimeout(() => el.style.display = 'none', 450);
}

let toastTmr = null;
function showToast(msg, type) {
  const t = $('toast'); t.textContent = msg;
  t.className = 'toast' + (type ? ' toast-' + type : '');
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => t.classList.add('hidden'), 2800);
}

/* === IndexedDB (v2: canvas + templates stores) === */
function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE))   db.createObjectStore(DB_STORE);
      if (!db.objectStoreNames.contains(DB_TPL))     db.createObjectStore(DB_TPL);
    };
    req.onsuccess = e => { idb = e.target.result; res(idb); };
    req.onerror   = rej;
  });
}
function idbSave(data) {
  if (!idb || !data) return;
  idb.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(data, 'main');
}
function idbLoad() {
  return new Promise(res => {
    if (!idb) return res(null);
    const req = idb.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('main');
    req.onsuccess = e => res(e.target.result || null);
    req.onerror   = ()  => res(null);
  });
}
function scheduleIDBSave() {
  clearTimeout(idbSaveTmr);
  idbSaveTmr = setTimeout(() => { if (canvasData) idbSave(canvasData); }, 4000);
}

/* === Template Persistence === */
function scheduleTemplateSave() {
  clearTimeout(tplSaveTmr);
  tplSaveTmr = setTimeout(saveTemplatesToIDB, 1500);
}

async function saveTemplatesToIDB() {
  if (!idb) return;
  const list = templates.map(tpl => ({
    id:            tpl.id,
    name:          tpl.name,
    origImageURL:  tpl.origImageURL,
    x:             tpl.x,
    y:             tpl.y,
    w:             tpl.w,
    h:             tpl.h,
    opacity:       tpl.opacity,
    visible:       tpl.visible,
    confirmed:     tpl.confirmed,
    filterCI:      tpl.filterCI,
    // store rawIndices as plain array (IDB-safe serialization)
    rawIndices:    tpl.rawIndices ? Array.from(tpl.rawIndices) : null,
  }));
  const tx = idb.transaction(DB_TPL, 'readwrite');
  tx.objectStore(DB_TPL).put(list, 'list');
}

function loadTemplatesIDB() {
  return new Promise(res => {
    if (!idb) return res([]);
    const req = idb.transaction(DB_TPL, 'readonly').objectStore(DB_TPL).get('list');
    req.onsuccess = e => res(e.target.result || []);
    req.onerror   = ()  => res([]);
  });
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src;
  });
}

async function restoreTemplatesFromIDB() {
  const list = await loadTemplatesIDB();
  if (!list || !list.length) return;
  for (const saved of list) {
    try {
      const img = await loadImg(saved.origImageURL);
      const tpl = {
        id: saved.id, name: saved.name,
        origImage: img, origImageURL: saved.origImageURL,
        x: saved.x, y: saved.y, w: saved.w, h: saved.h,
        opacity: saved.opacity, visible: saved.visible,
        confirmed: saved.confirmed,
        filterActive: false, filterCI: saved.filterCI || -1, filterCanvas: null,
        canvas: null, rawIndices: null, stitchCanvas: null,
      };
      if (saved.confirmed && saved.rawIndices) {
        tpl.rawIndices = new Int16Array(saved.rawIndices);
        tpl.canvas     = buildCanvasFromRawIndices(tpl.rawIndices, saved.w, saved.h);
        tpl.stitchCanvas = makeStitchCanvas(tpl.rawIndices, saved.w, saved.h);
      }
      templates.push(tpl);
    } catch(e) { console.warn('Could not restore template', saved.name, e); }
  }
  renderTemplateList();
  markDirty();
}

/* === Offscreen canvas === */
function initOffscreen() {
  if (offscreen) return;
  offscreen = document.createElement('canvas');
  offscreen.width = offscreen.height = CS;
  offCtx = offscreen.getContext('2d', { willReadFrequently: false });
  initPaletteUint32();
  rebuildPAL_ID();
}
function rebuildPAL_ID() {
  PAL_ID = palRGB.map(([r, g, b]) => {
    const id = new ImageData(1, 1);
    id.data[0] = r; id.data[1] = g; id.data[2] = b; id.data[3] = 255;
    return id;
  });
}
function buildCanvasFromData(data) {
  canvasData = data;
  const img = offCtx.createImageData(CS, CS);
  const u32 = new Uint32Array(img.data.buffer);
  const p32 = palUint32;
  const len = data.length;
  for (let i = 0; i < len; i++) {
    u32[i] = p32[data[i]] || p32[0];
  }
  offCtx.putImageData(img, 0, 0);
}
function setPixelPalette(x, y, ci) {
  if (ci < 0 || ci >= palRGB.length) return;
  offCtx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
  offCtx.fillRect(x, y, 1, 1);
  if (canvasData) canvasData[y * CS + x] = ci;
}
/* Perceptual Redmean color distance for human visual color matching */
function colorDistanceRedmean(r1, g1, b1, r2, g2, b2) {
  const rmean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db;
}

function nearestPaletteIndexRGB(r, g, b) {
  let best = 0, bestD = Infinity;
  for (let p = 0; p < palRGB.length; p++) {
    const [pr, pg, pb] = palRGB[p];
    const d = colorDistanceRedmean(r, g, b, pr, pg, pb);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function nearestPaletteIndex(hex) {
  const [r, g, b] = hexToRGB(hex);
  return nearestPaletteIndexRGB(r, g, b);
}

function markDirty() { dirty = true; if (!rafId) rafId = requestAnimationFrame(loop); }
function loop()      { rafId = null; if (dirty) { dirty = false; render(); } }

/* === Template canvas builders === */
function makeStitchCanvas(rawIndices, W, H) {
  const sc = document.createElement('canvas');
  sc.width = W * STITCH_CELL; sc.height = H * STITCH_CELL;
  const sctx = sc.getContext('2d');
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ci = rawIndices[py * W + px];
      if (ci < 0) continue;
      const [r, g, b] = palRGB[ci];
      sctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
      sctx.fillRect(px*STITCH_CELL+STITCH_GAP, py*STITCH_CELL+STITCH_GAP, STITCH_CELL-2*STITCH_GAP, STITCH_CELL-2*STITCH_GAP);
    }
  }
  return sc;
}
function makeFilterStitchCanvas(rawIndices, W, H, targetCI) {
  const sc = document.createElement('canvas');
  sc.width = W * STITCH_CELL; sc.height = H * STITCH_CELL;
  const sctx = sc.getContext('2d');
  const [r, g, b] = palRGB[targetCI] || [0,0,0];
  sctx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (rawIndices[py*W+px] !== targetCI) continue;
      sctx.fillRect(px*STITCH_CELL+STITCH_GAP, py*STITCH_CELL+STITCH_GAP, STITCH_CELL-2*STITCH_GAP, STITCH_CELL-2*STITCH_GAP);
    }
  }
  return sc;
}
function buildPaletteCanvas(origImage, W, H) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(origImage, 0, 0, W, H);
  const src = tctx.getImageData(0, 0, W, H), dst = tctx.createImageData(W, H);
  const rawIndices = new Int16Array(W * H).fill(-1);
  for (let i = 0; i < src.data.length; i += 4) {
    const pi = i/4, a = src.data[i+3];
    if (a < 60) { dst.data[i+3] = 0; continue; }
    const r = src.data[i], g = src.data[i+1], b = src.data[i+2];
    const best = nearestPaletteIndexRGB(r, g, b);
    rawIndices[pi] = best;
    const [nr,ng,nb] = palRGB[best];
    dst.data[i]=nr; dst.data[i+1]=ng; dst.data[i+2]=nb; dst.data[i+3]=235;
  }
  tctx.putImageData(dst, 0, 0);
  return { canvas: tmp, rawIndices };
}
function buildCanvasFromRawIndices(rawIndices, W, H) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d'), img = tctx.createImageData(W, H);
  for (let i = 0; i < rawIndices.length; i++) {
    const ci = rawIndices[i];
    if (ci < 0) { img.data[i*4+3]=0; continue; }
    const [r,g,b] = palRGB[ci];
    img.data[i*4]=r; img.data[i*4+1]=g; img.data[i*4+2]=b; img.data[i*4+3]=220;
  }
  tctx.putImageData(img, 0, 0);
  return tmp;
}
function stampTemplate(tpl) {
  if (!tpl.confirmed || !tpl.rawIndices) return;
  const W = Math.round(tpl.w);
  const H = Math.round(tpl.h);
  const pts = [];
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const ci = tpl.rawIndices[py * W + px];
      if (ci < 0) continue; // skip transparent pixels
      if (tpl.filterActive && tpl.filterCI >= 0 && ci !== tpl.filterCI) continue; // apply filter if active
      const x = Math.round(tpl.x) + px;
      const y = Math.round(tpl.y) + py;
      if (x >= 0 && x < CS && y >= 0 && y < CS) {
        setPixelPalette(x, y, ci);
        pts.push({ x, y, c: ci });
      }
    }
  }
  markDirty();
  scheduleIDBSave();
  
  // Send to server if connected
  if (wsReady && pts.length > 0) {
    // Send in batches of max 1000 to avoid oversized messages
    const batchSize = 1000;
    for (let i = 0; i < pts.length; i += batchSize) {
      const batch = pts.slice(i, i + batchSize);
      ws.send(JSON.stringify({ type: 'batch', pixels: batch }));
    }
  }
  showToast('Plantilla estampada! (' + pts.length + ' píxeles aplicados', 'success');
}

function confirmTemplate(tpl) {
  const W = Math.max(10, Math.round(tpl.w));
  const H = Math.max(10, Math.round(tpl.h));
  showToast('Procesando plantilla...', '');
  setTimeout(() => {
    const { canvas, rawIndices } = buildPaletteCanvas(tpl.origImage, W, H);
    tpl.canvas = canvas; tpl.rawIndices = rawIndices;
    tpl.w = W; tpl.h = H;
    tpl.stitchCanvas = makeStitchCanvas(rawIndices, W, H);
    tpl.confirmed = true; tpl.filterActive = false; tpl.filterCI = -1; tpl.filterCanvas = null;
    renderTemplateList(); markDirty();
    scheduleTemplateSave();
    sendTemplateUpdate(tpl); // Sync with other clients!
    showToast('Plantilla confirmada como guía!', 'success');
  }, 50);
}

/* === Handle helpers === */
function getHandlePositions(tx, ty, tw, th) {
  const cx = tx+tw/2, cy = ty+th/2;
  return [
    {id:'tl',sx:tx,    sy:ty   }, {id:'tc',sx:cx,    sy:ty   }, {id:'tr',sx:tx+tw,sy:ty   },
    {id:'ml',sx:tx,    sy:cy   },                                 {id:'mr',sx:tx+tw,sy:cy   },
    {id:'bl',sx:tx,    sy:ty+th}, {id:'bc',sx:cx,    sy:ty+th}, {id:'br',sx:tx+tw,sy:ty+th},
  ];
}
const HANDLE_CURSORS = {tl:'nw-resize',tc:'n-resize',tr:'ne-resize',ml:'w-resize',mr:'e-resize',bl:'sw-resize',bc:'s-resize',br:'se-resize'};
function hitTestHandles(sx, sy) {
  const R = 9;
  for (let i = templates.length-1; i >= 0; i--) {
    const tpl = templates[i];
    if (tpl.confirmed || !tpl.visible) continue;
    const tx=Math.round((tpl.x-vx)*vz), ty=Math.round((tpl.y-vy)*vz);
    const tw=Math.round(tpl.w*vz),      th=Math.round(tpl.h*vz);
    for (const h of getHandlePositions(tx, ty, tw, th)) {
      if (Math.hypot(sx-h.sx, sy-h.sy) <= R) return { tpl, handle: h.id };
    }
  }
  return null;
}

/* === Render === */
function render() {
  if (!offscreen || !mainCanvas) return;
  const W = mainCanvas.width, H = mainCanvas.height;
  if (!W || !H) return;

  const isLight = isLightThemeCached;
  ctx.fillStyle = isLight ? '#eef2f6' : '#181825';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const srcW = W / vz, srcH = H / vz;
  const sx = clamp(vx, 0, CS), sy = clamp(vy, 0, CS);
  const ex = clamp(vx + srcW, 0, CS), ey = clamp(vy + srcH, 0, CS);
  if (sx < ex && sy < ey) {
    ctx.drawImage(offscreen, sx, sy, ex - sx, ey - sy, (sx - vx) * vz, (sy - vy) * vz, (ex - sx) * vz, (ey - sy) * vz);
  }

  const bx = Math.round(-vx * vz) + .5, by = Math.round(-vy * vz) + .5;
  ctx.strokeStyle = isLight ? 'rgba(99, 102, 241, 0.4)' : 'rgba(129, 140, 248, 0.5)';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, CS * vz, CS * vz);
  if (vz >= 7) drawGrid(W, H, srcW, srcH);

  const tplCount = templates.length;
  for (let i = 0; i < tplCount; i++) {
    const tpl = templates[i];
    if (!tpl.visible) return;
    const tx = Math.round((tpl.x - vx) * vz), ty = Math.round((tpl.y - vy) * vz);
    const tw = Math.round(tpl.w * vz),      th = Math.round(tpl.h * vz);
    if (tw <= 0 || th <= 0) continue;
    // Viewport Culling
    if (tx + tw < 0 || tx > W || ty + th < 0 || ty > H) continue;

    ctx.globalAlpha = tpl.opacity;
    if (!tpl.confirmed) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tpl.origImage, tx, ty, tw, th);
      ctx.imageSmoothingEnabled = false;
    } else {
      // Confirmed template: draw as small guide dots/squares with batching
      if (vz >= 3 && tpl.rawIndices) {
        const dotSize = Math.max(1, Math.round(vz * 0.35));
        const offset = (vz - dotSize) / 2;
        const roundedW = Math.round(tpl.w);
        const roundedH = Math.round(tpl.h);
        const roundedTplX = Math.round(tpl.x);
        const roundedTplY = Math.round(tpl.y);

        const startX = Math.max(roundedTplX, Math.floor(vx));
        const endX = Math.min(roundedTplX + roundedW, Math.ceil(vx + srcW));
        const startY = Math.max(roundedTplY, Math.floor(vy));
        const endY = Math.min(roundedTplY + roundedH, Math.ceil(vy + srcH));

        // Group coordinates by color index to batch fillRect calls (massive FPS boost)
        const buckets = new Array(palRGB.length);
        for (let y = startY; y < endY; y++) {
          const py = y - roundedTplY;
          if (py < 0 || py >= roundedH) continue;
          const cy = (y - vy) * vz + offset;
          const rowOffset = py * roundedW;
          for (let x = startX; x < endX; x++) {
            const px = x - roundedTplX;
            if (px < 0 || px >= roundedW) continue;
            const ci = tpl.rawIndices[rowOffset + px];
            if (ci < 0) continue;
            if (tpl.filterActive && tpl.filterCI >= 0 && ci !== tpl.filterCI) continue;
            const cx = (x - vx) * vz + offset;
            if (!buckets[ci]) buckets[ci] = [];
            buckets[ci].push(cx, cy);
          }
        }

        for (let ci = 0; ci < buckets.length; ci++) {
          const coords = buckets[ci];
          if (!coords || !coords.length) continue;
          ctx.fillStyle = palRGBStrings[ci];
          for (let k = 0; k < coords.length; k += 2) {
            ctx.fillRect(coords[k], coords[k + 1], dotSize, dotSize);
          }
        }
      } else {
        if (tpl.filterActive && tpl.filterCanvas) {
          ctx.drawImage(tpl.filterCanvas, tx, ty, tw, th);
        } else if (tpl.stitchCanvas) {
          ctx.drawImage(tpl.stitchCanvas, tx, ty, tw, th);
        } else if (tpl.canvas) {
          ctx.drawImage(tpl.canvas, tx, ty, tw, th);
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = !tpl.confirmed ? 'rgba(255,220,50,.9)' : tpl.filterActive ? (tpl.filterCI >= 0 ? paletteHex[tpl.filterCI] : '#fff') : 'rgba(90,150,255,.5)';
    ctx.lineWidth = tpl.confirmed ? 1 : 2;
    ctx.setLineDash([5, 4]); ctx.strokeRect(tx + .5, ty + .5, tw - 1, th - 1); ctx.setLineDash([]);
    if (!tpl.confirmed) {
      getHandlePositions(tx, ty, tw, th).forEach(h => {
        ctx.beginPath(); ctx.arc(h.sx, h.sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#4a9eff'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.stroke();
      });
    }
  }
}

function drawGrid(W, H, srcW, srcH) {
  ctx.strokeStyle = 'rgba(255,255,255,.04)'; ctx.lineWidth = .5;
  const x0 = Math.max(0, Math.floor(vx)), y0 = Math.max(0, Math.floor(vy));
  const x1 = Math.min(CS, Math.ceil(vx + srcW)), y1 = Math.min(CS, Math.ceil(vy + srcH));
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) { const p = (x - vx) * vz; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
  for (let y = y0; y <= y1; y++) { const p = (y - vy) * vz; ctx.moveTo(0, p); ctx.lineTo(W, p); }
  ctx.stroke();
}

/* === Ghost canvas === */
function clearGhost(){ghostCtx.clearRect(0,0,ghostCanvas.width,ghostCanvas.height);}
function renderGhost(x0,y0,x1,y1){
  clearGhost();
  const [r,g,b]=hexToRGB(currentColorHex);
  ghostCtx.fillStyle='rgba('+r+','+g+','+b+',0.5)';
  ghostCtx.strokeStyle='rgba('+r+','+g+','+b+',0.9)';
  ghostCtx.lineWidth=1; ghostCtx.imageSmoothingEnabled=false;
  const px0=(x0-vx)*vz,py0=(y0-vy)*vz,px1=(x1-vx)*vz,py1=(y1-vy)*vz;
  if(tool==='line'){ghostCtx.beginPath();ghostCtx.moveTo(px0+vz/2,py0+vz/2);ghostCtx.lineTo(px1+vz/2,py1+vz/2);ghostCtx.stroke();}
  else if(tool==='rect'){const rx=Math.min(px0,px1),ry=Math.min(py0,py1),rw=Math.abs(px1-px0)+vz,rh=Math.abs(py1-py0)+vz;if(shapeFilled)ghostCtx.fillRect(rx,ry,rw,rh);else ghostCtx.strokeRect(rx+.5,ry+.5,rw-1,rh-1);}
  else if(tool==='circle'){ghostCtx.beginPath();ghostCtx.ellipse((px0+px1)/2+vz/2,(py0+py1)/2+vz/2,Math.abs(px1-px0)/2+vz/2,Math.abs(py1-py0)/2+vz/2,0,0,Math.PI*2);if(shapeFilled)ghostCtx.fill();else ghostCtx.stroke();}
}

/* === Zoom/Pan === */
function doZoom(f,cx,cy){const nz=clamp(vz*f,MIN_Z,MAX_Z);if(nz===vz)return;const wx=cx/vz+vx,wy=cy/vz+vy;vz=nz;vx=wx-cx/vz;vy=wy-cy/vz;$('zoom-display').textContent=Math.round(vz*100)+'%';markDirty();}
function fitCanvas(){vz=Math.min(mainCanvas.width/CS,mainCanvas.height/CS);vx=CS/2-mainCanvas.width/2/vz;vy=CS/2-mainCanvas.height/2/vz;$('zoom-display').textContent=Math.round(vz*100)+'%';markDirty();}
function goTo(cx,cy){vx=cx-mainCanvas.width/2/vz;vy=cy-mainCanvas.height/2/vz;markDirty();}

/* === Tools === */
function setTool(t){
  tool=t;
  document.querySelectorAll('.tool-btn').forEach(b=>b.classList.remove('active'));
  const btn=$('tool-'+t);if(btn)btn.classList.add('active');
  wrap.className='cursor-'+t;
  const bsa = $('brush-size-area');
  if (bsa) bsa.style.display = (t === 'brush' || t === 'erase') ? 'flex' : 'none';
  const soa = $('shape-opts-area');
  if (soa) soa.style.display = (t === 'rect' || t === 'circle') ? 'flex' : 'none';
  clearGhost();shapeStart=null;
  const el=$('px-cursor');el.style.background='';el.style.border='';el.style.boxShadow='';
  /* Update bottom bar tool name */
  const names={brush:'Pincel (B)',erase:'Borrador (E)',eye:'Gotas (I)',line:'Linea (L)',rect:'Rectangulo (R)',circle:'Circulo (C)'};
  const bb=$('bb-tool-name');if(bb)bb.textContent=names[t]||t;
}
function setShapeFilled(f){shapeFilled=f;$('opt-filled').classList.toggle('active',f);$('opt-hollow').classList.toggle('active',!f);}

/* === Color === */
let currentPaletteCI = 5; // Default to black (#000000)

function setCurrentColor(hex,addToRecent){
  if(addToRecent===undefined)addToRecent=true;
  currentColorHex=hex;
  currentPaletteCI = nearestPaletteIndex(hex);
  $('cur-fg-color').style.backgroundColor=hex;
  $('cur-hex').textContent=hex.toUpperCase();
  $('custom-color').value=hex;
  if(addToRecent)addToRecentColors(hex);
  /* Mark selected swatch in bottom palette */
  document.querySelectorAll('#palette-grid .swatch').forEach(s=>{
    s.classList.toggle('sel',s.dataset.hex===hex.toUpperCase());
  });
  templates.forEach(tpl=>{
    if(tpl.confirmed&&tpl.filterActive){
      const ci=nearestPaletteIndex(hex);
      tpl.filterCI=ci;
      tpl.filterCanvas=makeFilterStitchCanvas(tpl.rawIndices,tpl.w,tpl.h,ci);
      markDirty();
    }
  });
}
function setBgColor(hex){bgColorHex=hex;$('cur-bg-color').style.backgroundColor=hex;}
function addToRecentColors(hex){hex=hex.toUpperCase();recentColors=recentColors.filter(c=>c!==hex);recentColors.unshift(hex);if(recentColors.length>MAX_RECENT)recentColors=recentColors.slice(0,MAX_RECENT);savePrefs();renderRecentColors();}
function addToFavColors(hex){hex=hex.toUpperCase();if(favColors.includes(hex)){showToast('Ya esta en favoritos','');return;}if(favColors.length>=MAX_FAVS){showToast('Favoritos llenos','');return;}favColors.push(hex);savePrefs();renderFavColors();showToast('Color guardado en favoritos','success');}
function removeFromFavs(hex){favColors=favColors.filter(c=>c!==hex);savePrefs();renderFavColors();}
function swapColors(){const tmp=currentColorHex;setCurrentColor(bgColorHex,false);setBgColor(tmp);}

/* === Palette UI === */
function buildPalette(){const g=$('palette-grid');g.innerHTML='';paletteHex.forEach(hex=>{
  const d=document.createElement('div');
  d.className='swatch';d.style.backgroundColor=hex;d.title=hex;d.dataset.hex=hex.toUpperCase();
  if(hex.toUpperCase()===currentColorHex.toUpperCase())d.classList.add('sel');
  d.addEventListener('click',()=>setCurrentColor(hex));g.appendChild(d);
});}
function renderRecentColors(){const g=$('recent-colors');g.innerHTML='';for(let i=0;i<MAX_RECENT;i++){const d=document.createElement('div');if(recentColors[i]){d.className='swatch';d.style.backgroundColor=recentColors[i];d.title=recentColors[i];const hex=recentColors[i];d.addEventListener('click',()=>setCurrentColor(hex));}else{d.className='swatch empty';}g.appendChild(d);}}
function renderFavColors(){const g=$('fav-colors');g.innerHTML='';for(let i=0;i<MAX_FAVS;i++){const d=document.createElement('div');if(favColors[i]){d.className='swatch';d.style.backgroundColor=favColors[i];d.title=favColors[i];const hex=favColors[i];d.addEventListener('click',()=>setCurrentColor(hex));d.addEventListener('contextmenu',e=>{e.preventDefault();removeFromFavs(hex);});}else{d.className='swatch empty';}g.appendChild(d);}}

/* === Eyedropper === */
function sampleScreenAt(sx,sy){
  try{
    const {x, y} = s2c(sx, sy);
    // 1. Try to sample from visible templates first
    for (let i = templates.length - 1; i >= 0; i--) {
      const tpl = templates[i];
      if (!tpl.visible || !tpl.confirmed || !tpl.rawIndices) continue;
      const px = Math.floor(x - tpl.x);
      const py = Math.floor(y - tpl.y);
      if (px >= 0 && px < tpl.w && py >= 0 && py < tpl.h) {
        const ci = tpl.rawIndices[py * Math.round(tpl.w) + px];
        if (ci >= 0) {
          return paletteHex[ci];
        }
      }
    }
    // 2. Fall back to canvas board data
    if (canvasData && inCanvas(x, y)) {
      const ci = canvasData[y * CS + x];
      return paletteHex[ci] || '#FFFFFF';
    }
  }catch(e){}
  return null;
}

/* === Hover === */
function updateHover(sx, sy) {
  if (!coordDisplayEl) coordDisplayEl = $('coord-display');
  if (!pxCursorEl) pxCursorEl = $('px-cursor');
  const { x, y } = s2c(sx, sy);
  if (!inCanvas(x, y)) {
    pxCursorEl.classList.add('hidden');
    if (lastCoordX !== -1 || lastCoordY !== -1) {
      if (coordDisplayEl) coordDisplayEl.textContent = '— , —';
      lastCoordX = -1; lastCoordY = -1;
    }
    mainCanvas.style.cursor = '';
    return;
  }
  if (lastCoordX !== x || lastCoordY !== y) {
    if (coordDisplayEl) coordDisplayEl.textContent = x + ' , ' + y;
    lastCoordX = x; lastCoordY = y;
  }
  const el = pxCursorEl;
  const hh = hitTestHandles(sx, sy);
  if (hh) {
    mainCanvas.style.cursor = HANDLE_CURSORS[hh.handle] || 'default';
    el.classList.add('hidden');
    return;
  }
  let overBody = false;
  for (let i = templates.length - 1; i >= 0; i--) {
    const t = templates[i];
    if (t.confirmed || !t.visible) continue;
    if (x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h) {
      overBody = true; break;
    }
  }
  if (overBody) {
    mainCanvas.style.cursor = 'move';
    el.classList.add('hidden');
    return;
  }
  mainCanvas.style.cursor = '';
  if (tool === 'eye') {
    const hex = sampleScreenAt(sx, sy);
    el.style.left = Math.round((x - vx) * vz) + 'px';
    el.style.top = Math.round((y - vy) * vz) + 'px';
    el.style.width = Math.max(Math.round(vz), 8) + 'px';
    el.style.height = Math.max(Math.round(vz), 8) + 'px';
    el.style.background = hex || 'transparent';
    el.style.border = '2px solid rgba(255,255,255,0.9)';
    el.style.boxShadow = hex ? '0 0 0 1px rgba(0,0,0,.5),0 0 10px ' + hex : '';
    el.classList.remove('hidden');
    if (hex && coordDisplayEl) coordDisplayEl.textContent = x + ' , ' + y + '  |  ' + hex.toUpperCase();
    return;
  }
  el.style.background = ''; el.style.border = ''; el.style.boxShadow = '';
  if (vz < 4) { el.classList.add('hidden'); return; }
  const half = Math.floor(brushSize / 2);
  el.style.left = (x - half - vx) * vz + 'px';
  el.style.top = (y - half - vy) * vz + 'px';
  el.style.width = brushSize * vz + 'px';
  el.style.height = brushSize * vz + 'px';
  el.classList.remove('hidden');
}

/* === Painting === */
function floodFill(sx,sy,newHex){if(!canvasData)return;const ni=nearestPaletteIndex(newHex);const idx0=sy*CS+sx;const oi=canvasData[idx0];if(oi===ni)return;const q=[idx0],v=new Uint8Array(CS*CS);v[idx0]=1;while(q.length){const ci=q.pop(),cx=ci%CS;canvasData[ci]=ni;offCtx.putImageData(PAL_ID[ni],cx,Math.floor(ci/CS));for(const nn of[ci-1,ci+1,ci-CS,ci+CS]){if(nn<0||nn>=CS*CS||v[nn])continue;if(Math.abs((nn%CS)-cx)>1)continue;if(canvasData[nn]===oi){v[nn]=1;q.push(nn);}}}markDirty();scheduleIDBSave();}
function bresenhamLine(x0,y0,x1,y1,fn){const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let err=dx-dy;for(;;){fn(x0,y0);if(x0===x1&&y0===y1)break;const e2=2*err;if(e2>-dy){err-=dy;x0+=sx;}if(e2<dx){err+=dx;y0+=sy;}}}
function paintBrush(cx,cy,ci){const r=Math.floor(brushSize/2);if(brushSize===1){if(inCanvas(cx,cy))setPixelPalette(cx,cy,ci);return;}for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const px=cx+dx,py=cy+dy;if(inCanvas(px,py))setPixelPalette(px,py,ci);}}
function paintRect(x0, y0, x1, y1, ci, f) {
  const lx = Math.max(0, Math.min(x0, x1));
  const rx = Math.min(CS - 1, Math.max(x0, x1));
  const ty = Math.max(0, Math.min(y0, y1));
  const by = Math.min(CS - 1, Math.max(y0, y1));
  const w = rx - lx + 1;
  const h = by - ty + 1;
  if (w <= 0 || h <= 0) return;

  offCtx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
  if (f) {
    offCtx.fillRect(lx, ty, w, h);
    if (canvasData) {
      for (let y = ty; y <= by; y++) {
        const rowOffset = y * CS + lx;
        canvasData.fill(ci, rowOffset, rowOffset + w);
      }
    }
  } else {
    offCtx.fillRect(lx, ty, w, 1);
    offCtx.fillRect(lx, by, w, 1);
    offCtx.fillRect(lx, ty, 1, h);
    offCtx.fillRect(rx, ty, 1, h);
    if (canvasData) {
      for (let x = lx; x <= rx; x++) {
        canvasData[ty * CS + x] = ci;
        canvasData[by * CS + x] = ci;
      }
      for (let y = ty + 1; y < by; y++) {
        canvasData[y * CS + lx] = ci;
        canvasData[y * CS + rx] = ci;
      }
    }
  }
}

function paintEllipse(cx, cy, a, b, ci, f) {
  a = Math.max(0, a); b = Math.max(0, b);
  offCtx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
  if (f) {
    for (let dy = -b; dy <= b; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= CS) continue;
      const xs = Math.round(a * Math.sqrt(Math.max(0, 1 - (dy * dy) / (b * b + 0.0001))));
      const lx = Math.max(0, cx - xs);
      const rx = Math.min(CS - 1, cx + xs);
      const w = rx - lx + 1;
      if (w > 0) {
        offCtx.fillRect(lx, py, w, 1);
        if (canvasData) {
          const rowOffset = py * CS + lx;
          canvasData.fill(ci, rowOffset, rowOffset + w);
        }
      }
    }
  } else {
    const drawPixel = (ex, ey) => {
      if (inCanvas(ex, ey)) setPixelPalette(ex, ey, ci);
    };
    let x = 0, y = b, d1 = (b * b) - (a * a * b) + 0.25 * a * a, ddx = 0, ddy = 2 * a * a * b;
    const p4 = (px, py) => {
      [[cx + px, cy + py], [cx - px, cy + py], [cx + px, cy - py], [cx - px, cy - py]].forEach(([ex, ey]) => drawPixel(ex, ey));
    };
    while (ddx < ddy) {
      p4(x, y);
      if (d1 < 0) { x++; ddx += 2 * b * b; d1 += ddx + b * b; }
      else { x++; y--; ddx += 2 * b * b; ddy -= 2 * a * a; d1 += ddx - ddy + b * b; }
    }
    let d2 = (b * b) * (x + 0.5) * (x + 0.5) + (a * a) * (y - 1) * (y - 1) - (a * a * b * b);
    while (y >= 0) {
      p4(x, y);
      if (d2 > 0) { y--; ddy -= 2 * a * a; d2 += a * a - ddy; }
      else { x++; y--; ddx += 2 * b * b; ddy -= 2 * a * a; d2 += ddx - ddy + a * a; }
    }
  }
}

function paintPixelMain(x, y) {
  if (!inCanvas(x, y)) return;
  const ci = currentPaletteCI;
  paintBrush(x, y, ci);
  markDirty();
  queueWSPixel(x, y, ci);
}

function paintLineMain(x0, y0, x1, y1) {
  const ci = currentPaletteCI;
  bresenhamLine(x0, y0, x1, y1, (x, y) => {
    paintBrush(x, y, ci);
    queueWSPixel(x, y, ci);
  });
  markDirty();
}

function commitShape(x0, y0, x1, y1) {
  const ci = currentPaletteCI;
  if (tool === 'rect') {
    paintRect(x0, y0, x1, y1, ci, shapeFilled);
    sendWSShape({ type: 'rect', x0, y0, x1, y1, c: ci, fill: shapeFilled });
  } else if (tool === 'circle') {
    const cx = Math.round((x0 + x1) / 2);
    const cy = Math.round((y0 + y1) / 2);
    const a = Math.round(Math.abs(x1 - x0) / 2);
    const b = Math.round(Math.abs(y1 - y0) / 2);
    paintEllipse(cx, cy, a, b, ci, shapeFilled);
    sendWSShape({ type: 'circle', cx, cy, a, b, c: ci, fill: shapeFilled });
  } else if (tool === 'line') {
    paintLineMain(x0, y0, x1, y1);
    sendWSShape({ type: 'line', x0, y0, x1, y1, c: ci, size: brushSize });
  }
  markDirty();
  scheduleIDBSave();
  flushWSPixels();
}

/* === Canvas draw event handlers === */
function onMouseDown(e){
  e.preventDefault();
  const rect=mainCanvas.getBoundingClientRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
  if(e.button===1||e.button===2){panning=true;panX=e.clientX;panY=e.clientY;wrap.classList.add('panning');return;}
  if(e.button!==0)return;
  /* If not in paint mode, treat left click as pan */
  if(!paintModeActive){panning=true;panX=e.clientX;panY=e.clientY;wrap.classList.add('panning');return;}
  if(tool==='eye'){const hex=sampleScreenAt(sx,sy);if(hex){setCurrentColor(hex);showToast('Color: '+hex.toUpperCase(),'success');}setTool('brush');return;}
  if(tool==='fill'){if(inCanvas(x,y))floodFill(x,y,currentColorHex);return;}
  if(tool==='line'||tool==='rect'||tool==='circle'){shapeStart={x,y};return;}
  drawing=true;drawLX=x;drawLY=y;
  if(tool==='erase'){
    const ci=0; // Index 0 is white
    paintBrush(x,y,ci);
    markDirty();
    wsSendPixel(x,y,ci);
  }
  else paintPixelMain(x,y);
}
function onMouseMove(e){
  const rect=mainCanvas.getBoundingClientRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
  updateHover(sx,sy);
  if(panning){vx-=(e.clientX-panX)/vz;vy-=(e.clientY-panY)/vz;panX=e.clientX;panY=e.clientY;markDirty();return;}
  if(shapeStart&&e.buttons===1){renderGhost(shapeStart.x,shapeStart.y,x,y);return;}
  if(spaceHeld&&inCanvas(x,y)){
    if(tool==='brush'||tool==='erase'){
      const ci=tool==='erase'?0:currentPaletteCI;
      if(spLX>=0)bresenhamLine(spLX,spLY,x,y,(px,py)=>{paintBrush(px,py,ci);queueWSPixel(px,py,ci);});
      else {paintBrush(x,y,ci);queueWSPixel(x,y,ci);}
      markDirty();
      spLX=x;spLY=y;
    }
    return;
  }
  if(drawing&&e.buttons===1&&inCanvas(x,y)){
    if(tool==='brush'){
      if(x!==drawLX||y!==drawLY)paintLineMain(drawLX,drawLY,x,y);
      drawLX=x;drawLY=y;
    }else if(tool==='erase'){
      const ci=0;
      if(x!==drawLX||y!==drawLY)bresenhamLine(drawLX,drawLY,x,y,(px,py)=>{paintBrush(px,py,ci);queueWSPixel(px,py,ci);});
      markDirty();
      drawLX=x;drawLY=y;
    }
  }
}
function onMouseUp(e){
  if(panning){panning=false;wrap.classList.remove('panning');return;}
  if(shapeStart&&e.button===0){const rect=mainCanvas.getBoundingClientRect(),{x,y}=s2c(e.clientX-rect.left,e.clientY-rect.top);clearGhost();commitShape(shapeStart.x,shapeStart.y,x,y);shapeStart=null;return;}
  if(drawing){drawing=false;drawLX=-1;drawLY=-1;scheduleIDBSave();flushWSPixels();}
}
function onMouseLeave(){$('px-cursor').classList.add('hidden');$('coord-display').textContent='- , -';mainCanvas.style.cursor='';drawing=false;if(panning){panning=false;wrap.classList.remove('panning');}}
function onWheel(e){e.preventDefault();const r=mainCanvas.getBoundingClientRect();doZoom(e.deltaY<0?1.15:1/1.15,e.clientX-r.left,e.clientY-r.top);}
function onKeyDown(e){const tag=e.target.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;switch(e.key.toLowerCase()){case 'b':activatePaintMode('brush');break;case 'e':activatePaintMode('erase');break;case 'i':if(paintModeActive)setTool('eye');break;case 'l':if(paintModeActive)setTool('line');break;case 'r':if(paintModeActive)setTool('rect');break;case 'c':if(paintModeActive)setTool('circle');break;case 'f':fitCanvas();break;case 'x':swapColors();break;case '+':case '=':doZoom(1.25,mainCanvas.width/2,mainCanvas.height/2);break;case '-':doZoom(.8,mainCanvas.width/2,mainCanvas.height/2);break;case '[':setBrushSize(Math.max(1,brushSize-1));break;case ']':setBrushSize(Math.min(32,brushSize+1));break;case 'escape':if(paintModeActive)deactivatePaintMode();break;case ' ':if(!e.repeat){spaceHeld=true;spLX=-1;spLY=-1;}e.preventDefault();break;}}
function onKeyUp(e){if(e.key===' '){spaceHeld=false;spLX=-1;spLY=-1;}}

/* === Paint Mode === */
function activatePaintMode(toolName) {
  paintModeActive = true;
  document.body.classList.add('paint-mode');
  setTool(toolName || tool || 'brush');
}
function deactivatePaintMode() {
  paintModeActive = false;
  document.body.classList.remove('paint-mode');
  
  // Set canvas to pan cursor
  wrap.className = 'cursor-pan';
  drawing = false;
  shapeStart = null;
  clearGhost();
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
}
function applyTheme(theme) {
  const isLight = theme === 'light';
  if (isLight) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  }
  const icon = $('theme-icon');
  const text = $('theme-text');
  if (icon) {
    icon.innerHTML = isLight
      ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
  if (text) {
    text.textContent = isLight ? 'Oscuro' : 'Claro';
  }
  markDirty();
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('bplace_theme', next);
  showToast('Tema ' + (next === 'light' ? 'Claro' : 'Oscuro') + ' activado', 'success');
}
window.toggleTheme = toggleTheme;
window.applyTheme = applyTheme;

/* === Mobile sidebar === */
function toggleMobileSidebar(force) {
  const sidebar = $('sidebar-palette');
  const overlay = $('mobile-overlay');
  const open = typeof force === 'boolean' ? force : !sidebar.classList.contains('mobile-open');
  sidebar.classList.toggle('mobile-open', open);
  if (overlay) overlay.classList.toggle('visible', open);
}

/* === Window resize === */
function resize(){const w=wrap.clientWidth,h=wrap.clientHeight;if(mainCanvas.width!==w||mainCanvas.height!==h){mainCanvas.width=w;mainCanvas.height=h;ghostCanvas.width=w;ghostCanvas.height=h;markDirty();}}
function setBrushSize(s) {
  brushSize = clamp(s, 1, 32);
  const bs = $('brush-size');
  if (bs) bs.value = brushSize;
  const bsv = $('brush-size-val');
  if (bsv) bsv.textContent = brushSize;
}

/* === Template panel toggle (slide, not hide) === */
function toggleTplPanel(){
  const panel=$('tpl-panel');
  panel.classList.toggle('collapsed');
  panel.classList.remove('hidden');   // ensure visible in DOM
  updatePanelTabIcon();
}
function updatePanelTabIcon(){
  const btn=$('tpl-panel-tab');
  if(!btn)return;
  const collapsed=$('tpl-panel').classList.contains('collapsed');
  btn.title=collapsed?'Abrir plantillas':'Contraer plantillas';
  btn.innerHTML=collapsed
    ?'<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>'
    :'<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
}

/* === Template file loading (FileReader for persistence) === */
function loadTemplateFile(file){
  if(templates.length>=MAX_TPLS){showToast('Maximo '+MAX_TPLS+' plantillas','error');return;}
  const reader=new FileReader();
  reader.onload=e=>{
    const dataURL=e.target.result;
    const img=new Image();
    img.onload=()=>{
      const tpl = {
        id:Date.now(),name:file.name,
        origImage:img,origImageURL:dataURL,
        canvas:null,rawIndices:null,stitchCanvas:null,
        filterActive:false,filterCI:-1,filterCanvas:null,
        x:0,y:0,w:img.naturalWidth,h:img.naturalHeight,
        opacity:0.85,visible:true,confirmed:false,
      };
      templates.push(tpl);
      renderTemplateList();markDirty();scheduleTemplateSave();
      
      // Broadcast addition to other clients
      if (wsReady) {
        ws.send(JSON.stringify({
          type: 'template_add',
          template: {
            id: tpl.id,
            name: tpl.name,
            origImageURL: tpl.origImageURL,
            x: tpl.x,
            y: tpl.y,
            w: tpl.w,
            h: tpl.h,
            opacity: tpl.opacity,
            visible: tpl.visible,
            confirmed: tpl.confirmed,
            filterCI: tpl.filterCI,
            rawIndices: null
          }
        }));
      }
      
      showToast('Plantilla lista. Ajusta con los handles y confirma.','');
    };
    img.src=dataURL;
  };
  reader.readAsDataURL(file);
}

function syncTplInputs(tpl){
  const panel=$('tpl-panel');if(panel.classList.contains('collapsed'))return;
  const idx=templates.findIndex(t=>t===tpl);
  const items=panel.querySelectorAll('.tpl-item');
  const item=items[idx];if(!item)return;
  const xi=item.querySelector('.tpl-x-inp'),yi=item.querySelector('.tpl-y-inp');
  const wi=item.querySelector('.tpl-w-inp'),hi=item.querySelector('.tpl-h-inp');
  if(xi)xi.value=Math.round(tpl.x);if(yi)yi.value=Math.round(tpl.y);
  if(wi)wi.value=Math.round(tpl.w);if(hi)hi.value=Math.round(tpl.h);
}

function renderTemplateList(){
  const list=$('tpl-list');list.innerHTML='';
  if (!templates || templates.length === 0) {
    list.innerHTML = '<div class="tpl-empty-state"><svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg><p>No hay plantillas cargadas</p><span>Sube una imagen para usarla como guía de trazado en el lienzo</span></div>';
    return;
  }
  templates.forEach(tpl=>{
    const div=document.createElement('div');div.className='tpl-item'+(tpl.confirmed?' confirmed':' pending');
    const thumbImg=document.createElement('img');
    thumbImg.className='tpl-item-thumb';
    if (tpl.origImageURL) {
      thumbImg.src = tpl.origImageURL;
    } else if (tpl.origImage && tpl.origImage.src) {
      thumbImg.src = tpl.origImage.src;
    }
    const fc=tpl.filterCI>=0?paletteHex[tpl.filterCI]:'#888';
    if(!tpl.confirmed){
      div.innerHTML=
        '<div class="tpl-item-main">'+
          '<div class="tpl-item-thumb-slot"></div>'+
          '<div class="tpl-item-info">'+
            '<div class="tpl-item-name" title="'+escapeHtml(tpl.name)+'">'+escapeHtml(tpl.name)+'</div>'+
            '<div class="tpl-badge pending">📌 Ajuste de tamaño</div>'+
          '</div>'+
          '<div class="tpl-item-actions">'+
            '<button class="tpl-icon-btn '+(tpl.visible?'active':'')+'" data-act="vis" title="Mostrar/Ocultar">'+(tpl.visible?eyeOpen():eyeClosed())+'</button>'+
            '<button class="tpl-icon-btn danger" data-act="del" title="Eliminar"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
          '</div>'+
        '</div>'+
        '<div class="tpl-item-controls">'+
          '<div class="tpl-resize-hint">💡 Arrastra los círculos azules en el lienzo para ajustar o cambia valores:</div>'+
          '<div class="tpl-pos-grid">'+
            '<label><span class="lbl-tag">X</span><input type="number" class="tpl-x-inp" value="'+Math.round(tpl.x)+'" min="0" max="'+(CS-1)+'"></label>'+
            '<label><span class="lbl-tag">Y</span><input type="number" class="tpl-y-inp" value="'+Math.round(tpl.y)+'" min="0" max="'+(CS-1)+'"></label>'+
            '<label><span class="lbl-tag">Ancho</span><input type="number" class="tpl-w-inp" value="'+Math.round(tpl.w)+'" min="10" max="'+CS+'"></label>'+
            '<label><span class="lbl-tag">Alto</span><input type="number" class="tpl-h-inp" value="'+Math.round(tpl.h)+'" min="10" max="'+CS+'"></label>'+
          '</div>'+
          '<div class="tpl-opacity-row">'+
            '<span class="op-label">Opacidad</span>'+
            '<input type="range" class="tpl-opacity-inp" min="0.1" max="1" step="0.05" value="'+tpl.opacity+'">'+
            '<span class="tpl-opacity-val">'+Math.round(tpl.opacity*100)+'%</span>'+
          '</div>'+
          '<button class="btn-confirm-tpl" data-act="confirm">✓ Confirmar Tamaño</button>'+
        '</div>';
      div.querySelector('[data-act="confirm"]').addEventListener('click',()=>confirmTemplate(tpl));
      div.querySelector('.tpl-x-inp').addEventListener('change',e=>{tpl.x=clamp(parseInt(e.target.value)||0,0,CS-10);markDirty();sendTemplateUpdate(tpl);});
      div.querySelector('.tpl-y-inp').addEventListener('change',e=>{tpl.y=clamp(parseInt(e.target.value)||0,0,CS-10);markDirty();sendTemplateUpdate(tpl);});
      div.querySelector('.tpl-w-inp').addEventListener('change',e=>{tpl.w=Math.max(10,parseInt(e.target.value)||10);markDirty();sendTemplateUpdate(tpl);});
      div.querySelector('.tpl-h-inp').addEventListener('change',e=>{tpl.h=Math.max(10,parseInt(e.target.value)||10);markDirty();sendTemplateUpdate(tpl);});
    } else {
      div.innerHTML=
        '<div class="tpl-item-main">'+
          '<div class="tpl-item-thumb-slot"></div>'+
          '<div class="tpl-item-info">'+
            '<div class="tpl-item-name" title="'+escapeHtml(tpl.name)+'">'+escapeHtml(tpl.name)+'</div>'+
            '<div class="tpl-confirmed-info">'+Math.round(tpl.w)+'×'+Math.round(tpl.h)+' px • ('+Math.round(tpl.x)+', '+Math.round(tpl.y)+')</div>'+
          '</div>'+
          '<div class="tpl-item-actions">'+
            '<button class="tpl-icon-btn '+(tpl.visible?'active':'')+'" data-act="vis" title="Mostrar/Ocultar">'+(tpl.visible?eyeOpen():eyeClosed())+'</button>'+
            '<button class="tpl-icon-btn '+(tpl.filterActive?'active':'')+'" data-act="filter" title="Filtrar por color seleccionado" style="'+(tpl.filterActive?'border-color:'+fc+';box-shadow:0 0 0 2px '+fc+'44;':'')+'">'+
              '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>'+
            '</button>'+
            '<button class="tpl-icon-btn" data-act="stamp" title="Estampar plantilla en canvas">'+
              '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 8V3a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v5"/><path d="M3 21v-1h18v1"/><rect x="3" y="11" width="18" height="9" rx="2"/></svg>'+
            '</button>'+
            '<button class="tpl-icon-btn danger" data-act="del" title="Eliminar"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
          '</div>'+
        '</div>'+
        '<div class="tpl-item-controls">'+
          (tpl.filterActive?'<div class="tpl-filter-info">Filtro: <span class="filter-swatch-chip" style="background:'+fc+'"></span> '+fc.toUpperCase()+'</div>':'')+
          '<div class="tpl-opacity-row">'+
            '<span class="op-label">Opacidad</span>'+
            '<input type="range" class="tpl-opacity-inp" min="0.1" max="1" step="0.05" value="'+tpl.opacity+'">'+
            '<span class="tpl-opacity-val">'+Math.round(tpl.opacity*100)+'%</span>'+
          '</div>'+
        '</div>';
      div.querySelector('[data-act="filter"]').addEventListener('click',()=>{
        tpl.filterActive=!tpl.filterActive;
        if(tpl.filterActive){const ci=nearestPaletteIndex(currentColorHex);tpl.filterCI=ci;tpl.filterCanvas=makeFilterStitchCanvas(tpl.rawIndices,tpl.w,tpl.h,ci);showToast('Filtro: '+paletteHex[ci].toUpperCase(),'');}
        else showToast('Filtro desactivado','');
        renderTemplateList();markDirty();
        sendTemplateUpdate(tpl);
      });
      div.querySelector('[data-act="stamp"]').addEventListener('click',()=>{
        stampTemplate(tpl);
      });
    }
    div.querySelector('.tpl-item-thumb-slot').appendChild(thumbImg);
    div.querySelector('[data-act="vis"]').addEventListener('click',()=>{
      tpl.visible=!tpl.visible;
      renderTemplateList();markDirty();scheduleTemplateSave();
      sendTemplateUpdate(tpl);
    });
    div.querySelector('[data-act="del"]').addEventListener('click',()=>{
      templates=templates.filter(t=>t.id!==tpl.id);
      renderTemplateList();markDirty();saveTemplatesToIDB();
      if(wsReady) ws.send(JSON.stringify({type:'template_delete',id:tpl.id}));
    });
    const opIn=div.querySelector('.tpl-opacity-inp'),opVal=div.querySelector('.tpl-opacity-val');
    opIn.addEventListener('input',e=>{
      tpl.opacity=parseFloat(e.target.value);
      opVal.textContent=Math.round(tpl.opacity*100)+'%';
      markDirty();
    });
    opIn.addEventListener('change',()=>{
      scheduleTemplateSave();
      sendTemplateUpdate(tpl);
    });
    list.appendChild(div);
  });
}

/* === Export === */
function doExport(){if(!offscreen)return;const sc=exportScale,w=CS*sc,h=CS*sc;const exp=document.createElement('canvas');exp.width=w;exp.height=h;const ectx=exp.getContext('2d');ectx.imageSmoothingEnabled=false;ectx.drawImage(offscreen,0,0,w,h);const a=document.createElement('a');a.href=exp.toDataURL('image/png');a.download='bplace_'+sc+'x_'+Date.now()+'.png';a.click();showToast('Exportado '+w+'x'+h+' px','success');}

/* === Prefs === */
function savePrefs(){try{localStorage.setItem('bplace_prefs',JSON.stringify({recentColors,favColors,currentColorHex,bgColorHex}));}catch(e){}}
function loadPrefs(){try{const p=JSON.parse(localStorage.getItem('bplace_prefs')||'{}');recentColors=p.recentColors||[];favColors=p.favColors||[];currentColorHex=p.currentColorHex||'#000000';bgColorHex=p.bgColorHex||'#FFFFFF';}catch(e){}}

/* === SVG helpers === */
function eyeOpen(){return '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';}
function eyeClosed(){return '<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M1 1l22 22"/></svg>';}
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

/* =====================================================================
   INIT
   ===================================================================== */
window.addEventListener('DOMContentLoaded', async () => {
  resize();
  new ResizeObserver(()=>{resize();if(ghostCanvas.width!==mainCanvas.width){ghostCanvas.width=mainCanvas.width;ghostCanvas.height=mainCanvas.height;}}).observe(wrap);

  /* === Panel slide tab button (inject into #tpl-panel) === */
  const tplPanel = $('tpl-panel');
  const tabBtn   = document.createElement('button');
  tabBtn.id        = 'tpl-panel-tab';
  tabBtn.className = 'tpl-panel-tab';
  tabBtn.title     = 'Contraer plantillas';
  tabBtn.innerHTML = '<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>';
  tabBtn.addEventListener('click', toggleTplPanel);
  tplPanel.appendChild(tabBtn);

  /* X button: fully close panel */
  $('btn-tpl-x').addEventListener('click', () => {
    tplPanel.classList.add('hidden');
    tplPanel.classList.remove('collapsed');
    updatePanelTabIcon();
  });
  /* Toolbar open: toggle template panel */
  $('btn-tpl-open').addEventListener('click', () => {
    const isHidden = tplPanel.classList.contains('hidden');
    const isCollapsed = tplPanel.classList.contains('collapsed');
    
    if (isHidden || isCollapsed) {
      tplPanel.classList.remove('hidden');
      tplPanel.classList.remove('collapsed');
    } else {
      tplPanel.classList.add('hidden');
    }
    updatePanelTabIcon();
  });

  /* === Canvas mouse events (override with template handling) === */
  mainCanvas.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect=mainCanvas.getBoundingClientRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
    if(e.button===1||e.button===2){onMouseDown(e);return;}
    if(e.button===0){
      const hit=hitTestHandles(sx,sy);
      if(hit){resizeTpl=hit.tpl;resizeHandle=hit.handle;resizeStart={sx,sy,x:hit.tpl.x,y:hit.tpl.y,w:hit.tpl.w,h:hit.tpl.h};return;}
      for(let i=templates.length-1;i>=0;i--){const tpl=templates[i];if(tpl.confirmed||!tpl.visible)continue;if(x>=tpl.x&&x<tpl.x+tpl.w&&y>=tpl.y&&y<tpl.y+tpl.h){tplDragId=tpl.id;tplDragOX=x-tpl.x;tplDragOY=y-tpl.y;return;}}
    }
    onMouseDown(e);
  });

  mainCanvas.addEventListener('mousemove', e => {
    const rect=mainCanvas.getBoundingClientRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
    if(resizeTpl&&resizeHandle){
      mainCanvas.style.cursor=HANDLE_CURSORS[resizeHandle]||'default';
      const dcx=(sx-resizeStart.sx)/vz,dcy=(sy-resizeStart.sy)/vz;
      let nx=resizeStart.x,ny=resizeStart.y,nw=resizeStart.w,nh=resizeStart.h;
      const h=resizeHandle;
      if(h[0]==='t'){ny+=dcy;nh-=dcy;}if(h[0]==='b')nh+=dcy;
      if(h[h.length-1]==='l'){nx+=dcx;nw-=dcx;}if(h[h.length-1]==='r')nw+=dcx;
      resizeTpl.w=Math.max(10,Math.round(nw));resizeTpl.h=Math.max(10,Math.round(nh));
      resizeTpl.x=Math.round(clamp(nx,0,CS-resizeTpl.w));resizeTpl.y=Math.round(clamp(ny,0,CS-resizeTpl.h));
      syncTplInputs(resizeTpl);markDirty();return;
    }
    if(tplDragId){
      const tpl=templates.find(t=>t.id===tplDragId);
      if(tpl){tpl.x=clamp(x-tplDragOX,0,CS-tpl.w);tpl.y=clamp(y-tplDragOY,0,CS-tpl.h);syncTplInputs(tpl);markDirty();}
      return;
    }
    onMouseMove(e);
  });

  mainCanvas.addEventListener('mouseup', e => {
    if(resizeTpl){
      sendTemplateUpdate(resizeTpl);
      resizeTpl=null;resizeHandle=null;resizeStart=null;mainCanvas.style.cursor='';
      return;
    }
    if(tplDragId){
      const tpl=templates.find(t=>t.id===tplDragId);
      if(tpl) sendTemplateUpdate(tpl);
      tplDragId=null;
      return;
    }
    onMouseUp(e);
  });
  mainCanvas.addEventListener('mouseleave', e => {
    if(resizeTpl){
      sendTemplateUpdate(resizeTpl);
      resizeTpl=null;resizeHandle=null;resizeStart=null;
    }
    if(tplDragId){
      const tpl=templates.find(t=>t.id===tplDragId);
      if(tpl) sendTemplateUpdate(tpl);
      tplDragId=null;
    }
    mainCanvas.style.cursor='';onMouseLeave();
  });
  mainCanvas.addEventListener('wheel',onWheel,{passive:false});
  mainCanvas.addEventListener('contextmenu',e=>e.preventDefault());
  window.addEventListener('keydown',onKeyDown);
  window.addEventListener('keyup',onKeyUp);

  /* === Toolbar buttons === */
  /* Tool buttons in sidebar: clicking any tool activates paint mode */
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => btn.addEventListener('click', () => activatePaintMode(btn.dataset.tool)));

  /* Pintar FAB — opens palette and activates brush */
  const handlePintarBtn = (e) => {
    e.preventDefault();
    e.stopPropagation();
    activatePaintMode('brush');
  };
  const pintarFab = $('btn-pintar');
  if (pintarFab) {
    pintarFab.addEventListener('click', handlePintarBtn);
  }

  /* bb-close & dock-close-btn deactivate paint mode entirely */
  const handleClosePalette = (e) => {
    e.preventDefault();
    e.stopPropagation();
    deactivatePaintMode();
  };
  const closeBtn = $('bb-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', handleClosePalette);
  }
  const dockCloseBtn = $('dock-close-btn');
  if (dockCloseBtn) {
    dockCloseBtn.addEventListener('click', handleClosePalette);
  }

  /* Inside paint button triggers brush tool */
  const btnPintarAction = $('btn-pintar-action');
  if (btnPintarAction) {
    btnPintarAction.addEventListener('click', (e) => {
      e.preventDefault();
      setTool('brush');
      showToast('Pincel activo: Haz clic o arrastra para pintar', 'success');
    });
  }

  $('btn-fit').addEventListener('click',fitCanvas);
  $('btn-clear').addEventListener('click',()=>{if(!confirm('Limpiar todo el canvas?'))return;offCtx.fillStyle='#FFFFFF';offCtx.fillRect(0,0,CS,CS);if(canvasData)canvasData.fill(0);idbSave(canvasData);markDirty();showToast('Canvas limpiado','');
    // Send clear message to all connected clients
    if (wsReady) ws.send(JSON.stringify({ type: 'clear' }));
  });
  $('btn-export').addEventListener('click',()=>{$('export-info').textContent='Tamano: '+(CS*exportScale)+'x'+(CS*exportScale)+' px';$('export-dialog').classList.remove('hidden');});
  const bsIn = $('brush-size'); if (bsIn) bsIn.addEventListener('input', e => setBrushSize(parseInt(e.target.value)));
  $('opt-filled').addEventListener('click',()=>setShapeFilled(true));
  $('opt-hollow').addEventListener('click',()=>setShapeFilled(false));
  $('cur-fg-color').addEventListener('click',()=>$('custom-color').click());
  $('cur-bg-color').addEventListener('click',swapColors);
  $('btn-swap-colors').addEventListener('click',swapColors);
  $('custom-color').addEventListener('input',e=>setCurrentColor(e.target.value,false));
  $('custom-color').addEventListener('change',e=>setCurrentColor(e.target.value));
  $('btn-add-color').addEventListener('click',()=>addToFavColors($('custom-color').value));
  $('btn-tpl-upload').addEventListener('click',()=>$('tpl-file').click());
  $('tpl-file').addEventListener('change',e=>{Array.from(e.target.files).forEach(loadTemplateFile);e.target.value='';});
  document.querySelectorAll('.scale-btn').forEach(b=>{b.addEventListener('click',()=>{document.querySelectorAll('.scale-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');exportScale=parseInt(b.dataset.scale);$('export-info').textContent='Tamano: '+(CS*exportScale)+'x'+(CS*exportScale)+' px';});});
  $('btn-export-ok').addEventListener('click',()=>{$('export-dialog').classList.add('hidden');doExport();});
  $('btn-export-cancel').addEventListener('click',()=>$('export-dialog').classList.add('hidden'));
  $('btn-export-x').addEventListener('click',()=>$('export-dialog').classList.add('hidden'));
  $('export-dialog').addEventListener('click',e=>{if(e.target===$('export-dialog'))$('export-dialog').classList.add('hidden');});
  $('btn-goto-ok').addEventListener('click',()=>{const x=clamp(parseInt($('goto-x').value)||0,0,CS-1),y=clamp(parseInt($('goto-y').value)||0,0,CS-1);goTo(x,y);$('goto-dialog').classList.add('hidden');});
  $('btn-goto-cancel').addEventListener('click',()=>$('goto-dialog').classList.add('hidden'));
  $('btn-goto-x').addEventListener('click',()=>$('goto-dialog').classList.add('hidden'));
  $('goto-dialog').addEventListener('click',e=>{if(e.target===$('goto-dialog'))$('goto-dialog').classList.add('hidden');});

  /* === Load canvas data (Ultra-Fast Startup) === */
  try {
    setProgress(15); setLoadTxt('Iniciando lienzo...');
    initOffscreen();
    
    // Fast path: Fetch latest binary state from server directly
    setProgress(40); setLoadTxt('Descargando lienzo...');
    const loadedFromServer = await loadCanvasFromServer();
    
    if (loadedFromServer) {
      setProgress(90); setLoadTxt('¡Sincronizado!');
      // Cache in background to IDB without blocking main UI thread
      setTimeout(() => { openIDB().then(() => idbSave(canvasData)).catch(() => {}); }, 1200);
    } else {
      // Fallback path: Try offline local cache
      setProgress(60); setLoadTxt('Cargando respaldo local...');
      await openIDB().catch(() => null);
      const saved = await idbLoad().catch(() => null);
      if (saved && saved.length === CS * CS) {
        buildCanvasFromData(saved);
        setLoadTxt('¡Listo!');
      } else {
        canvasData = new Uint8Array(CS * CS);
        offCtx.fillStyle = '#FFFFFF';
        offCtx.fillRect(0, 0, CS, CS);
        setLoadTxt('Lienzo nuevo');
      }
    }
    setProgress(100);
  } catch (err) {
    console.error('Error durante la carga:', err);
  } finally {
    hideLoading();
  }
  setInterval(() => { if (canvasData) idbSave(canvasData); }, 60000);

  loadPrefs();buildPalette();renderRecentColors();renderFavColors();
  setCurrentColor(currentColorHex,false);setBgColor(bgColorHex);
  setTool('brush');setBrushSize(1);setShapeFilled(true);
  $('canvas-size-display').textContent=CS+' x '+CS;
  /* Start in navigation mode (paint mode OFF) */
  wrap.className = 'cursor-pan';

  fitCanvas();
  wsConnect();

  /* Theme */
  const savedTheme = localStorage.getItem('bplace_theme') || 'dark';
  applyTheme(savedTheme);
  
  const themeBtn = $('btn-theme');
  if (themeBtn) {
    themeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTheme();
    };
  }

  /* Mobile sidebar */
  const mobileBtn = $('btn-mobile-sidebar');
  const mobileOverlay = $('mobile-overlay');
  if (mobileBtn) mobileBtn.addEventListener('click', () => toggleMobileSidebar());
  if (mobileOverlay) mobileOverlay.addEventListener('click', () => toggleMobileSidebar(false));

  /* === Palette Navigation & Expand Drawer === */
  const palWrap = $('palette-scroll-wrap');
  const btnScrollLeft = $('pal-scroll-left');
  const btnScrollRight = $('pal-scroll-right');
  const btnExpandPal = $('btn-expand-palette');
  const dockCard = $('dock-card') || $('wplace-dock');

  if (btnScrollLeft && palWrap) {
    btnScrollLeft.addEventListener('click', () => {
      palWrap.scrollBy({ left: -160, behavior: 'smooth' });
    });
  }
  if (btnScrollRight && palWrap) {
    btnScrollRight.addEventListener('click', () => {
      palWrap.scrollBy({ left: 160, behavior: 'smooth' });
    });
  }
  if (btnExpandPal && dockCard) {
    btnExpandPal.addEventListener('click', () => {
      dockCard.classList.toggle('palette-expanded');
    });
  }
  if (palWrap) {
    // Mouse wheel horizontal scroll
    palWrap.addEventListener('wheel', (e) => {
      if (dockCard && dockCard.classList.contains('palette-expanded')) return;
      if (e.deltaY !== 0) {
        e.preventDefault();
        palWrap.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Drag-to-scroll
    let isMouseDown = false, startX, scrollLeftPos;
    palWrap.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      startX = e.pageX - palWrap.offsetLeft;
      scrollLeftPos = palWrap.scrollLeft;
    });
    palWrap.addEventListener('mouseleave', () => { isMouseDown = false; });
    palWrap.addEventListener('mouseup', () => { isMouseDown = false; });
    palWrap.addEventListener('mousemove', (e) => {
      if (!isMouseDown) return;
      e.preventDefault();
      const x = e.pageX - palWrap.offsetLeft;
      const walk = (x - startX) * 1.5;
      palWrap.scrollLeft = scrollLeftPos - walk;
    });
  }

  /* Lock movement button */
  const btnLock = $('btn-lock');
  if (btnLock) {
    btnLock.addEventListener('click', () => {
      canvasLocked = !canvasLocked;
      btnLock.classList.toggle('active', canvasLocked);
      const icon = $('lock-icon');
      if (canvasLocked) {
        icon.innerHTML = '<path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/>';
        showToast('Lienzo bloqueado: Desliza para pintar', 'success');
      } else {
        icon.innerHTML = '<path d="M7 11V7a5 5 0 0 1 9.9-1"/><rect x="3" y="11" width="18" height="11" rx="2"/>';
        showToast('Lienzo libre: Desliza para mover, toca para pintar', 'success');
      }
    });
  }

  /* === Touch events for canvas === */
  let touchState = null, lastPinchDist = 0;

  const handleTouchStart = (e) => {
    if (e.target.closest('#topbar') || e.target.closest('#wplace-dock') || e.target.closest('#btn-pintar') || e.target.closest('.floating-panel') || e.target.closest('.dialog-bg')) {
      return;
    }
    e.preventDefault();
    const rect = mainCanvas.getBoundingClientRect();
    cachedCanvasRect = rect;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      
      // Check template resize handles on mobile
      const hit = hitTestHandles(sx, sy);
      if (hit) {
        touchState = { 
          type: 'resize-tpl', 
          tpl: hit.tpl, 
          handle: hit.handle, 
          rect,
          start: { sx, sy, x: hit.tpl.x, y: hit.tpl.y, w: hit.tpl.w, h: hit.tpl.h } 
        };
        return;
      }
      
      // If NOT in paint mode, single touch always pans
      if (!paintModeActive) {
        touchState = { 
          type: 'pan-or-tap', 
          rect,
          startClientX: t.clientX, 
          startClientY: t.clientY, 
          lastClientX: t.clientX, 
          lastClientY: t.clientY, 
          hasMoved: true, // treat as pan, never tap-to-paint
          sx, sy 
        };
        return;
      }
      
      // Check template body drag on mobile
      for (let i = templates.length - 1; i >= 0; i--) {
        const tpl = templates[i];
        if (tpl.confirmed || !tpl.visible) continue;
        if (x >= tpl.x && x < tpl.x + tpl.w && y >= tpl.y && y < tpl.y + tpl.h) {
          touchState = {
            type: 'drag-tpl',
            tplId: tpl.id,
            rect,
            dragOX: x - tpl.x,
            dragOY: y - tpl.y
          };
          return;
        }
      }
      
      if (!canvasLocked) {
        // Free movement: drag to pan, tap to paint
        touchState = { 
          type: 'pan-or-tap', 
          rect,
          startClientX: t.clientX, 
          startClientY: t.clientY, 
          lastClientX: t.clientX, 
          lastClientY: t.clientY, 
          hasMoved: false, 
          sx, 
          sy 
        };
      } else {
        // Locked movement: normal draw logic
        if (tool === 'eye') {
          touchState = { type: 'eye', rect, sx, sy };
        } else if (tool === 'line' || tool === 'rect' || tool === 'circle') {
          touchState = { type: 'shape', rect, shapeStart: { x, y } };
        } else {
          touchState = { type: 'draw', rect, drawLX: x, drawLY: y };
          if (inCanvas(x, y)) {
            const ci = tool === 'erase' ? 0 : currentPaletteCI;
            paintBrush(x, y, ci); 
            markDirty(); 
            queueWSPixel(x, y, ci);
          }
        }
      }
    } else if (e.touches.length === 2) {
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      lastPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      touchState = { type: 'pinch', rect, lastMidX: midX, lastMidY: midY };
    }
  };

  const handleTouchMove = (e) => {
    if (!touchState) return;
    if (e.target.closest('#topbar') || e.target.closest('#wplace-dock') || e.target.closest('#btn-pintar') || e.target.closest('.floating-panel') || e.target.closest('.dialog-bg')) {
      return;
    }
    e.preventDefault();
    const rect = touchState.rect || cachedCanvasRect || mainCanvas.getBoundingClientRect();
    
    if (touchState.type === 'resize-tpl' && e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const dcx = (sx - touchState.start.sx) / vz;
      const dcy = (sy - touchState.start.sy) / vz;
      let nx = touchState.start.x, ny = touchState.start.y, nw = touchState.start.w, nh = touchState.start.h;
      const h = touchState.handle;
      if (h[0] === 't') { ny += dcy; nh -= dcy; }
      if (h[0] === 'b') nh += dcy;
      if (h[h.length - 1] === 'l') { nx += dcx; nw -= dcx; }
      if (h[h.length - 1] === 'r') nw += dcx;
      
      touchState.tpl.w = Math.max(10, Math.round(nw));
      touchState.tpl.h = Math.max(10, Math.round(nh));
      touchState.tpl.x = Math.round(clamp(nx, 0, CS - touchState.tpl.w));
      touchState.tpl.y = Math.round(clamp(ny, 0, CS - touchState.tpl.h));
      syncTplInputs(touchState.tpl);
      markDirty();
    } else if (touchState.type === 'drag-tpl' && e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      const tpl = templates.find(temp => temp.id === touchState.tplId);
      if (tpl) {
        tpl.x = clamp(x - touchState.dragOX, 0, CS - tpl.w);
        tpl.y = clamp(y - touchState.dragOY, 0, CS - tpl.h);
        syncTplInputs(tpl);
        markDirty();
      }
    } else if (touchState.type === 'pan-or-tap' && e.touches.length === 1) {
      const t = e.touches[0];
      const dist = Math.hypot(t.clientX - touchState.startClientX, t.clientY - touchState.startClientY);
      if (dist > 5) {
        touchState.hasMoved = true;
      }
      // Perform panning
      vx -= (t.clientX - touchState.lastClientX) / vz;
      vy -= (t.clientY - touchState.lastClientY) / vz;
      touchState.lastClientX = t.clientX;
      touchState.lastClientY = t.clientY;
      markDirty();
    } else if (touchState.type === 'draw' && e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      if (inCanvas(x, y)) {
        if (tool === 'brush') {
          if (x !== touchState.drawLX || y !== touchState.drawLY) paintLineMain(touchState.drawLX, touchState.drawLY, x, y);
        } else if (tool === 'erase') {
          const ci = 0;
          if (x !== touchState.drawLX || y !== touchState.drawLY) {
            bresenhamLine(touchState.drawLX, touchState.drawLY, x, y, (px, py) => {
              paintBrush(px, py, ci);
              queueWSPixel(px, py, ci);
            });
          }
          markDirty();
        }
        touchState.drawLX = x; touchState.drawLY = y;
      }
    } else if (touchState.type === 'shape' && e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      renderGhost(touchState.shapeStart.x, touchState.shapeStart.y, x, y);
    } else if (touchState.type === 'pinch' && e.touches.length === 2) {
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      /* Pan */
      vx -= (midX - touchState.lastMidX) / vz;
      vy -= (midY - touchState.lastMidY) / vz;
      /* Zoom */
      if (lastPinchDist > 0 && Math.abs(dist - lastPinchDist) > 1) {
        doZoom(dist / lastPinchDist, midX - rect.left, midY - rect.top);
        lastPinchDist = dist;
      }
      touchState.lastMidX = midX;
      touchState.lastMidY = midY;
      markDirty();
    }
  };

  const handleTouchEnd = (e) => {
    if (!touchState) return;
    const rect = mainCanvas.getBoundingClientRect();
    
    if (touchState.type === 'resize-tpl' || touchState.type === 'drag-tpl') {
      const activeTpl = touchState.tpl || templates.find(t => t.id === touchState.tplId);
      if (activeTpl) sendTemplateUpdate(activeTpl);
      touchState = null;
      return;
    }
    
    if (touchState.type === 'pan-or-tap') {
      if (!touchState.hasMoved && paintModeActive) {
        // Tap: paint or sample color if paint mode is ACTIVE
        const {x, y} = s2c(touchState.sx, touchState.sy);
        if (inCanvas(x, y)) {
          if (tool === 'brush') {
            paintBrush(x, y, currentPaletteCI);
            markDirty();
            queueWSPixel(x, y, currentPaletteCI);
          } else if (tool === 'erase') {
            paintBrush(x, y, 0);
            markDirty();
            queueWSPixel(x, y, 0);
          } else if (tool === 'eye') {
            const hex = sampleScreenAt(touchState.sx, touchState.sy);
            if (hex) { setCurrentColor(hex); showToast('Color: ' + hex.toUpperCase(), 'success'); }
            setTool('brush');
          } else if (tool === 'fill') {
            floodFill(x, y, currentColorHex);
          }
        }
      }
      scheduleIDBSave();
      flushWSPixels();
      touchState = null;
    } else if (touchState.type === 'draw') {
      scheduleIDBSave();
      flushWSPixels();
      touchState = null;
    } else if (touchState.type === 'eye' && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      const hex = sampleScreenAt(t.clientX - rect.left, t.clientY - rect.top);
      if (hex) { setCurrentColor(hex); showToast('Color: ' + hex.toUpperCase(), 'success'); }
      setTool('brush');
      touchState = null;
    } else if (touchState.type === 'shape' && e.changedTouches.length > 0) {
      const t = e.changedTouches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      clearGhost();
      commitShape(touchState.shapeStart.x, touchState.shapeStart.y, x, y);
      touchState = null;
    } else if (touchState.type === 'pinch') {
      if (e.touches.length === 0) touchState = null;
    }
  };

  const handleTouchCancel = () => {
    touchState = null;
    lastPinchDist = 0;
  };

  // Register touch handlers ONLY on wrap container (prevents duplicate bubbling events)
  wrap.addEventListener('touchstart', handleTouchStart, { passive: false });
  wrap.addEventListener('touchmove', handleTouchMove, { passive: false });
  wrap.addEventListener('touchend', handleTouchEnd, { passive: false });
  wrap.addEventListener('touchcancel', handleTouchCancel, { passive: false });
});
