'use strict';

// Serialize snapshots, retain changes made during an upload, and retry failures.
function createCanvasAutosave({ upload, onStatus = () => {}, delay = 1000, retryDelay = 5000 }) {
  let revision = 0, savedRevision = 0, timer = null, inFlight = null;
  const pending = () => revision !== savedRevision;
  function schedule(ms) {
    if (timer !== null || inFlight) return;
    timer = setTimeout(() => { timer = null; flush(); }, ms);
  }
  function mark() {
    revision++;
    onStatus('pending');
    schedule(delay);
  }
  function flush(options = {}) {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (inFlight) return inFlight;
    if (!pending()) return Promise.resolve(true);
    const uploadingRevision = revision;
    onStatus('saving');
    inFlight = Promise.resolve().then(() => upload(options)).then(ok => {
      if (ok) savedRevision = uploadingRevision;
      onStatus(ok ? (pending() ? 'pending' : 'saved') : 'error');
      return !!ok;
    }).catch(() => { onStatus('error'); return false; }).then(ok => {
      inFlight = null;
      if (pending()) schedule(ok ? delay : retryDelay);
      return ok;
    });
    return inFlight;
  }
  return { mark, flush, pending };
}

if (typeof module !== 'undefined') module.exports = { createCanvasAutosave };

