const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
test('snapshot refresh merges pixels changed while download is pending',async()=>{
 const source=fs.readFileSync('public/app.js','utf8');
 const body=source.slice(source.indexOf('async function fetchCanvasSnapshot()'),source.indexOf('async function persistCanvasSnapshot()'));
 let complete;
 const context={canvasData:Uint8Array.from([0,0,0]),SUPABASE_CONFIG:{cdnCanvas:'test'},downloadCanvasSnapshot:()=>new Promise(r=>complete=r),idbSave(){},markDirty(){},console};
 context.buildCanvasFromData=data=>{context.canvasData=data};
 vm.createContext(context);vm.runInContext(body,context);
 const pending=context.fetchCanvasSnapshot();context.canvasData[1]=8;
 complete(Uint8Array.from([5,0,9]));await pending;
 assert.deepEqual([...context.canvasData],[5,8,9]);
});
