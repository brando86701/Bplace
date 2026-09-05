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
const IS_COARSE_POINTER = window.matchMedia('(pointer: coarse)').matches;

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
const pendingBroadcasts = [];
function sendRealtime(message) {
  if (message.event === 'broadcast' && (!wsReady || !ws || ws.readyState !== WebSocket.OPEN)) {
    pendingBroadcasts.push(message);
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(message));
    } catch (e) {
      console.warn('[Realtime] Error enviando mensaje:', e);
    }
  }
}

let sbHeartbeatInterval = null;
let sbMsgRef = 1;
let wsBatch = [];
let wsFlushTimer = null;
let presenceUsers = new Set();
const pendingTemplateLoads = new Set();
const remoteStampOps = new Map();
let stampSyncInFlight = false;

function announceTemplateRefresh(tpl) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = typeof tpl === 'object' ? {
    id: tpl.id, name: tpl.name, x: tpl.x, y: tpl.y, w: tpl.w, h: tpl.h,
    opacity: tpl.opacity, visible: tpl.visible, confirmed: true
  } : { id: tpl };
  sendRealtime({
    topic: 'realtime:bplace',
    event: 'broadcast',
    payload: { type: 'broadcast', event: 'template_refresh', payload },
    ref: String(sbMsgRef++)
  });
}

function ensureRemoteTemplatePlaceholder(data) {
  if (!data || data.id === undefined || templates.some(t => String(t.id) === String(data.id))) return;
  templates.push({
    id: Number(data.id), name: data.name || 'Cargando plantilla…',
    x: data.x || 0, y: data.y || 0, w: data.w || 10, h: data.h || 10,
    opacity: data.opacity ?? 0.85, visible: data.visible !== false,
    confirmed: true, remoteLoading: true,
    origImage: null, origImageURL: '', canvas: null, rawIndices: null, stitchCanvas: null,
    filterActive: false, filterCI: -1, filterCanvas: null
  });
  renderTemplateList();
}

async function fetchAndAddCloudTemplate(templateId) {
  const key = String(templateId);
  const current = templates.find(t => String(t.id) === key);
  if (!key || (current && !current.remoteLoading) || pendingTemplateLoads.has(key)) return;
  pendingTemplateLoads.add(key);
  try {
    for (let attempt = 0; attempt < 14; attempt++) {
      try {
        const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/templates?id=eq.${encodeURIComponent(key)}&select=*`, {
          headers: {
            'apikey': SUPABASE_CONFIG.anonKey,
            'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
          },
          cache: 'no-store'
        });
        if (res.ok) {
          const rows = await res.json();
          const t = Array.isArray(rows) ? rows[0] : null;
          if (t) {
            const loaded = [];
            await addTemplateFromData({
              id: Number(t.id), name: t.name, origImageURL: t.orig_image_url,
              x: t.x, y: t.y, w: t.w, h: t.h,
              opacity: t.opacity, visible: t.visible, confirmed: t.confirmed
            }, loaded);
            const fresh = loaded[0];
            if (!fresh) throw new Error('Plantilla inválida');
            const existingIndex = templates.findIndex(existing => String(existing.id) === key);
            if (existingIndex >= 0) templates[existingIndex] = fresh;
            else templates.push(fresh);
            renderTemplateList();
            markDirty();
            saveTemplatesToIDB();
            showToast('Nueva plantilla sincronizada', 'success');
            return;
          }
        }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 250 + attempt * 75));
    }
    console.warn('[Templates] No se pudo obtener a tiempo la plantilla', key);
  } finally {
    pendingTemplateLoads.delete(key);
  }
}

function connectSupabaseRealtime() {
  if (sbHeartbeatInterval) { clearInterval(sbHeartbeatInterval); sbHeartbeatInterval = null; }
  const url = `wss://jtwbuempcdjrbqfgvaar.supabase.co/realtime/v1/websocket?apikey=${SUPABASE_CONFIG.anonKey}&vsn=1.0.0`;
  
  try {
    ws = new WebSocket(url);

    ws.addEventListener('open', () => {
      console.log('[Supabase Realtime] Conectado a la red Edge global');
      wsReady = false;
      updateOnlineChip(1);

      const userId = 'usr_' + Math.random().toString(36).substring(2, 9);
      // Join realtime channel with broadcast & presence
      sendRealtime({
        topic: 'realtime:bplace',
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, presence: { key: userId } } },
        ref: String(sbMsgRef++)
      });

      // Start 25s heartbeat ping to keep connection alive
      sbHeartbeatInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendRealtime({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(sbMsgRef++) });
        }
      }, 25000);
    });

    ws.addEventListener('message', async e => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      
      if (msg.event === 'phx_reply' && msg.payload?.status === 'ok' && msg.topic === 'realtime:bplace' && !wsReady) {
        wsReady = true;
        while (pendingBroadcasts.length) sendRealtime(pendingBroadcasts.shift());
        flushWSPixels();
        flushWSLines();
        sendRealtime({ topic: 'realtime:bplace', event: 'presence', payload: { type: 'presence', event: 'track', payload: {} }, ref: String(sbMsgRef++) });
      }
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
        canvasEditRevision++;
        const payloadData = msg.payload;
        const ev = payloadData.event;
        const p = payloadData.payload;
        if (!p && ev !== 'clear') return;
        
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
          const colorBuckets = {};
          for (let i = 0; i < len; i += 3) {
            const x = p[i], y = p[i + 1], ci = p[i + 2];
            if (x >= 0 && x < CS && y >= 0 && y < CS && ci >= 0 && ci < palRGB.length) {
              if (canvasData) canvasData[y * CS + x] = ci;
              if (!colorBuckets[ci]) colorBuckets[ci] = [];
              colorBuckets[ci].push(x, y);
            }
          }
          for (const ci in colorBuckets) {
            const coords = colorBuckets[ci];
            setOffscreenPaletteColor(Number(ci));
            for (let k = 0; k < coords.length; k += 2) {
              offCtx.fillRect(coords[k], coords[k + 1], 1, 1);
            }
          }
          markDirty();
          scheduleIDBSave();
        } else if (ev === 'lines_batch' && Array.isArray(p)) {
          const prev = brushSize;
          const len = p.length;
          for (let i = 0; i < len; i += 6) {
            brushSize = p[i + 5] || 1;
            bresenhamLine(p[i], p[i + 1], p[i + 2], p[i + 3], (x, y) => paintBrush(x, y, p[i + 4]));
          }
          brushSize = prev;
          markDirty();
          scheduleIDBSave();
        } else if (ev === 'fill' && p) {
          executeFloodFill(p.x, p.y, p.c);
        } else if (ev === 'stamp_chunk' && p) {
          applyRemoteStampChunk(p);
        } else if (ev === 'stamp_checkpoint' && p) {
          const received = remoteStampOps.get(p.opId)?.size || 0;
          remoteStampOps.delete(p.opId);
          if (p.uploaded && received < p.totalChunks) {
            refreshCanvasFromCloudStorage().then(ok => {
              if (ok) showToast('Lienzo resincronizado', 'success');
            });
          }
        } else if (ev === 'stamp_template' && p) {
          const tpl = templates.find(t => String(t.id) === String(p.id));
          if (tpl) {
            if (!tpl.rawIndices && tpl.origImage) {
              const { canvas, rawIndices } = buildPaletteCanvas(tpl.origImage, Math.max(10, Math.round(tpl.w)), Math.max(10, Math.round(tpl.h)));
              tpl.canvas = canvas; tpl.rawIndices = rawIndices;
              tpl.stitchCanvas = makeStitchCanvas(rawIndices, tpl.w, tpl.h);
            }
            if (tpl.rawIndices) {
              applyStampTemplate(tpl, p.x, p.y, p.filterCI);
            }
          }
        } else if (ev === 'batch') {
          (p.pixels || []).forEach(px => applyRemotePixel(px.x, px.y, px.c));
        } else if (ev === 'clear') {
          if (canvasData) canvasData.fill(0);
          setOffscreenPaletteColor(0);
          offCtx.fillRect(0, 0, CS, CS);
          markDirty();
          scheduleIDBSave();
        } else if (ev === 'template_add') {
          if (p.template && !templates.some(t => String(t.id) === String(p.template.id))) {
            await addTemplateFromData(p.template);
            renderTemplateList();
            markDirty();
            saveTemplatesToIDB();
          }
        } else if (ev === 'template_refresh' && p.id !== undefined) {
          ensureRemoteTemplatePlaceholder(p);
          fetchAndAddCloudTemplate(p.id);
        } else if (ev === 'template_update') {
          const tpl = templates.find(t => String(t.id) === String(p.id));
          if (tpl && p.updates) {
            const needIndices = (p.updates.confirmed && !tpl.confirmed) || (!tpl.rawIndices && (tpl.confirmed || p.updates.confirmed));
            const sharedUpdates = { ...p.updates };
            // Visibility and color filters are strictly independent per user
            delete sharedUpdates.filterCI;
            delete sharedUpdates.filterActive;
            delete sharedUpdates.visible;
            Object.assign(tpl, sharedUpdates);
            if (needIndices) {
              tpl.confirmed = true;
              const setupCanvas = (img) => {
                const W = Math.max(10, Math.round(tpl.w)), H = Math.max(10, Math.round(tpl.h));
                const { canvas, rawIndices } = buildPaletteCanvas(img, W, H);
                tpl.canvas = canvas; tpl.rawIndices = rawIndices;
                tpl.stitchCanvas = makeStitchCanvas(rawIndices, tpl.w, tpl.h);
                tpl.filterCanvasCache = null;
                applyLocalTemplateFilter(tpl);
                markDirty();
              };
              if (tpl.origImage && (tpl.origImage.complete || tpl.origImage.naturalWidth)) {
                setupCanvas(tpl.origImage);
              } else if (tpl.origImageURL) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => { tpl.origImage = img; setupCanvas(img); };
                img.src = tpl.origImageURL;
              }
            }
            syncTplInputs(tpl);
            renderTemplateList();
            markDirty();
            saveTemplatesToIDB();
          } else if (!tpl && p.id !== undefined) {
            ensureRemoteTemplatePlaceholder({ id: p.id, ...(p.updates || {}) });
            fetchAndAddCloudTemplate(p.id);
          }
        } else if (ev === 'template_delete') {
          if (String(activePaintingTemplateId) === String(p.id)) exitTemplatePainting(false);
          removeLocalTemplateFilter(p.id);
          templates = templates.filter(t => String(t.id) !== String(p.id));
          renderTemplateList();
          markDirty();
          saveTemplatesToIDB();
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
  scheduleCloudCanvasSave();
  sendRealtime({
    topic: 'realtime:bplace',
    event: 'broadcast',
    payload: { type: 'broadcast', event: 'shape', payload: shapeData },
    ref: String(sbMsgRef++)
  });
}

let wsLineBatch = [];
let wsLineTimer = null;

function queueWSLine(x0, y0, x1, y1, ci, size) {
  scheduleCloudCanvasSave();
  wsLineBatch.push(x0, y0, x1, y1, ci, size);
  if (!wsLineTimer) {
    wsLineTimer = setTimeout(flushWSLines, 16);
  }
}

function flushWSLines() {
  wsLineTimer = null;
  if (!wsLineBatch.length) return;
  try {
    if (wsLineBatch.length === 6) {
      sendRealtime({
        topic: 'realtime:bplace',
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'shape',
          payload: { type: 'line', x0: wsLineBatch[0], y0: wsLineBatch[1], x1: wsLineBatch[2], y1: wsLineBatch[3], c: wsLineBatch[4], size: wsLineBatch[5] }
        },
        ref: String(sbMsgRef++)
      });
    } else {
      sendRealtime({
        topic: 'realtime:bplace',
        event: 'broadcast',
        payload: { type: 'broadcast', event: 'lines_batch', payload: wsLineBatch },
        ref: String(sbMsgRef++)
      });
    }
  } catch (e) {}
  wsLineBatch = [];
}

function queueWSPixel(x, y, ci) {
  scheduleCloudCanvasSave();
  // Flat numeric batches avoid allocating one object for every painted pixel.
  wsBatch.push(x, y, ci);
  if (!wsFlushTimer) {
    wsFlushTimer = setTimeout(flushWSPixels, 20);
  }
}

function flushWSPixels() {
  wsFlushTimer = null;
  if (!wsBatch.length) return;
  {
    try {
      if (wsBatch.length === 3) {
        sendRealtime({
          topic: 'realtime:bplace',
          event: 'broadcast',
          payload: { type: 'broadcast', event: 'pixel', payload: { x: wsBatch[0], y: wsBatch[1], c: wsBatch[2] } },
          ref: String(sbMsgRef++)
        });
      } else {
        for (let i = 0; i < wsBatch.length; i += 6000) {
          const chunk = wsBatch.slice(i, i + 6000);
          sendRealtime({
            topic: 'realtime:bplace',
            event: 'broadcast',
            payload: { type: 'broadcast', event: 'flat_batch', payload: chunk },
            ref: String(sbMsgRef++)
          });
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
      filterActive: false,
      filterCI: -1,
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
      applyLocalTemplateFilter(tpl);
    }
    list.push(tpl);
  } catch (e) {
    console.warn('Could not load remote template', saved.name, e);
  }
}

async function uploadTemplateImageToStorage(tpl) {
  if (!tpl) return '';
  if (tpl.origImageURL && tpl.origImageURL.startsWith('http') && tpl.origImageURL.includes('/storage/v1/object/public/bplace/')) {
    return tpl.origImageURL;
  }
  try {
    const img = tpl.origImage || await loadImg(tpl.origImageURL);
    const canvas = document.createElement('canvas');
    let nw = img.naturalWidth || img.width || 400;
    let nh = img.naturalHeight || img.height || 400;
    const maxDim = 1200;
    if (nw > maxDim || nh > maxDim) {
      if (nw >= nh) { nh = Math.round(nh * (maxDim / nw)); nw = maxDim; }
      else { nw = Math.round(nw * (maxDim / nh)); nh = maxDim; }
    }
    canvas.width = Math.max(10, nw);
    canvas.height = Math.max(10, nh);
    const cctx = canvas.getContext('2d');
    cctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('Blob creation failed');
    
    const res = await fetch(`${SUPABASE_CONFIG.url}/storage/v1/object/bplace/templates/tpl_${tpl.id}.png`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
        'Content-Type': 'image/png',
        'x-upsert': 'true'
      },
      body: blob
    });
    if (res.ok) {
      const cdnUrl = `${SUPABASE_CONFIG.url}/storage/v1/object/public/bplace/templates/tpl_${tpl.id}.png?t=${Date.now()}`;
      return cdnUrl;
    }
  } catch (err) {
    console.warn('[Storage] Error subiendo imagen de plantilla:', err);
  }
  return tpl.origImageURL;
}

function sendTemplateUpdate(tpl) {
  if (!tpl || tpl.draft) return;
  const updates = {
    x: tpl.x,
    y: tpl.y,
    w: tpl.w,
    h: tpl.h,
    opacity: tpl.opacity,
    confirmed: tpl.confirmed
  };

  // 1. Broadcast to all clients over Supabase Realtime
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendRealtime({
      topic: 'realtime:bplace',
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: 'template_update',
        payload: { id: tpl.id, updates }
      },
      ref: String(sbMsgRef++)
    });
  }

  // 2. Debounce persist to Supabase PostgreSQL table
  debounceTemplateRestUpdate(tpl);
}

let tplRestDebounceTimer = null;
function debounceTemplateRestUpdate(tpl) {
  if (tplRestDebounceTimer) clearTimeout(tplRestDebounceTimer);
  tplRestDebounceTimer = setTimeout(() => {
    fetch(`${SUPABASE_CONFIG.url}/rest/v1/templates?id=eq.${tpl.id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        x: tpl.x,
        y: tpl.y,
        w: tpl.w,
        h: tpl.h,
        opacity: tpl.opacity,
        confirmed: tpl.confirmed
      })
    }).catch(() => {});
  }, 400);
}

function deleteTemplate(tplId) {
  if (activeAdjustingTpl && activeAdjustingTpl.id === tplId) {
    closeTemplateAdjustment();
  }
  const templateToDelete = templates.find(t => t.id === tplId);
  const wasDraft = !!(templateToDelete && templateToDelete.draft);
  if (activePaintingTemplateId === tplId) exitTemplatePainting(false);
  removeLocalTemplateFilter(tplId);
  templates = templates.filter(t => t.id !== tplId);
  renderTemplateList();
  markDirty();
  saveTemplatesToIDB();

  // A draft only exists on this device until the user confirms it.
  if (wasDraft) return;

  // 1. Broadcast to all clients over Supabase Realtime
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendRealtime({
      topic: 'realtime:bplace',
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: 'template_delete',
        payload: { id: tplId }
      },
      ref: String(sbMsgRef++)
    });
  }

  // 2. Delete from Supabase PostgreSQL table
  fetch(`${SUPABASE_CONFIG.url}/rest/v1/templates?id=eq.${tplId}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).catch(() => {});

  // 3. Delete from Supabase Storage CDN
  fetch(`${SUPABASE_CONFIG.url}/storage/v1/object/bplace/templates/tpl_${tplId}.png`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_CONFIG.anonKey,
      'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
    }
  }).catch(() => {});
}

async function loadTemplatesFromCloud() {
  try {
    const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/templates?select=*`, {
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey
      }
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        if (data.length === 0) {
          templates = [];
          renderTemplateList();
          markDirty();
          saveTemplatesToIDB();
          return true;
        }
        const loadedList = [];
        for (let i = 0; i < data.length; i++) {
          const t = data[i];
          const existing = templates.find(e => String(e.id) === String(t.id));
          const localVis = existing ? (existing.visible !== false) : true;
          await new Promise(r => setTimeout(r, 0));
          await addTemplateFromData({
            id: Number(t.id),
            name: t.name,
            origImageURL: t.orig_image_url,
            x: t.x,
            y: t.y,
            w: t.w,
            h: t.h,
            opacity: t.opacity,
            visible: localVis,
            confirmed: t.confirmed
          }, loadedList);
        }
        templates = loadedList;
        renderTemplateList();
        markDirty();
        saveTemplatesToIDB();
        return true;
      }
    }
  } catch (e) {
    console.warn('[Cloud] No se pudieron cargar plantillas de Supabase:', e);
  }
  return false;
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

async function downloadCanvasSnapshot(url) {
  const controller = new AbortController();
  let timer;
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), 15000);
  };
  armTimeout();
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('Canvas HTTP ' + res.status);
    const data = new Uint8Array(CS * CS);
    const reader = res.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > data.length) {
        await reader.cancel();
        throw new Error('Invalid canvas size');
      }
      data.set(value, received);
      received += value.length;
      armTimeout();
      const percent = Math.round(received / data.length * 100);
      setProgress(15 + percent * 0.75);
      setLoadTxt('Descargando lienzo… ' + percent + '%');
    }
    if (received !== data.length) throw new Error('Incomplete canvas');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

let canvasEditRevision = 0;
let snapshotRefresh = null;
function loadCanvasFromServer() {
  if (!snapshotRefresh) {
    snapshotRefresh = fetchCanvasSnapshot().finally(() => { snapshotRefresh = null; });
  }
  return snapshotRefresh;
}
async function fetchCanvasSnapshot() {
  const baseline = canvasData ? canvasData.slice() : null;
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const candidateUrls = isLocal
    ? ['/api/canvas/compact', `${SUPABASE_CONFIG.cdnCanvas}?t=${Date.now()}`, '/api/canvas']
    : [`${SUPABASE_CONFIG.cdnCanvas}?t=${Date.now()}`];

  for (const url of candidateUrls) {
    try {
      const data = await downloadCanvasSnapshot(url);
      // Preserve edits received or painted while the snapshot was in transit.
      if (baseline && canvasData) {
        for (let i = 0; i < data.length; i++) {
          if (canvasData[i] !== baseline[i]) data[i] = canvasData[i];
        }
      }
      buildCanvasFromData(data);
      idbSave(data);
      markDirty();
      return true;
    } catch (error) {
      console.warn('[Canvas] Download failed; trying fallback', error);
    }
  }
  return false;
}

async function persistCanvasSnapshot() {
  if (snapshotRefresh && !await snapshotRefresh) return false;
  if (!canvasData) return false;
  try {
    const blob = new Blob([canvasData], { type: 'application/octet-stream' });
    const res = await fetch(`${SUPABASE_CONFIG.url}/storage/v1/object/bplace/canvas.bin`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_CONFIG.anonKey,
        Authorization: 'Bearer ' + SUPABASE_CONFIG.anonKey,
        'Content-Type': 'application/octet-stream',
        'x-upsert': 'true'
      },
      body: blob,
      signal: AbortSignal.timeout(45000)
    });
    if (res.ok) {
      console.log('[Supabase Storage] ✅ Lienzo guardado y sincronizado en la nube');
      if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        fetch('/api/canvas', { method: 'POST', body: blob }).catch(() => {});
      }
      return true;
    } else {
      console.warn('[Supabase Storage] Error al subir lienzo a la nube:', res.status);
      return false;
    }
  } catch (e) {
    console.warn('[Supabase Storage] Error de red al subir lienzo:', e);
    return false;
  }
}

const canvasAutosave = createCanvasAutosave({
  upload: persistCanvasSnapshot,
  onStatus(status) {
    let chip = document.getElementById('canvas-save-status');
    if (!chip) {
      chip = document.createElement('span');
      chip.id = 'canvas-save-status';
      chip.className = 'chip';
      chip.setAttribute('role', 'status');
      document.querySelector('.tb-info-chips')?.appendChild(chip);
    }
    chip.textContent = { pending: 'Cambios pendientes', saving: 'Guardando…', saved: 'Guardado', error: 'Sin guardar · reintentando…' }[status];
    chip.style.color = status === 'error' ? 'var(--danger)' : '';
  }
});

function scheduleCloudCanvasSave() {
  canvasEditRevision++;
  scheduleIDBSave();
  canvasAutosave.mark();
}

async function uploadCanvasToCloudStorage() {
  scheduleCloudCanvasSave();
  while (canvasAutosave.pending()) {
    if (!await canvasAutosave.flush()) return false;
  }
  return true;
}

window.addEventListener('online', () => canvasAutosave.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && canvasAutosave.pending()) {
    idbSave(canvasData);
    canvasAutosave.flush();
  }
});
window.addEventListener('pagehide', () => {
  if (!canvasAutosave.pending()) return;
  idbSave(canvasData);
  canvasAutosave.flush();
});

async function refreshCanvasFromCloudStorage() {
  if (canvasAutosave.pending()) return false;
  return loadCanvasFromServer();
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
let offscreenFillCI = -1;

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
let activePaintingTemplateId = null;
let localTemplateFilters = (() => {
  try { return JSON.parse(localStorage.getItem('bplace_template_filters') || '{}'); }
  catch (_) { return {}; }
})();
let exportScale = 1;
let idbSaveTmr  = null;
let idb         = null;
let dirty = false, rafId = null;
let tplSaveTmr  = null;
let paintModeActive = false; // When false, canvas is navigation-only (no drawing)
let canvasPersistenceDirty = false;
const MAX_DETAILED_TEMPLATE_CELLS = IS_COARSE_POINTER ? 45000 : 120000;

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

function getCanvasRect(refresh = false) {
  if (refresh || !cachedCanvasRect) cachedCanvasRect = mainCanvas.getBoundingClientRect();
  return cachedCanvasRect;
}

/* === Pixel Sound SFX (Max 5/sec) === */
let audioCtx = null;
let pixelAudioBuffer = null;
let lastPixelSoundTime = 0;
const PIXEL_SOUND_INTERVAL = 200; // Max 5 times per second (1000ms / 5 = 200ms)

const audioPool = [
  new Audio('pixel.mp3'),
  new Audio('pixel.mp3'),
  new Audio('pixel.mp3'),
  new Audio('pixel.mp3'),
  new Audio('pixel.mp3')
];
let audioPoolIdx = 0;

/* === Selection Sound SFX (Max 4/sec) === */
let selectAudioBuffer = null;
let lastSelectSoundTime = -10000;
let isStartupComplete = false;
const SELECT_SOUND_INTERVAL = 250; // Max 4 times per second (1000ms / 4 = 250ms)

const selectAudioPool = [
  new Audio('select.mp3'),
  new Audio('select.mp3'),
  new Audio('select.mp3')
];
let selectAudioPoolIdx = 0;

/* === Close / 'X' Sound SFX === */
let closeAudioBuffer = null;
let lastCloseSoundTime = -10000;
const CLOSE_SOUND_INTERVAL = 150;

const closeAudioPool = [
  new Audio('close.mp3'),
  new Audio('close.mp3'),
  new Audio('close.mp3')
];
let closeAudioPoolIdx = 0;

function initAudioEngine() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass && !audioCtx) {
      audioCtx = new AudioContextClass();
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    if (audioCtx) {
      if (!pixelAudioBuffer) {
        fetch('pixel.mp3')
          .then(res => res.arrayBuffer())
          .then(buf => audioCtx.decodeAudioData(buf))
          .then(decoded => { pixelAudioBuffer = decoded; })
          .catch(() => {});
      }
      if (!selectAudioBuffer) {
        fetch('select.mp3')
          .then(res => res.arrayBuffer())
          .then(buf => audioCtx.decodeAudioData(buf))
          .then(decoded => { selectAudioBuffer = decoded; })
          .catch(() => {});
      }
      if (!closeAudioBuffer) {
        fetch('close.mp3')
          .then(res => res.arrayBuffer())
          .then(buf => audioCtx.decodeAudioData(buf))
          .then(decoded => { closeAudioBuffer = decoded; })
          .catch(() => {});
      }
    }
  } catch (e) {}
}

function playPixelSound() {
  const now = performance.now();
  if (now - lastPixelSoundTime < PIXEL_SOUND_INTERVAL) return;
  lastPixelSoundTime = now;

  try {
    if (!audioCtx) initAudioEngine();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (audioCtx && pixelAudioBuffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = pixelAudioBuffer;
      source.connect(audioCtx.destination);
      source.start(0);
      return;
    }

    const a = audioPool[audioPoolIdx];
    audioPoolIdx = (audioPoolIdx + 1) % audioPool.length;
    if (a) {
      a.currentTime = 0;
      a.play().catch(() => {});
    }
  } catch (e) {}
}

function playSelectSound() {
  if (!isStartupComplete) return;
  const now = performance.now();
  if (now - lastSelectSoundTime < SELECT_SOUND_INTERVAL) return;
  lastSelectSoundTime = now;

  try {
    if (!audioCtx) initAudioEngine();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (audioCtx && selectAudioBuffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = selectAudioBuffer;
      source.connect(audioCtx.destination);
      source.start(0);
      return;
    }

    const a = selectAudioPool[selectAudioPoolIdx];
    selectAudioPoolIdx = (selectAudioPoolIdx + 1) % selectAudioPool.length;
    if (a) {
      a.currentTime = 0;
      a.play().catch(() => {});
    }
  } catch (e) {}
}

function playCloseSound() {
  if (!isStartupComplete) return;
  const now = performance.now();
  if (now - lastCloseSoundTime < CLOSE_SOUND_INTERVAL) return;
  lastCloseSoundTime = now;

  try {
    if (!audioCtx) initAudioEngine();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    if (audioCtx && closeAudioBuffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = closeAudioBuffer;
      source.connect(audioCtx.destination);
      source.start(0);
      return;
    }

    const a = closeAudioPool[closeAudioPoolIdx];
    closeAudioPoolIdx = (closeAudioPoolIdx + 1) % closeAudioPool.length;
    if (a) {
      a.currentTime = 0;
      a.play().catch(() => {});
    }
  } catch (e) {}
}

['pointerdown', 'touchstart', 'keydown'].forEach(evt => {
  window.addEventListener(evt, () => initAudioEngine(), { once: true, passive: true });
});

// Global listener: play close sound for X buttons, select sound for other clickable controls
document.addEventListener('click', e => {
  const target = e.target;
  if (!target) return;

  const closeBtn = target.closest('.dock-close-x, #dock-close-btn, #bb-close, .fp-close, #btn-tpl-x, .dialog-x, #btn-export-x, #btn-goto-x, [data-act="close"]');
  if (closeBtn) {
    playCloseSound();
    return;
  }

  const clickable = target.closest('button, .tool-btn, .swatch, .scale-btn, .opt-btn, .tpl-icon-btn, .color-swatch, .fab, input[type="color"], [data-tool], [data-act]');
  if (clickable) {
    playSelectSound();
  }
}, true);

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
    req.onblocked = () => rej(new Error('IndexedDB blocked'));
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
  canvasPersistenceDirty = true;
  if (idbSaveTmr) return;
  idbSaveTmr = setTimeout(() => {
    idbSaveTmr = null;
    if (canvasData && canvasPersistenceDirty) {
      canvasPersistenceDirty = false;
      idbSave(canvasData);
    }
  }, 2500);
}

/* === Template Persistence === */
function saveLocalTemplateFilter(tpl) {
  if (!tpl) return;
  if (tpl.filterActive && tpl.filterCI >= 0) localTemplateFilters[String(tpl.id)] = tpl.filterCI;
  else delete localTemplateFilters[String(tpl.id)];
  try { localStorage.setItem('bplace_template_filters', JSON.stringify(localTemplateFilters)); } catch (_) {}
}

function removeLocalTemplateFilter(tplId) {
  delete localTemplateFilters[String(tplId)];
  try { localStorage.setItem('bplace_template_filters', JSON.stringify(localTemplateFilters)); } catch (_) {}
}

function applyLocalTemplateFilter(tpl) {
  if (!tpl) return;
  const savedCI = Number(localTemplateFilters[String(tpl.id)]);
  tpl.filterActive = Number.isInteger(savedCI) && savedCI >= 0 && savedCI < paletteHex.length;
  tpl.filterCI = tpl.filterActive ? savedCI : -1;
  tpl.filterCanvas = tpl.filterActive && tpl.rawIndices ? getTemplateFilterCanvas(tpl, savedCI) : null;
}

function scheduleTemplateSave() {
  clearTimeout(tplSaveTmr);
  tplSaveTmr = setTimeout(saveTemplatesToIDB, 1500);
}

async function saveTemplatesToIDB() {
  if (!idb) return;
  const list = templates.filter(tpl => !tpl.draft).map(tpl => ({
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
    // store rawIndices as plain array (IDB-safe serialization)
    // IndexedDB clones typed arrays natively; converting to Array creates a
    // much larger temporary allocation for every template save.
    rawIndices:    tpl.rawIndices || null,
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
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = (err) => rej(err || new Error('Image load failed'));
    img.src = src;
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
        filterActive: false, filterCI: -1, filterCanvas: null,
        canvas: null, rawIndices: null, stitchCanvas: null,
      };
      if (saved.confirmed && saved.rawIndices) {
        tpl.rawIndices = new Int16Array(saved.rawIndices);
        tpl.canvas     = buildCanvasFromRawIndices(tpl.rawIndices, saved.w, saved.h);
        tpl.stitchCanvas = makeStitchCanvas(tpl.rawIndices, saved.w, saved.h);
      }
      applyLocalTemplateFilter(tpl);
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
  setOffscreenPaletteColor(ci);
  offCtx.fillRect(x, y, 1, 1);
  if (canvasData) canvasData[y * CS + x] = ci;
}

function setOffscreenPaletteColor(ci) {
  if (offscreenFillCI === ci) return;
  offCtx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
  offscreenFillCI = ci;
}
/* 15-bit High-Speed Color Quantization Cache (32,768 entries = 64KB RAM) */
const rgb15Cache = new Int16Array(32768).fill(-1);

function nearestPaletteIndexRGB(r, g, b) {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  const cached = rgb15Cache[key];
  if (cached !== -1) return cached;

  let best = 0, bestD = Infinity;
  for (let p = 0; p < palRGB.length; p++) {
    const [pr, pg, pb] = palRGB[p];
    const rmean = (r + pr) >> 1;
    const dr = r - pr, dg = g - pg, db = b - pb;
    const d = (((512 + rmean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rmean) * db * db) >> 8);
    if (d < bestD) { bestD = d; best = p; }
  }
  rgb15Cache[key] = best;
  return best;
}

function nearestPaletteIndex(hex) {
  const [r, g, b] = hexToRGB(hex);
  return nearestPaletteIndexRGB(r, g, b);
}

function markDirty() { dirty = true; if (!rafId) rafId = requestAnimationFrame(loop); }
function loop()      { rafId = null; if (dirty) { dirty = false; render(); } }

function drawTemplateGuideBitmap(tpl, ox, oy, tplW, tplH, srcW, srcH) {
  const tx = Math.round((ox - vx) * vz), ty = Math.round((oy - vy) * vz);
  const tw = Math.round(tplW * vz), th = Math.round(tplH * vz);
  const bitmap = tpl.filterActive && tpl.filterCanvas ? tpl.filterCanvas : tpl.canvas;
  if (!bitmap) return;

  // The bitmap fast path must leave painted cells visible, just like the
  // detailed guide. Index 0 is the canvas's empty/background color.
  ctx.save();
  if (canvasData) {
    const available = new Path2D();
    const x0 = Math.max(0, ox, Math.floor(vx));
    const x1 = Math.min(CS, ox + tplW, Math.ceil(vx + srcW));
    const y0 = Math.max(0, oy, Math.floor(vy));
    const y1 = Math.min(CS, oy + tplH, Math.ceil(vy + srcH));
    for (let y = y0; y < y1; y++) {
      let runStart = -1;
      for (let x = x0; x <= x1; x++) {
        const empty = x < x1 && canvasData[y * CS + x] === 0 &&
          tpl.rawIndices[(y - oy) * tplW + x - ox] !== 0;
        if (empty && runStart < 0) runStart = x;
        if (!empty && runStart >= 0) {
          const left = Math.round((runStart - vx) * vz);
          const top = Math.round((y - vy) * vz);
          available.rect(left, top, Math.round((x - vx) * vz) - left,
            Math.round((y + 1 - vy) * vz) - top);
          runStart = -1;
        }
      }
    }
    ctx.clip(available);
  }
  ctx.drawImage(bitmap, tx, ty, tw, th);

  // Preserve the visual language of an unpainted template at every zoom:
  // white space separates every guide cell instead of showing a solid image.
  const startPX = Math.max(0, Math.floor(vx - ox));
  const endPX = Math.min(tplW, Math.ceil(vx + srcW - ox));
  const startPY = Math.max(0, Math.floor(vy - oy));
  const endPY = Math.min(tplH, Math.ceil(vy + srcH - oy));
  if (startPX >= endPX || startPY >= endPY) { ctx.restore(); return; }

  ctx.save();
  ctx.beginPath();
  ctx.rect(tx, ty, tw, th);
  ctx.clip();
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = Math.max(0.35, vz * 0.44);
  ctx.beginPath();
  for (let px = startPX; px <= endPX; px++) {
    const sx = (ox + px - vx) * vz;
    ctx.moveTo(sx, ty);
    ctx.lineTo(sx, ty + th);
  }
  for (let py = startPY; py <= endPY; py++) {
    const sy = (oy + py - vy) * vz;
    ctx.moveTo(tx, sy);
    ctx.lineTo(tx + tw, sy);
  }
  ctx.stroke();
  ctx.restore();
  ctx.restore();
}

/* === Template canvas builders & Guide Renderer === */
function renderConfirmedTemplate(tpl, W, H, srcW, srcH) {
  if (!tpl.rawIndices) return;
  const tplW = Math.round(tpl.w);
  const tplH = Math.round(tpl.h);
  const ox = Math.round(tpl.x);
  const oy = Math.round(tpl.y);
  const filterCI = (tpl.filterActive && tpl.filterCI >= 0) ? tpl.filterCI : -1;

  if (vz >= 3) {
    const startPX = Math.max(0, Math.floor(vx - ox));
    const endPX   = Math.min(tplW, Math.ceil(vx + srcW - ox));
    const startPY = Math.max(0, Math.floor(vy - oy));
    const endPY   = Math.min(tplH, Math.ceil(vy + srcH - oy));

    if (startPX >= endPX || startPY >= endPY) return;

    // A dense guide can contain hundreds of thousands of visible cells.
    // Use the cached bitmap until zoom is close enough for individual guide
    // dots to be useful, then switch back automatically.
    if ((endPX - startPX) * (endPY - startPY) > MAX_DETAILED_TEMPLATE_CELLS) {
      drawTemplateGuideBitmap(tpl, ox, oy, tplW, tplH, srcW, srcH);
      return;
    }

    const whitePath = new Path2D();
    const colorPaths = new Array(palRGB.length);

    for (let py = startPY; py < endPY; py++) {
      const cy = oy + py;
      if (cy < 0 || cy >= CS) continue;
      const tplRow = py * tplW;
      const canvasRow = cy * CS;

      for (let px = startPX; px < endPX; px++) {
        const ci = tpl.rawIndices[tplRow + px];
        if (ci < 0) continue;
        if (filterCI >= 0 && ci !== filterCI) continue;

        const cx = ox + px;
        if (cx < 0 || cx >= CS) continue;

        // Any painted color takes precedence over the template guide.
        if (canvasData && (canvasData[canvasRow + cx] !== 0 || canvasData[canvasRow + cx] === ci)) {
          continue;
        }

        const sx = Math.round((cx - vx) * vz);
        const sy = Math.round((cy - vy) * vz);
        const ex = Math.round((cx + 1 - vx) * vz);
        const ey = Math.round((cy + 1 - vy) * vz);
        const pw = ex - sx;
        const ph = ey - sy;
        if (pw <= 0 || ph <= 0) continue;

        // Build paths first, then paint them in at most 65 draw calls instead
        // of changing fill color and drawing twice for every visible pixel.
        whitePath.rect(sx, sy, pw, ph);

        // 2. Draw centered colored dot with white border
        const marginX = Math.max(1, Math.round(pw * 0.22));
        const marginY = Math.max(1, Math.round(ph * 0.22));
        const dotW = pw - marginX * 2;
        const dotH = ph - marginY * 2;

        if (dotW > 0 && dotH > 0) {
          let colorPath = colorPaths[ci];
          if (!colorPath) colorPath = colorPaths[ci] = new Path2D();
          colorPath.rect(sx + marginX, sy + marginY, dotW, dotH);
        }
      }
    }

    ctx.fillStyle = '#FFFFFF';
    ctx.fill(whitePath);
    for (let ci = 0; ci < colorPaths.length; ci++) {
      if (!colorPaths[ci]) continue;
      ctx.fillStyle = palRGBStrings[ci] || paletteHex[ci];
      ctx.fill(colorPaths[ci]);
    }
  } else {
    drawTemplateGuideBitmap(tpl, ox, oy, tplW, tplH, srcW, srcH);
  }
}

function makeStitchCanvas(rawIndices, W, H) {
  return buildCanvasFromRawIndices(rawIndices, W, H);
}

function makeFilterStitchCanvas(rawIndices, W, H, targetCI) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d'), img = tctx.createImageData(W, H);
  const u32 = new Uint32Array(img.data.buffer);
  const c32 = palUint32[targetCI] || 0xFF000000;
  for (let i = 0; i < rawIndices.length; i++) {
    if (rawIndices[i] === targetCI) u32[i] = c32;
  }
  tctx.putImageData(img, 0, 0);
  return tmp;
}

function getTemplateFilterCanvas(tpl, targetCI) {
  if (!tpl || !tpl.rawIndices || targetCI < 0) return null;
  if (!tpl.filterCanvasCache) tpl.filterCanvasCache = new Map();
  if (tpl.filterCanvasCache.has(targetCI)) return tpl.filterCanvasCache.get(targetCI);
  const filtered = makeFilterStitchCanvas(tpl.rawIndices, Math.round(tpl.w), Math.round(tpl.h), targetCI);
  // Keep a small LRU-style cache: enough for quick color switching without
  // retaining dozens of full template canvases on memory-limited phones.
  if (tpl.filterCanvasCache.size >= 3) {
    const oldest = tpl.filterCanvasCache.keys().next().value;
    tpl.filterCanvasCache.delete(oldest);
  }
  tpl.filterCanvasCache.set(targetCI, filtered);
  return filtered;
}

function buildPaletteCanvas(origImage, W, H) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d');
  tctx.imageSmoothingEnabled = true; tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(origImage, 0, 0, W, H);
  const src = tctx.getImageData(0, 0, W, H);
  const dst = tctx.createImageData(W, H);
  const src32 = new Uint32Array(src.data.buffer);
  const dst32 = new Uint32Array(dst.data.buffer);
  const rawIndices = new Int16Array(W * H).fill(-1);
  const len = src32.length;

  for (let i = 0; i < len; i++) {
    const pixel = src32[i];
    const a = (pixel >> 24) & 0xFF;
    if (a < 60) {
      dst32[i] = 0;
      continue;
    }
    const r = pixel & 0xFF;
    const g = (pixel >> 8) & 0xFF;
    const b = (pixel >> 16) & 0xFF;

    const best = nearestPaletteIndexRGB(r, g, b);
    rawIndices[i] = best;
    dst32[i] = palUint32[best] || 0xFF000000;
  }
  tctx.putImageData(dst, 0, 0);
  return { canvas: tmp, rawIndices };
}

function buildCanvasFromRawIndices(rawIndices, W, H) {
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  const tctx = tmp.getContext('2d'), img = tctx.createImageData(W, H);
  const u32 = new Uint32Array(img.data.buffer);
  const len = rawIndices.length;
  for (let i = 0; i < len; i++) {
    const ci = rawIndices[i];
    if (ci >= 0) u32[i] = palUint32[ci] || 0xFF000000;
  }
  tctx.putImageData(img, 0, 0);
  return tmp;
}

function applyStampTemplate(tpl, startX, startY, filterCI) {
  if (!tpl || !tpl.rawIndices) return 0;
  const W = Math.round(tpl.w);
  const H = Math.round(tpl.h);
  const ox = Math.round(startX);
  const oy = Math.round(startY);
  let painted = 0;
  const flushRun = (y, start, end, ci) => {
    if (ci < 0 || end <= start) return;
    setOffscreenPaletteColor(ci);
    offCtx.fillRect(start, y, end - start, 1);
  };
  for (let py = 0; py < H; py++) {
    const y = oy + py;
    if (y < 0 || y >= CS) continue;
    const rowOffset = y * CS;
    const tplRow = py * W;
    let runCI = -1, runStart = 0, runEnd = 0;
    for (let px = 0; px < W; px++) {
      const x = ox + px;
      const ci = tpl.rawIndices[tplRow + px];
      const valid = x >= 0 && x < CS && ci >= 0 && (filterCI < 0 || ci === filterCI);
      if (!valid) {
        flushRun(y, runStart, runEnd, runCI);
        runCI = -1;
        continue;
      }
      if (canvasData) canvasData[rowOffset + x] = ci;
      painted++;
      if (ci === runCI && x === runEnd) runEnd++;
      else {
        flushRun(y, runStart, runEnd, runCI);
        runCI = ci; runStart = x; runEnd = x + 1;
      }
    }
    flushRun(y, runStart, runEnd, runCI);
  }
  markDirty();
  scheduleIDBSave();
  return painted;
}

function encodeStampBytes(rawIndices, start, end) {
  let binary = '';
  for (let i = start; i < end; i++) binary += String.fromCharCode(rawIndices[i] >= 0 ? rawIndices[i] : 255);
  return btoa(binary);
}

function applyRemoteStampChunk(p) {
  if (!p || typeof p.data !== 'string' || p.data.length > 24000 || !canvasData) return;
  let binary;
  try { binary = atob(p.data); } catch (_) { return; }
  const W = Math.max(1, Math.round(Number(p.w) || 0));
  const ox = Math.round(Number(p.x) || 0), oy = Math.round(Number(p.y) || 0);
  const offset = Math.max(0, Math.round(Number(p.offset) || 0));
  const filterCI = Number.isInteger(p.filterCI) ? p.filterCI : -1;
  let runCI = -1, runY = -1, runStart = 0, runEnd = 0;
  const flushRun = () => {
    if (runCI < 0 || runY < 0 || runEnd <= runStart) return;
    setOffscreenPaletteColor(runCI);
    offCtx.fillRect(runStart, runY, runEnd - runStart, 1);
  };
  for (let i = 0; i < binary.length; i++) {
    const absolute = offset + i;
    const px = absolute % W, py = Math.floor(absolute / W);
    const x = ox + px, y = oy + py, ci = binary.charCodeAt(i);
    const valid = x >= 0 && x < CS && y >= 0 && y < CS && ci < 255 && (filterCI < 0 || ci === filterCI);
    if (!valid) { flushRun(); runCI = -1; runY = -1; continue; }
    canvasData[y * CS + x] = ci;
    if (ci === runCI && y === runY && x === runEnd) runEnd++;
    else { flushRun(); runCI = ci; runY = y; runStart = x; runEnd = x + 1; }
  }
  flushRun();
  let op = remoteStampOps.get(p.opId);
  if (!op) { op = new Set(); remoteStampOps.set(p.opId, op); }
  op.add(offset);
  markDirty();
  scheduleIDBSave();
}

async function waitForRealtimeBuffer() {
  while (ws && ws.readyState === WebSocket.OPEN && ws.bufferedAmount > 256 * 1024) {
    await new Promise(resolve => setTimeout(resolve, 24));
  }
}

async function stampTemplate(tpl) {
  if (!tpl.confirmed || !tpl.rawIndices) return;
  if (stampSyncInFlight) { showToast('Ya se está sincronizando otra plantilla', ''); return; }
  stampSyncInFlight = true;
  const fci = (tpl.filterActive && tpl.filterCI >= 0) ? tpl.filterCI : -1;
  const W = Math.round(tpl.w);
  const H = Math.round(tpl.h);
  const ox = Math.round(tpl.x);
  const oy = Math.round(tpl.y);
  try {
    showToast('Calcando y sincronizando plantilla…', '');
    const painted = applyStampTemplate(tpl, ox, oy, fci);
    playPixelSound();
    const CHUNK_SIZE = 12000;
    const totalChunks = Math.ceil(tpl.rawIndices.length / CHUNK_SIZE);
    const opId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    if (ws && ws.readyState === WebSocket.OPEN) {
      for (let offset = 0; offset < tpl.rawIndices.length; offset += CHUNK_SIZE) {
        await waitForRealtimeBuffer();
        const end = Math.min(offset + CHUNK_SIZE, tpl.rawIndices.length);
        sendRealtime({
          topic: 'realtime:bplace', event: 'broadcast',
          payload: { type: 'broadcast', event: 'stamp_chunk', payload: {
            opId, id: tpl.id, x: ox, y: oy, w: W, h: H,
            filterCI: fci, offset, data: encodeStampBytes(tpl.rawIndices, offset, end)
          } },
          ref: String(sbMsgRef++)
        });
        // Stay comfortably below realtime message-rate limits on every plan.
        await new Promise(resolve => setTimeout(resolve, 24));
      }
    }
    const uploaded = await uploadCanvasToCloudStorage();
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRealtime({
        topic: 'realtime:bplace', event: 'broadcast',
        payload: { type: 'broadcast', event: 'stamp_checkpoint', payload: { opId, totalChunks, uploaded } },
        ref: String(sbMsgRef++)
      });
    }
    showToast(uploaded ? 'Plantilla calcada y sincronizada (' + painted + ' px)' : 'Calcado pendiente de guardar; reintentando…', uploaded ? 'success' : 'error');
  } catch (e) {
    console.error('[Templates] Error al sincronizar el calcado:', e);
    showToast('El calcado local terminó, pero falló la sincronización', 'error');
  } finally {
    stampSyncInFlight = false;
  }
}

function confirmTemplate(tpl) {
  if (!tpl || tpl.confirming) return;
  const W = Math.max(10, Math.round(tpl.w));
  const H = Math.max(10, Math.round(tpl.h));
  tpl.confirming = true;
  showToast('Procesando plantilla...', '');
  setTimeout(() => {
    try {
      const { canvas, rawIndices } = buildPaletteCanvas(tpl.origImage, W, H);
      tpl.canvas = canvas; tpl.rawIndices = rawIndices;
      tpl.w = W; tpl.h = H;
      tpl.stitchCanvas = makeStitchCanvas(rawIndices, W, H);
      tpl.filterCanvasCache = null;
      tpl.confirmed = true; tpl.filterActive = false; tpl.filterCI = -1; tpl.filterCanvas = null;
      removeLocalTemplateFilter(tpl.id);
      const wasDraft = !!tpl.draft;
      tpl.draft = false;
      tpl.confirming = false;
      closeTemplateAdjustment();
      renderTemplateList(); markDirty();
      saveTemplatesToIDB();
      if (wasDraft) publishTemplate(tpl);
      else sendTemplateUpdate(tpl);
      showToast('Plantilla confirmada como guía', 'success');
      selectTemplateForPainting(tpl);
    } catch (error) {
      tpl.confirming = false;
      console.error('No se pudo procesar la plantilla:', error);
      showToast('No se pudo procesar esta imagen', 'error');
    }
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
  const R = IS_COARSE_POINTER ? 18 : 10;
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

  // Keep the workspace visually continuous with the white 3000×3000 canvas.
  // Areas outside its bounds stay white at every zoom level.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = false;
  const srcW = W / vz, srcH = H / vz;
  const sx = clamp(vx, 0, CS), sy = clamp(vy, 0, CS);
  const ex = clamp(vx + srcW, 0, CS), ey = clamp(vy + srcH, 0, CS);
  if (sx < ex && sy < ey) {
    ctx.drawImage(offscreen, sx, sy, ex - sx, ey - sy, (sx - vx) * vz, (sy - vy) * vz, (ex - sx) * vz, (ey - sy) * vz);
  }

  if (vz >= 7) drawGrid(W, H, srcW, srcH);

  const tplCount = templates.length;
  for (let i = 0; i < tplCount; i++) {
    const tpl = templates[i];
    if (!tpl || tpl.visible === false) continue;
    const tx = Math.round((tpl.x - vx) * vz), ty = Math.round((tpl.y - vy) * vz);
    const tw = Math.round(tpl.w * vz),      th = Math.round(tpl.h * vz);
    if (tw <= 0 || th <= 0) continue;
    // Viewport Culling
    if (tx + tw < 0 || tx > W || ty + th < 0 || ty > H) continue;

    ctx.globalAlpha = tpl.opacity !== undefined ? tpl.opacity : 0.85;
    if (!tpl.confirmed) {
      ctx.imageSmoothingEnabled = true;
      if (tpl.origImage && (tpl.origImage.complete || tpl.origImage.naturalWidth)) {
        ctx.drawImage(tpl.origImage, tx, ty, tw, th);
      } else if (tpl.origImageURL) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => { tpl.origImage = img; markDirty(); };
        img.src = tpl.origImageURL;
        tpl.origImage = img;
      }
      ctx.imageSmoothingEnabled = false;
    } else {
      // Confirmed template: render guide pixels with white borders, auto-clearing when painted
      renderConfirmedTemplate(tpl, W, H, srcW, srcH);
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = !tpl.confirmed ? 'rgba(255,220,50,.95)' : tpl.filterActive ? (tpl.filterCI >= 0 ? paletteHex[tpl.filterCI] : '#fff') : 'rgba(90,150,255,.5)';
    ctx.lineWidth = !tpl.confirmed ? 2.5 : 1;
    ctx.setLineDash(!tpl.confirmed ? [6, 4] : [4, 4]);
    ctx.strokeRect(tx + .5, ty + .5, tw - 1, th - 1);
    ctx.setLineDash([]);
    if (!tpl.confirmed) {
      getHandlePositions(tx, ty, tw, th).forEach(h => {
        ctx.beginPath(); ctx.arc(h.sx, h.sy, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#4a9eff'; ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();
      });
    }
  }
}

function drawGrid(W, H, srcW, srcH) {
  if (vz < 12) return;
  ctx.strokeStyle = isLightThemeCached ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  const x0 = Math.max(0, Math.floor(vx)), y0 = Math.max(0, Math.floor(vy));
  const x1 = Math.min(CS, Math.ceil(vx + srcW)), y1 = Math.min(CS, Math.ceil(vy + srcH));
  ctx.beginPath();
  for (let x = x0; x <= x1; x++) { const p = Math.round((x - vx) * vz) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
  for (let y = y0; y <= y1; y++) { const p = Math.round((y - vy) * vz) + 0.5; ctx.moveTo(0, p); ctx.lineTo(W, p); }
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

function getZoomDisplay() {
  if (!zoomDisplayEl) zoomDisplayEl = $('zoom-display');
  return zoomDisplayEl;
}

function getViewportMinZoom() {
  if (!mainCanvas || !mainCanvas.width || !mainCanvas.height) return MIN_Z;
  return Math.max(MIN_Z, mainCanvas.width / CS, mainCanvas.height / CS);
}

function constrainViewport() {
  const viewW = mainCanvas.width / vz;
  const viewH = mainCanvas.height / vz;
  vx = clamp(vx, 0, Math.max(0, CS - viewW));
  vy = clamp(vy, 0, Math.max(0, CS - viewH));
}

function doZoom(f, cx, cy) {
  const nz = clamp(vz * f, getViewportMinZoom(), MAX_Z);
  if (nz === vz) return;
  const wx = cx / vz + vx, wy = cy / vz + vy;
  vz = nz;
  vx = wx - cx / vz;
  vy = wy - cy / vz;
  constrainViewport();
  const zd = getZoomDisplay();
  if (zd) zd.textContent = Math.round(vz * 100) + '%';
  markDirty();
}
function fitCanvas(){vz=getViewportMinZoom();vx=(CS-mainCanvas.width/vz)/2;vy=(CS-mainCanvas.height/vz)/2;constrainViewport();$('zoom-display').textContent=Math.round(vz*100)+'%';markDirty();}
function goTo(cx,cy){vx=cx-mainCanvas.width/2/vz;vy=cy-mainCanvas.height/2/vz;constrainViewport();markDirty();}

/* === Tools === */
function setTool(t){
  tool=t;
  playSelectSound();
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
function setShapeFilled(f){shapeFilled=f;$('opt-filled').classList.toggle('active',f);$('opt-hollow').classList.toggle('active',!f);playSelectSound();}

/* === Color === */
let currentPaletteCI = 5; // Default to black (#000000)

function setCurrentColor(hex,addToRecent){
  if(addToRecent===undefined)addToRecent=true;
  playSelectSound();
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
      tpl.filterCanvas=getTemplateFilterCanvas(tpl,ci);
      saveLocalTemplateFilter(tpl);
      markDirty();
    }
  });
  updateTemplateContextToolbar();
  if (!paintModeActive) {
    activatePaintMode(tool || 'brush');
  }
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
function executeFloodFill(sx, sy, ni) {
  if (!canvasData || sx < 0 || sx >= CS || sy < 0 || sy >= CS || ni < 0 || ni >= palRGB.length) return;
  const idx0 = sy * CS + sx;
  const oi = canvasData[idx0];
  if (oi === ni) return;

  const stack = [idx0];
  setOffscreenPaletteColor(ni);

  while (stack.length > 0) {
    const idx = stack.pop();
    if (canvasData[idx] !== oi) continue;
    const y = Math.floor(idx / CS);
    const x = idx % CS;

    let lx = x;
    while (lx > 0 && canvasData[y * CS + (lx - 1)] === oi) lx--;
    let rx = x;
    while (rx < CS - 1 && canvasData[y * CS + (rx + 1)] === oi) rx++;

    const fillWidth = rx - lx + 1;
    const rowOffset = y * CS + lx;
    canvasData.fill(ni, rowOffset, rowOffset + fillWidth);
    offCtx.fillRect(lx, y, fillWidth, 1);

    if (y > 0) {
      let scanAbove = false;
      const aboveOffset = (y - 1) * CS;
      for (let i = lx; i <= rx; i++) {
        if (canvasData[aboveOffset + i] === oi) {
          if (!scanAbove) { stack.push(aboveOffset + i); scanAbove = true; }
        } else { scanAbove = false; }
      }
    }
    if (y < CS - 1) {
      let scanBelow = false;
      const belowOffset = (y + 1) * CS;
      for (let i = lx; i <= rx; i++) {
        if (canvasData[belowOffset + i] === oi) {
          if (!scanBelow) { stack.push(belowOffset + i); scanBelow = true; }
        } else { scanBelow = false; }
      }
    }
  }

  markDirty();
  scheduleIDBSave();
}

function floodFill(sx, sy, newHex) {
  const ni = nearestPaletteIndex(newHex);
  executeFloodFill(sx, sy, ni);
  scheduleCloudCanvasSave();
  playPixelSound();

  if (ws && ws.readyState === WebSocket.OPEN) {
    sendRealtime({
      topic: 'realtime:bplace',
      event: 'broadcast',
      payload: {
        type: 'broadcast',
        event: 'fill',
        payload: { x: sx, y: sy, c: ni }
      },
      ref: String(sbMsgRef++)
    });
  }
}
function bresenhamLine(x0,y0,x1,y1,fn){const dx=Math.abs(x1-x0),dy=Math.abs(y1-y0),sx=x0<x1?1:-1,sy=y0<y1?1:-1;let err=dx-dy;for(;;){fn(x0,y0);if(x0===x1&&y0===y1)break;const e2=2*err;if(e2>-dy){err-=dy;x0+=sx;}if(e2<dx){err+=dx;y0+=sy;}}}
function paintBrush(cx, cy, ci) {
  const r = Math.floor(brushSize / 2);
  if (brushSize === 1) {
    if (inCanvas(cx, cy)) setPixelPalette(cx, cy, ci);
    return;
  }
  const minX = Math.max(0, cx - r);
  const maxX = Math.min(CS - 1, cx + r);
  const minY = Math.max(0, cy - r);
  const maxY = Math.min(CS - 1, cy + r);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w <= 0 || h <= 0) return;

  setOffscreenPaletteColor(ci);
  offCtx.fillRect(minX, minY, w, h);
  if (canvasData) {
    for (let py = minY; py <= maxY; py++) {
      const rowOffset = py * CS + minX;
      canvasData.fill(ci, rowOffset, rowOffset + w);
    }
  }
}
function paintRect(x0, y0, x1, y1, ci, f) {
  const lx = Math.max(0, Math.min(x0, x1));
  const rx = Math.min(CS - 1, Math.max(x0, x1));
  const ty = Math.max(0, Math.min(y0, y1));
  const by = Math.min(CS - 1, Math.max(y0, y1));
  const w = rx - lx + 1;
  const h = by - ty + 1;
  if (w <= 0 || h <= 0) return;

  setOffscreenPaletteColor(ci);
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
  setOffscreenPaletteColor(ci);
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
      drawPixel(cx + px, cy + py);
      drawPixel(cx - px, cy + py);
      drawPixel(cx + px, cy - py);
      drawPixel(cx - px, cy - py);
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
  playPixelSound();
  if (brushSize === 1) {
    queueWSPixel(x, y, ci);
  } else {
    sendWSShape({ type: 'line', x0: x, y0: y, x1: x, y1: y, c: ci, size: brushSize });
  }
}

function paintLineMain(x0, y0, x1, y1) {
  const ci = currentPaletteCI;
  bresenhamLine(x0, y0, x1, y1, (x, y) => {
    paintBrush(x, y, ci);
  });
  markDirty();
  playPixelSound();
  queueWSLine(x0, y0, x1, y1, ci, brushSize);
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
  }
  playPixelSound();
  markDirty();
  scheduleIDBSave();
  flushWSPixels();
  flushWSLines();
}

/* === Canvas draw event handlers === */
function onMouseDown(e){
  e.preventDefault();
  const rect=getCanvasRect(true),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
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
    queueWSLine(x,y,x,y,0,brushSize);
    markDirty();
    playPixelSound();
  }
  else paintPixelMain(x,y);
}
function onMouseMove(e){
  const rect=getCanvasRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
  updateHover(sx,sy);
  if(panning){vx-=(e.clientX-panX)/vz;vy-=(e.clientY-panY)/vz;panX=e.clientX;panY=e.clientY;constrainViewport();markDirty();return;}
  if(shapeStart&&e.buttons===1){renderGhost(shapeStart.x,shapeStart.y,x,y);return;}
  if(spaceHeld&&inCanvas(x,y)){
    if(tool==='brush'||tool==='erase'){
      const ci=tool==='erase'?0:currentPaletteCI;
      if(spLX>=0) {
        paintLineMain(spLX,spLY,x,y);
      } else {
        paintBrush(x,y,ci);
        queueWSLine(x,y,x,y,ci,brushSize);
        playPixelSound();
      }
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
      if(x!==drawLX||y!==drawLY){
        bresenhamLine(drawLX,drawLY,x,y,(px,py)=>{paintBrush(px,py,ci);});
        queueWSLine(drawLX,drawLY,x,y,0,brushSize);
        markDirty();
        playPixelSound();
      }
      drawLX=x;drawLY=y;
    }
  }
}
function onMouseUp(e){
  if(panning){panning=false;wrap.classList.remove('panning');return;}
  if(shapeStart&&e.button===0){const rect=getCanvasRect(),{x,y}=s2c(e.clientX-rect.left,e.clientY-rect.top);clearGhost();commitShape(shapeStart.x,shapeStart.y,x,y);shapeStart=null;return;}
  if(drawing){drawing=false;drawLX=-1;drawLY=-1;scheduleIDBSave();flushWSPixels();flushWSLines();}
}
function onMouseLeave(){$('px-cursor').classList.add('hidden');$('coord-display').textContent='- , -';mainCanvas.style.cursor='';drawing=false;if(panning){panning=false;wrap.classList.remove('panning');}}
function onWheel(e){
  e.preventDefault();
  const r=getCanvasRect();
  const unit=e.deltaMode===1?16:e.deltaMode===2?mainCanvas.height:1;
  const delta=clamp(e.deltaY*unit,-240,240);
  doZoom(Math.exp(-delta*0.0014),e.clientX-r.left,e.clientY-r.top);
}
function onKeyDown(e){const tag=e.target.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT')return;switch(e.key.toLowerCase()){case 'b':activatePaintMode('brush');break;case 'e':activatePaintMode('erase');break;case 'i':if(paintModeActive)setTool('eye');break;case 'l':if(paintModeActive)setTool('line');break;case 'r':if(paintModeActive)setTool('rect');break;case 'c':if(paintModeActive)setTool('circle');break;case 'f':fitCanvas();break;case 'x':swapColors();break;case '+':case '=':doZoom(1.25,mainCanvas.width/2,mainCanvas.height/2);break;case '-':doZoom(.8,mainCanvas.width/2,mainCanvas.height/2);break;case '[':setBrushSize(Math.max(1,brushSize-1));break;case ']':setBrushSize(Math.min(32,brushSize+1));break;case 'escape':if(paintModeActive)deactivatePaintMode();break;case ' ':if(!e.repeat){spaceHeld=true;spLX=-1;spLY=-1;}e.preventDefault();break;}}
function onKeyUp(e){if(e.key===' '){spaceHeld=false;spLX=-1;spLY=-1;}}

/* === Paint Mode === */
function activatePaintMode(toolName) {
  playSelectSound();
  paintModeActive = true;
  document.body.classList.add('paint-mode');
  setTool(toolName || tool || 'brush');
}
function deactivatePaintMode() {
  playCloseSound();
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
function resize(){const w=wrap.clientWidth,h=wrap.clientHeight;if(mainCanvas.width!==w||mainCanvas.height!==h){mainCanvas.width=w;mainCanvas.height=h;ghostCanvas.width=w;ghostCanvas.height=h;cachedCanvasRect=null;const minZoom=getViewportMinZoom();if(vz<minZoom)vz=minZoom;constrainViewport();const zd=getZoomDisplay();if(zd)zd.textContent=Math.round(vz*100)+'%';markDirty();}}
function setBrushSize(s) {
  brushSize = clamp(s, 1, 32);
  playSelectSound();
  const bs = $('brush-size');
  if (bs) bs.value = brushSize;
  const bsv = $('brush-size-val');
  if (bsv) bsv.textContent = brushSize;
}

/* === Compact Top Template Adjustment Card State & Controller === */
let activeAdjustingTpl = null;
let adjustCardDimRaf = null;
let pendingAdjustingTpl = null;

function openTemplateAdjustment(tpl) {
  if (!tpl) return;
  document.body.classList.remove('template-library-open', 'template-painting');
  activePaintingTemplateId = null;
  const contextToolbar = $('tpl-context-toolbar');
  if (contextToolbar) contextToolbar.classList.add('hidden');
  activeAdjustingTpl = tpl;
  const nameEl = $('tac-filename');
  const dimEl = $('tac-dimensions');
  if (nameEl) nameEl.textContent = tpl.name || 'Plantilla';
  if (dimEl) dimEl.textContent = Math.round(tpl.w) + ' × ' + Math.round(tpl.h) + ' píxeles';
  
  const opIn = $('tac-opacity-slider');
  const opVal = $('tac-opacity-val');
  if (opIn) opIn.value = tpl.opacity !== undefined ? tpl.opacity : 0.85;
  if (opVal) opVal.textContent = Math.round((tpl.opacity !== undefined ? tpl.opacity : 0.85) * 100) + '%';
  
  // Hide large panel and exit paint mode so tools do not obstruct
  const tplPanel = $('tpl-panel');
  if (tplPanel) tplPanel.classList.add('hidden');
  deactivatePaintMode();
  
  document.body.classList.add('adjusting-template');
  const adjustCard = $('tpl-adjust-card');
  if (adjustCard) adjustCard.classList.remove('hidden');
  
  markDirty();
}

function closeTemplateAdjustment() {
  activeAdjustingTpl = null;
  document.body.classList.remove('adjusting-template');
  const adjustCard = $('tpl-adjust-card');
  if (adjustCard) adjustCard.classList.add('hidden');
  markDirty();
}

function updateAdjustCardDimensions(tpl) {
  if (!tpl) return;
  pendingAdjustingTpl = tpl;
  if (adjustCardDimRaf) return;
  adjustCardDimRaf = requestAnimationFrame(() => {
    adjustCardDimRaf = null;
    const current = pendingAdjustingTpl;
    pendingAdjustingTpl = null;
    if (!current || !activeAdjustingTpl || activeAdjustingTpl.id !== current.id) return;
    const dimEl = $('tac-dimensions');
    const text = Math.round(current.w) + ' × ' + Math.round(current.h) + ' píxeles';
    if (dimEl && dimEl.textContent !== text) dimEl.textContent = text;
  });
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
function loadTemplateFile(file) {
  if (templates.length >= MAX_TPLS) { showToast('Máximo ' + MAX_TPLS + ' plantillas', 'error'); return; }
  if (!file || !file.type || !file.type.startsWith('image/')) {
    showToast('Selecciona una imagen válida', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const dataURL = e.target.result;
    const img = new Image();
    img.onload = () => {
      // Calculate position at current center of user viewport
      const viewW = mainCanvas.width / vz;
      const viewH = mainCanvas.height / vz;
      const maxInitialDim = Math.min(600, Math.round(Math.min(viewW, viewH) * 0.7));
      let initW = img.naturalWidth || 200;
      let initH = img.naturalHeight || 200;
      if (initW > maxInitialDim || initH > maxInitialDim) {
        const aspect = initW / initH;
        if (aspect >= 1) {
          initW = maxInitialDim;
          initH = Math.max(10, Math.round(maxInitialDim / aspect));
        } else {
          initH = maxInitialDim;
          initW = Math.max(10, Math.round(maxInitialDim * aspect));
        }
      }
      const initX = Math.round(clamp(vx + (viewW - initW) / 2, 0, CS - initW));
      const initY = Math.round(clamp(vy + (viewH - initH) / 2, 0, CS - initH));

      const tpl = {
        id: Date.now(),
        name: file.name,
        origImage: img,
        origImageURL: dataURL,
        canvas: null, rawIndices: null, stitchCanvas: null,
        filterActive: false, filterCI: -1, filterCanvas: null,
        x: initX, y: initY, w: initW, h: initH,
        opacity: 0.85, visible: true, confirmed: false, draft: true,
        aspectRatio: (img.naturalWidth || initW) / (img.naturalHeight || initH),
      };
      templates.push(tpl);
      renderTemplateList();
      markDirty();

      // Keep this template local and provisional until the user confirms it.
      openTemplateAdjustment(tpl);
      showToast('Mueve y ajusta la imagen; confirma con ✓', 'success');
    };
    img.src = dataURL;
  };
  reader.readAsDataURL(file);
}

function getActivePaintingTemplate() {
  return templates.find(tpl => tpl.id === activePaintingTemplateId && tpl.confirmed) || null;
}

function updateTemplateLibraryCount() {
  const count = templates.length;
  const badge = $('tpl-count-badge');
  if (badge) {
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.classList.toggle('hidden', count === 0);
  }
  const subtitle = $('tpl-library-subtitle');
  if (subtitle) subtitle.textContent = count ? count + (count === 1 ? ' plantilla importada' : ' plantillas importadas') : 'Administra tus plantillas';
}

function updateTemplateContextToolbar() {
  const tpl = getActivePaintingTemplate();
  const bar = $('tpl-context-toolbar');
  if (!bar) return;
  bar.classList.toggle('hidden', !tpl);
  document.body.classList.toggle('template-painting', !!tpl);
  if (!tpl) return;
  const name = $('tpl-context-name');
  if (name) name.textContent = tpl.name || 'Plantilla';
  const filter = $('tpl-context-filter');
  if (filter) {
    filter.classList.toggle('active', !!tpl.filterActive);
    filter.setAttribute('aria-pressed', String(!!tpl.filterActive));
  }
  const swatch = $('tpl-context-filter-swatch');
  if (swatch) swatch.style.backgroundColor = paletteHex[tpl.filterCI >= 0 ? tpl.filterCI : currentPaletteCI] || currentColorHex;
  updateCanvasLockUI();
}

function openTemplateLibrary() {
  closeTemplateAdjustment();
  activePaintingTemplateId = null;
  document.body.classList.remove('template-painting');
  document.body.classList.add('template-library-open');
  const bar = $('tpl-context-toolbar');
  if (bar) bar.classList.add('hidden');
  const panel = $('tpl-panel');
  if (panel) panel.classList.remove('hidden', 'collapsed');
  deactivatePaintMode();
  renderTemplateList();
}

function closeTemplateLibrary() {
  document.body.classList.remove('template-library-open');
  const panel = $('tpl-panel');
  if (panel) panel.classList.add('hidden');
}

function selectTemplateForPainting(tpl) {
  if (!tpl || !tpl.confirmed) return;
  if (tpl.remoteLoading) { showToast('La plantilla todavía se está descargando', ''); return; }
  tpl.visible = true;
  activePaintingTemplateId = tpl.id;
  closeTemplateLibrary();
  activatePaintMode(tool || 'brush');
  updateTemplateContextToolbar();
  renderTemplateList();
  markDirty();
  scheduleTemplateSave();
  sendTemplateUpdate(tpl);
}

function exitTemplatePainting(openLibrary = true) {
  activePaintingTemplateId = null;
  document.body.classList.remove('template-painting');
  const bar = $('tpl-context-toolbar');
  if (bar) bar.classList.add('hidden');
  if (openLibrary) openTemplateLibrary();
}

function toggleTemplateFilter(tpl) {
  if (!tpl || !tpl.confirmed) return;
  tpl.filterActive = !tpl.filterActive;
  if (tpl.filterActive) {
    const ci = nearestPaletteIndex(currentColorHex);
    tpl.filterCI = ci;
    tpl.filterCanvas = getTemplateFilterCanvas(tpl, ci);
    showToast('Filtro: ' + paletteHex[ci].toUpperCase(), '');
  } else {
    tpl.filterCI = -1;
    tpl.filterCanvas = null;
    showToast('Filtro desactivado', '');
  }
  renderTemplateList();
  updateTemplateContextToolbar();
  markDirty();
  saveLocalTemplateFilter(tpl);
}

function updateCanvasLockUI() {
  const lockedPath = '<path d="M7 11V7a5 5 0 0 1 10 0v4"/><rect x="3" y="11" width="18" height="11" rx="2"/>';
  const unlockedPath = '<path d="M7 11V7a5 5 0 0 1 9.9-1"/><rect x="3" y="11" width="18" height="11" rx="2"/>';
  [$('lock-icon'), $('tpl-context-lock-icon')].forEach(icon => { if (icon) icon.innerHTML = canvasLocked ? lockedPath : unlockedPath; });
  [$('btn-lock'), $('tpl-context-lock')].forEach(btn => {
    if (!btn) return;
    btn.classList.toggle('active', canvasLocked);
    btn.setAttribute('aria-pressed', String(canvasLocked));
  });
}

function setCanvasLocked(locked, notify = true) {
  canvasLocked = !!locked;
  updateCanvasLockUI();
  if (notify) showToast(canvasLocked ? 'Lienzo bloqueado: Desliza para pintar' : 'Lienzo libre: Desliza para mover, toca para pintar', 'success');
}

async function publishTemplate(tpl) {
  showToast('Sincronizando plantilla...', '');
  try {
    const cdnUrl = await uploadTemplateImageToStorage(tpl);
    if (cdnUrl) tpl.origImageURL = cdnUrl;

    const res = await fetch(`${SUPABASE_CONFIG.url}/rest/v1/templates`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_CONFIG.anonKey,
        'Authorization': 'Bearer ' + SUPABASE_CONFIG.anonKey,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        id: tpl.id,
        name: tpl.name,
        orig_image_url: tpl.origImageURL,
        x: tpl.x,
        y: tpl.y,
        w: tpl.w,
        h: tpl.h,
        opacity: tpl.opacity,
        visible: true,
        confirmed: true,
        filter_ci: -1
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    // Broadcast template_add with lightweight CDN URL
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRealtime({
        topic: 'realtime:bplace',
        event: 'broadcast',
        payload: {
          type: 'broadcast',
          event: 'template_add',
          payload: {
            template: {
              id: tpl.id,
              name: tpl.name,
              origImageURL: tpl.origImageURL,
              x: tpl.x,
              y: tpl.y,
              w: tpl.w,
              h: tpl.h,
              opacity: tpl.opacity,
              confirmed: true
            }
          }
        },
        ref: String(sbMsgRef++)
      });
    }

    announceTemplateRefresh(tpl);
    sendTemplateUpdate(tpl);
    showToast('Plantilla sincronizada para todos', 'success');
  } catch (err) {
    console.warn('[Supabase] Error saving template:', err);
    showToast('Plantilla guardada localmente', 'info');
  }
}

function syncTplInputs(tpl){
  updateAdjustCardDimensions(tpl);
  const panel=$('tpl-panel');if(!panel||panel.classList.contains('collapsed')||panel.classList.contains('hidden'))return;
  const idx=templates.findIndex(t=>t===tpl);
  const items=panel.querySelectorAll('.tpl-item');
  const item=items[idx];if(!item)return;
  const xi=item.querySelector('.tpl-x-inp'),yi=item.querySelector('.tpl-y-inp');
  const wi=item.querySelector('.tpl-w-inp'),hi=item.querySelector('.tpl-h-inp');
  if(xi)xi.value=Math.round(tpl.x);if(yi)yi.value=Math.round(tpl.y);
  if(wi)wi.value=Math.round(tpl.w);if(hi)hi.value=Math.round(tpl.h);
}

function renderTemplateList(){
  updateTemplateLibraryCount();
  const list=$('tpl-list');if(!list)return;list.innerHTML='';
  if (!templates || templates.length === 0) {
    list.innerHTML = '<div class="tpl-empty-state"><svg width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg><p>No hay plantillas cargadas</p><span>Sube una imagen para usarla como guía de trazado en el lienzo</span></div>';
    return;
  }
  templates.forEach(tpl=>{
    const div=document.createElement('div');div.className='tpl-item'+(tpl.confirmed?' confirmed':' pending')+(tpl.id===activePaintingTemplateId?' selected':'')+(tpl.remoteLoading?' loading':'');
    const thumbImg=document.createElement('img');
    thumbImg.className='tpl-item-thumb';
    thumbImg.crossOrigin='anonymous';
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
          '<button class="tpl-more-btn" data-act="more" title="Más opciones" aria-label="Más opciones">⋮</button>'+
          '<div class="tpl-item-actions">'+
            '<button class="tpl-icon-btn '+(tpl.visible?'active':'')+'" data-act="vis" title="Mostrar/Ocultar">'+(tpl.visible?eyeOpen():eyeClosed())+'</button>'+
            '<button class="tpl-icon-btn danger" data-act="del" title="Eliminar"><svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>'+
          '</div>'+
        '</div>'+
        '<div class="tpl-item-controls">'+
          '<div class="tpl-resize-hint">💡 Arrastra los círculos azules en el lienzo para ajustar o usa el popup superior:</div>'+
          '<button class="btn-confirm-tpl" data-act="adjust-card" style="margin-bottom:6px;background:var(--surface-hover);color:var(--text);border:1px solid var(--glass-border);">🔍 Ajustar en lienzo</button>'+
          '<button class="btn-confirm-tpl" data-act="confirm">✓ Confirmar Tamaño</button>'+
        '</div>';
      div.querySelector('[data-act="adjust-card"]').addEventListener('click',()=>openTemplateAdjustment(tpl));
      div.querySelector('[data-act="confirm"]').addEventListener('click',()=>confirmTemplate(tpl));
    } else {
      div.innerHTML=
        '<div class="tpl-item-main">'+
          '<div class="tpl-item-thumb-slot"></div>'+
          '<div class="tpl-item-info">'+
            '<div class="tpl-item-name" title="'+escapeHtml(tpl.name)+'">'+escapeHtml(tpl.name)+'</div>'+
            '<div class="tpl-confirmed-info">'+(tpl.remoteLoading?'Sincronizando imagen…':Math.round(tpl.w)+'×'+Math.round(tpl.h)+' px • ('+Math.round(tpl.x)+', '+Math.round(tpl.y)+')')+'</div>'+
          '</div>'+
          '<button class="tpl-more-btn" data-act="more" title="Más opciones" aria-label="Más opciones">⋮</button>'+
          '<div class="tpl-item-actions">'+
            '<button class="tpl-icon-btn '+(tpl.visible?'active':'')+'" data-act="vis" title="Mostrar/Ocultar">'+(tpl.visible?eyeOpen():eyeClosed())+'</button>'+
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
      div.querySelector('[data-act="stamp"]').addEventListener('click',()=>{
        stampTemplate(tpl);
      });
    }
    const main=div.querySelector('.tpl-item-main');
    if(main)main.addEventListener('click',e=>{
      if(e.target.closest('button'))return;
      if(tpl.confirmed)selectTemplateForPainting(tpl);
      else openTemplateAdjustment(tpl);
    });
    const moreBtn=div.querySelector('[data-act="more"]');
    if(moreBtn)moreBtn.addEventListener('click',e=>{
      e.stopPropagation();
      div.classList.toggle('details-open');
    });
    div.querySelector('.tpl-item-thumb-slot').appendChild(thumbImg);
    div.querySelector('[data-act="vis"]').addEventListener('click',e=>{
      e.stopPropagation();
      tpl.visible=!tpl.visible;
      renderTemplateList();
      markDirty();
      saveTemplatesToIDB();
    });
    div.querySelector('[data-act="del"]').addEventListener('click',e=>{
      e.stopPropagation();
      deleteTemplate(tpl.id);
    });
    const opIn=div.querySelector('.tpl-opacity-inp'),opVal=div.querySelector('.tpl-opacity-val');
    if (opIn && opVal) {
      opIn.addEventListener('input',e=>{
        tpl.opacity=parseFloat(e.target.value);
        opVal.textContent=Math.round(tpl.opacity*100)+'%';
        markDirty();
      });
      opIn.addEventListener('change',()=>{
        scheduleTemplateSave();
        sendTemplateUpdate(tpl);
      });
    }
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
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

/* =====================================================================
   INIT
   ===================================================================== */
window.addEventListener('DOMContentLoaded', async () => {
  resize();
  new ResizeObserver(()=>{resize();if(ghostCanvas.width!==mainCanvas.width){ghostCanvas.width=mainCanvas.width;ghostCanvas.height=mainCanvas.height;}}).observe(wrap);

  /* === Template library and contextual actions === */
  const tplPanel = $('tpl-panel');
  $('btn-tpl-x').addEventListener('click', () => {
    playCloseSound();
    closeTemplateLibrary();
  });
  $('btn-tpl-open').addEventListener('click', () => {
    if (tplPanel.classList.contains('hidden')) openTemplateLibrary();
    else closeTemplateLibrary();
  });
  const tplContextBack = $('tpl-context-back');
  if (tplContextBack) tplContextBack.addEventListener('click', () => exitTemplatePainting(true));
  const tplContextFilter = $('tpl-context-filter');
  if (tplContextFilter) tplContextFilter.addEventListener('click', () => toggleTemplateFilter(getActivePaintingTemplate()));
  const tplContextLock = $('tpl-context-lock');
  if (tplContextLock) tplContextLock.addEventListener('click', () => setCanvasLocked(!canvasLocked));
  updateTemplateLibraryCount();
  updateCanvasLockUI();

  /* === Canvas mouse events (override with template handling) === */
  mainCanvas.addEventListener('mousedown', e => {
    e.preventDefault();
    const rect=getCanvasRect(true),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
    if(e.button===1||e.button===2){onMouseDown(e);return;}
    if(e.button===0){
      const hit=hitTestHandles(sx,sy);
      if(hit){resizeTpl=hit.tpl;resizeHandle=hit.handle;resizeStart={sx,sy,x:hit.tpl.x,y:hit.tpl.y,w:hit.tpl.w,h:hit.tpl.h};return;}
      for(let i=templates.length-1;i>=0;i--){const tpl=templates[i];if(tpl.confirmed||!tpl.visible)continue;if(x>=tpl.x&&x<tpl.x+tpl.w&&y>=tpl.y&&y<tpl.y+tpl.h){tplDragId=tpl.id;tplDragOX=x-tpl.x;tplDragOY=y-tpl.y;return;}}
    }
    onMouseDown(e);
  });

  mainCanvas.addEventListener('mousemove', e => {
    const rect=getCanvasRect(),sx=e.clientX-rect.left,sy=e.clientY-rect.top,{x,y}=s2c(sx,sy);
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
    playSelectSound();
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
    playCloseSound();
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
      playSelectSound();
      setTool('brush');
      showToast('Pincel activo: Haz clic o arrastra para pintar', 'success');
    });
  }

  /* === Top Template Adjustment Card Event Listeners === */
  const tacBtnConfirm = $('tac-btn-confirm');
  if (tacBtnConfirm) {
    tacBtnConfirm.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeAdjustingTpl) {
        confirmTemplate(activeAdjustingTpl);
      }
    });
  }

  const tacBtnCancel = $('tac-btn-cancel');
  if (tacBtnCancel) {
    tacBtnCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeAdjustingTpl) {
        const tplToDel = activeAdjustingTpl;
        closeTemplateAdjustment();
        deleteTemplate(tplToDel.id);
        showToast('Plantilla cancelada', '');
      }
    });
  }

  const tacOpacityIn = $('tac-opacity-slider');
  const tacOpacityVal = $('tac-opacity-val');
  if (tacOpacityIn) {
    tacOpacityIn.addEventListener('input', (e) => {
      if (activeAdjustingTpl) {
        activeAdjustingTpl.opacity = parseFloat(e.target.value);
        if (tacOpacityVal) tacOpacityVal.textContent = Math.round(activeAdjustingTpl.opacity * 100) + '%';
        markDirty();
      }
    });
    tacOpacityIn.addEventListener('change', () => {
      if (activeAdjustingTpl) {
        scheduleTemplateSave();
        sendTemplateUpdate(activeAdjustingTpl);
      }
    });
  }

  const tacBtnCenter = $('tac-btn-center');
  if (tacBtnCenter) {
    tacBtnCenter.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeAdjustingTpl) {
        const viewW = mainCanvas.width / vz;
        const viewH = mainCanvas.height / vz;
        activeAdjustingTpl.x = Math.round(clamp(vx + (viewW - activeAdjustingTpl.w) / 2, 0, CS - activeAdjustingTpl.w));
        activeAdjustingTpl.y = Math.round(clamp(vy + (viewH - activeAdjustingTpl.h) / 2, 0, CS - activeAdjustingTpl.h));
        updateAdjustCardDimensions(activeAdjustingTpl);
        markDirty();
        if (!activeAdjustingTpl.draft) sendTemplateUpdate(activeAdjustingTpl);
        showToast('Plantilla centrada', '');
      }
    });
  }

  const tacBtnFit = $('tac-btn-fit');
  if (tacBtnFit) {
    tacBtnFit.addEventListener('click', (e) => {
      e.stopPropagation();
      if (activeAdjustingTpl) {
        const viewW = mainCanvas.width / vz;
        const viewH = mainCanvas.height / vz;
        const maxInitialDim = Math.min(800, Math.round(Math.min(viewW, viewH) * 0.75));
        const aspect = activeAdjustingTpl.w / activeAdjustingTpl.h;
        if (aspect >= 1) {
          activeAdjustingTpl.w = maxInitialDim;
          activeAdjustingTpl.h = Math.max(10, Math.round(maxInitialDim / aspect));
        } else {
          activeAdjustingTpl.h = maxInitialDim;
          activeAdjustingTpl.w = Math.max(10, Math.round(maxInitialDim * aspect));
        }
        activeAdjustingTpl.x = Math.round(clamp(vx + (viewW - activeAdjustingTpl.w) / 2, 0, CS - activeAdjustingTpl.w));
        activeAdjustingTpl.y = Math.round(clamp(vy + (viewH - activeAdjustingTpl.h) / 2, 0, CS - activeAdjustingTpl.h));
        updateAdjustCardDimensions(activeAdjustingTpl);
        markDirty();
        if (!activeAdjustingTpl.draft) sendTemplateUpdate(activeAdjustingTpl);
        showToast('Tamaño ajustado', '');
      }
    });
  }

  $('btn-fit').addEventListener('click',fitCanvas);
  $('btn-clear').addEventListener('click', async () => {
    if (!confirm('¿Limpiar todo el canvas? Esta acción borrará el lienzo para todos.')) return;
    setOffscreenPaletteColor(0);
    offCtx.fillRect(0, 0, CS, CS);
    if (canvasData) canvasData.fill(0);
    idbSave(canvasData);
    markDirty();
    showToast('Canvas limpiado', '');

    // 1. Broadcast real-time event to all connected users
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendRealtime({
        topic: 'realtime:bplace',
        event: 'broadcast',
        payload: { type: 'broadcast', event: 'clear', payload: {} },
        ref: String(sbMsgRef++)
      });
    }

    // 2. Notify local server if running
    fetch('/api/canvas/clear', { method: 'POST' }).catch(() => {});

    // 3. Immediately persist cleared blank canvas to Supabase Storage CDN
    await uploadCanvasToCloudStorage();
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
  $('tpl-file').addEventListener('change',e=>{const file=e.target.files&&e.target.files[0];if(file)loadTemplateFile(file);e.target.value='';});
  document.querySelectorAll('.scale-btn').forEach(b=>{b.addEventListener('click',()=>{document.querySelectorAll('.scale-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');exportScale=parseInt(b.dataset.scale);$('export-info').textContent='Tamano: '+(CS*exportScale)+'x'+(CS*exportScale)+' px';});});
  $('btn-export-ok').addEventListener('click',()=>{$('export-dialog').classList.add('hidden');doExport();});
  $('btn-export-cancel').addEventListener('click',()=>{$('export-dialog').classList.add('hidden');playCloseSound();});
  $('btn-export-x').addEventListener('click',()=>{$('export-dialog').classList.add('hidden');playCloseSound();});
  $('export-dialog').addEventListener('click',e=>{if(e.target===$('export-dialog')){$('export-dialog').classList.add('hidden');playCloseSound();}});
  $('btn-goto-ok').addEventListener('click',()=>{const x=clamp(parseInt($('goto-x').value)||0,0,CS-1),y=clamp(parseInt($('goto-y').value)||0,0,CS-1);goTo(x,y);$('goto-dialog').classList.add('hidden');});
  $('btn-goto-cancel').addEventListener('click',()=>{$('goto-dialog').classList.add('hidden');playCloseSound();});
  $('btn-goto-x').addEventListener('click',()=>{$('goto-dialog').classList.add('hidden');playCloseSound();});
  $('goto-dialog').addEventListener('click',e=>{if(e.target===$('goto-dialog')){$('goto-dialog').classList.add('hidden');playCloseSound();}});

  /* === Load canvas data (Ultra-Fast Startup) === */
  try {
    setProgress(15); setLoadTxt('Iniciando lienzo...');
    initOffscreen();
    
    // Fast path: Fetch latest binary state from server directly
    setProgress(40); setLoadTxt('Descargando lienzo...');
    const cached = await Promise.race([
      openIDB().then(() => idbLoad()).catch(() => null),
      new Promise(resolve => setTimeout(() => resolve(null), 800))
    ]);
    const hasCache = cached && cached.length === CS * CS;
    if (hasCache) buildCanvasFromData(cached);
    const loadedFromServer = hasCache || await loadCanvasFromServer();
    if (hasCache) loadCanvasFromServer().catch(console.warn);
    
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
        throw new Error('No se pudo descargar el lienzo y no hay respaldo local');
      }
    }
    setProgress(100);
  } catch (err) {
    console.error('Error durante la carga:', err);
    setLoadTxt('No se pudo cargar el lienzo. Revisa tu conexión.');
    const retry = document.createElement('button');
    retry.textContent = 'Reintentar';
    retry.className = 'tb-btn';
    retry.style.cssText = 'margin:16px auto;background:#8478ff;color:white';
    retry.onclick = () => location.reload();
    $('ld-txt').after(retry);
    return;
  } finally {
    if (canvasData) hideLoading();
  }
  setInterval(() => {
    if (canvasData && canvasPersistenceDirty) {
      canvasPersistenceDirty = false;
      idbSave(canvasData);
    }
  }, 60000);

  loadPrefs();buildPalette();renderRecentColors();renderFavColors();
  setCurrentColor(currentColorHex,false);setBgColor(bgColorHex);
  setTool('brush');setBrushSize(1);setShapeFilled(true);
  $('canvas-size-display').textContent=CS+' x '+CS;
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (!isTouchDevice) {
    activatePaintMode('brush');
  } else {
    deactivatePaintMode();
  }

  fitCanvas();
  wsConnect();
  setTimeout(() => { isStartupComplete = true; }, 100);

  // Load shared templates from Supabase Cloud
  loadTemplatesFromCloud().then(ok => {
    if (!ok) return restoreTemplatesFromIDB();
  });

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
    btnLock.addEventListener('click', () => setCanvasLocked(!canvasLocked));
  }

  /* === Touch events for canvas === */
  let touchState = null, lastPinchDist = 0;

  const handleTouchStart = (e) => {
    if (e.target.closest('#topbar') || e.target.closest('#canvas-actions') || e.target.closest('#tpl-context-toolbar') || e.target.closest('#wplace-dock') || e.target.closest('#btn-pintar') || e.target.closest('.floating-panel') || e.target.closest('.dialog-bg') || e.target.closest('#tpl-adjust-card')) {
      return;
    }
    e.preventDefault();
    const rect = getCanvasRect(true);
    cachedCanvasRect = rect;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      const sx = t.clientX - rect.left, sy = t.clientY - rect.top;
      const {x, y} = s2c(sx, sy);
      
      // 1. Check template resize handles on mobile
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
      
      // 2. Check template body drag on mobile
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
      
      // 3. If NOT in paint mode, single touch always pans
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
    if (e.target.closest('#topbar') || e.target.closest('#canvas-actions') || e.target.closest('#tpl-context-toolbar') || e.target.closest('#wplace-dock') || e.target.closest('#btn-pintar') || e.target.closest('.floating-panel') || e.target.closest('.dialog-bg') || e.target.closest('#tpl-adjust-card')) {
      return;
    }
    e.preventDefault();
    const rect = touchState.rect || getCanvasRect();
    
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
      constrainViewport();
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
      constrainViewport();
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
    const rect = getCanvasRect();
    
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
            paintPixelMain(x, y);
          } else if (tool === 'erase') {
            paintBrush(x, y, 0);
            markDirty();
            playPixelSound();
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
