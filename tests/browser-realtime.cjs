const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
 const browser = await chromium.launch({channel:'chrome',headless:true});
 const topic = 'realtime:bplace-test-' + Date.now();
 const source = fs.readFileSync('public/app.js','utf8').replaceAll('realtime:bplace', topic);
 try {
  const context = await browser.newContext();
  await context.route('**/app.js?*', r=>r.fulfill({contentType:'application/javascript',body:source}));
  await context.route('https://*.supabase.co/**', r=>r.fulfill({status:200,body:'[]'}));
  await context.route('**/api/canvas/compact', r=>r.fulfill({body:Buffer.alloc(9000000)}));
  await context.route('**/api/canvas/compressed', r=>r.fulfill({status:200,body:'OK'}));
  const a=await context.newPage(), b=await context.newPage();
  await Promise.all([a.goto('http://localhost:3002'),b.goto('http://localhost:3002')]);
  await Promise.all([a.waitForFunction(()=>wsReady),b.waitForFunction(()=>wsReady)]);
  const start=Date.now();
  await a.evaluate(()=>{setPixelPalette(10,10,5);queueWSPixel(10,10,5)});
  await b.waitForFunction(()=>canvasData[10*CS+10]===5,{},{timeout:5000});
  console.log('PASS: real isolated Realtime pixel delivery '+(Date.now()-start)+'ms');
  await a.evaluate(()=>ws.close());
  await a.waitForFunction(()=>!wsReady);
  await a.evaluate(()=>{setPixelPalette(11,10,8);queueWSPixel(11,10,8)});
  await b.waitForFunction(()=>canvasData[10*CS+11]===8,{},{timeout:10000});
  console.log('PASS: pixel painted offline delivered after reconnect');
  await b.evaluate(()=>{setPixelPalette(12,10,9);queueWSPixel(12,10,9)});
  await a.waitForFunction(()=>canvasData[10*CS+12]===9,{},{timeout:5000});
  console.log('PASS: bidirectional updates');
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
