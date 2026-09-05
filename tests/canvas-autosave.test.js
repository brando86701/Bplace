const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCanvasAutosave } = require('../public/canvas-autosave');

test('groups drawing changes and persists without a realtime connection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploads = 0;
  const save = createCanvasAutosave({ upload: async () => { uploads++; return true; } });
  save.mark(); save.mark(); save.mark();
  assert.equal(uploads, 0);
  t.mock.timers.tick(1000);
  await save.flush();
  assert.equal(uploads, 1);
  assert.equal(save.pending(), false);
});

test('does not lose changes drawn during an upload or run concurrent uploads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete, uploads = 0;
  const save = createCanvasAutosave({ upload: () => { uploads++; return new Promise(resolve => { complete = resolve; }); } });
  save.mark();
  const first = save.flush();
  await Promise.resolve();
  save.mark();
  assert.equal(save.flush(), first);
  complete(true); await first;
  assert.equal(save.pending(), true);
  const second = save.flush();
  await Promise.resolve();
  complete(true); await second;
  assert.equal(uploads, 2);
  assert.equal(save.pending(), false);
});

test('HTTP failure and network exceptions remain pending and automatically retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploads = 0;
  const statuses = [];
  const save = createCanvasAutosave({
    upload: async () => { uploads++; if (uploads === 1) return false; if (uploads === 2) throw new Error('offline'); return true; },
    onStatus: status => statuses.push(status)
  });
  save.mark();
  assert.equal(await save.flush(), false);
  assert.equal(save.pending(), true);
  t.mock.timers.tick(5000);
  assert.equal(await save.flush(), false);
  assert.equal(save.pending(), true);
  t.mock.timers.tick(5000);
  assert.equal(await save.flush(), true);
  assert.equal(save.pending(), false);
  assert.equal(uploads, 3);
  assert.equal(statuses.filter(s => s === 'error').length, 2);
});
