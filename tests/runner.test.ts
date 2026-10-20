import { afterEach, expect, test, vi } from 'vitest';
import { openStore, type Store } from '../src/server/store.js';
import { createRunner } from '../src/server/runner.js';
import { createGate } from '../src/server/gate.js';
import { ExecutionError, type Adapter } from '../src/server/adapter.js';
import type { Result } from '../src/shared/contracts.js';
const result:Result={text:'完成',scope:'文字',evidence:[],unfinished:[],externalSessionId:null};
const available={state:'available' as const,reason:null,verifiedAt:'now',remainingQuota:null};
let store:Store;
let runner:ReturnType<typeof createRunner>;
afterEach(async()=>{ if (runner) await runner.stop(); store?.close(); vi.useRealTimers(); });
function setup(adapter:Adapter,text='hi') { store=openStore(':memory:'); const c=store.createConversation(); const t=store.submit({conversationId:c.id,clientId:'1',text}); runner=createRunner(store,adapter); return {c,t}; }
const settled=()=>new Promise(r=>setTimeout(r,10));
test('serializes tasks and persists output',async()=>{
 let active=0,peak=0;
 const {c,t}=setup({status:async()=>available,run:async(_t,_s,ctl)=>{ctl.beforeRequest(); active++; peak=Math.max(peak,active); await settled(); active--; return result;}});
 const b=store.submit({conversationId:c.id,clientId:'2',text:'next'}); runner.wake();
 await vi.waitFor(()=>expect(store.getTask(b.id)?.status).toBe('completed')); expect(peak).toBe(1); expect(store.result(t.id)?.text).toBe('完成');
});
test('gates fourth request and deadline at exactly 120 seconds',()=>{
 let now=0; const gate=createGate({maxInputChars:20000,maxRequests:3,timeoutMs:120000},()=>now);
 gate.beforeRequest(); gate.beforeRequest(); gate.beforeRequest(); expect(()=>gate.beforeRequest()).toThrow('request_limit');
 const timed=createGate({maxInputChars:20000,maxRequests:3,timeoutMs:120000},()=>now); now=120000; expect(()=>timed.beforeRequest()).toThrow('timeout');
});
test.each(['auth_required','quota','request_limit'] as const)('pauses on %s without retry',async(code)=>{
 let attempts=0; const {t}=setup({status:async()=>available,run:async()=>{attempts++; throw new ExecutionError(code);}}); runner.wake();
 await vi.waitFor(()=>expect(store.getTask(t.id)?.status).toBe('paused')); expect(store.getTask(t.id)?.reason).toBe(code); expect(attempts).toBe(1);
});
test('saves then pauses without invoking unverified connection',async()=>{
 let calls=0; const {t}=setup({status:async()=>({...available,state:'unverified'}),run:async()=>{calls++;return result;}}); runner.wake();
 await vi.waitFor(()=>expect(store.getTask(t.id)?.status).toBe('paused')); expect(calls).toBe(0);
});
test('blocks oversized text before adapter call',async()=>{
 let calls=0;const {t}=setup({status:async()=>available,run:async()=>{calls++;return result;}},'a'.repeat(20001));runner.wake();
 await vi.waitFor(()=>expect(store.getTask(t.id)?.reason).toBe('input_limit'));expect(calls).toBe(0);
});
test('unknown execution failures are sanitized and failed',async()=>{
 const {t}=setup({status:async()=>available,run:async()=>{throw new Error('SECRET_PROVIDER_TOKEN');}});runner.wake();
 await vi.waitFor(()=>expect(store.getTask(t.id)?.status).toBe('failed'));expect(store.getTask(t.id)?.reason).toBe('execution_failed');
 expect(JSON.stringify(store.events(t.conversationId,0))).not.toContain('SECRET_PROVIDER_TOKEN');
});
test('cancels queued without starting it',async()=>{
 let calls=0; const {t}=setup({status:async()=>available,run:async()=>{calls++;return result;}});await runner.cancel(t.id);runner.wake();await settled();expect(store.getTask(t.id)?.status).toBe('cancelled');expect(calls).toBe(0);
});
test('cancel waits for adapter shutdown, discards late result and retains slot',async()=>{
 let finish!:(r:Result)=>void;let calls=0;let signal:AbortSignal|undefined;
 const {t,c}=setup({status:async()=>available,run:async(_t,_s,ctl)=>{calls++;signal=ctl.signal; return new Promise(resolve=>{finish=resolve;});}});
 runner.wake();await vi.waitFor(()=>expect(calls).toBe(1));const cancellation=runner.cancel(t.id);
 const b=store.submit({conversationId:c.id,clientId:'2',text:'later'});runner.wake();await settled();expect(signal?.aborted).toBe(true);expect(calls).toBe(1);expect(store.getTask(b.id)?.status).toBe('queued');
 // Cancel the other queued task so this test's intentionally uncooperative adapter cannot block teardown.
 await runner.cancel(b.id);finish(result);await cancellation;expect(store.getTask(t.id)?.status).toBe('cancelled');expect(store.result(t.id)).toBeNull();
});
test('deadline aborts running work and pauses',async()=>{
 vi.useFakeTimers();const {t}=setup({status:async()=>available,run:async(_t,_s,ctl)=>new Promise((_resolve,reject)=>ctl.signal.addEventListener('abort',()=>reject(new ExecutionError('timeout'))))});runner.wake();await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(120000);expect(store.getTask(t.id)?.reason).toBe('timeout');
});
test('recording failure stops new calls and reports degraded health',async()=>{
 let calls=0;const {t}=setup({status:async()=>available,run:async(_t,_s,ctl)=>{calls++;ctl.emit('visible.progress',{text:'hello'});return result;}});
 vi.spyOn(store,'append').mockImplementation(()=>{throw new Error('disk');});runner.wake();await vi.waitFor(()=>expect(runner.health()).toBe('recording_failed'));expect(calls).toBe(0);expect(store.getTask(t.id)?.status).toBe('queued');
});
