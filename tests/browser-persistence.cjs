// Run with NODE_PATH pointing to a Playwright installation. Cloud traffic is
// isolated: this test never paints on the shared production canvas.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BPLACE_BROWSER || 'chrome' });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let snapshot = Buffer.alloc(3000 * 3000), writes = 0;
    await context.routeWebSocket(/supabase/, ws => ws.close());
    await context.route('https://*.supabase.co/**', async route => {
      const request = route.request();
      if (request.url().includes('/storage/v1/object/')) {
        if (request.method() === 'POST') {
          snapshot = request.postDataBuffer(); writes++;
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        }
        return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: snapshot });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await context.route('**/api/canvas/compact', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: snapshot }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:3002');
    await page.locator('#loading').waitFor({ state: 'hidden' });
    await page.locator('#palette-grid .swatch').nth(5).click();
    await page.locator('#main-canvas').click({ position: { x: 700, y: 400 }, force: true });
    await page.waitForFunction(() => document.getElementById('canvas-save-status')?.textContent === 'Guardado');
    assert.equal(writes, 1);
    assert.equal(snapshot.length, 9000000);
    const index = snapshot.findIndex(color => color === 5);
    assert.ok(index >= 0, 'the painted pixel was uploaded');
    await page.reload();
    await page.locator('#loading').waitFor({ state: 'hidden' });
    const reloaded = await page.evaluate(index => canvasData[index], index);
    assert.equal(reloaded, 5, 'the pixel survives reload from cloud storage');
    assert.deepEqual(errors, []);
    console.log('PASS: real canvas click uploads 9 MB and survives reload, with realtime disconnected.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
