// Deterministic adapter exists only in test code. Production never registers it.
import { openStore } from '../../src/server/store.js';
import { createRunner } from '../../src/server/runner.js';
import { createServer } from '../../src/server/http.js';
import type { Adapter } from '../../src/server/adapter.js';
const store=openStore(':memory:');
const adapter:Adapter={
 async status(){return {state:'available',verifiedAt:'2026-10-21T00:00:00Z',reason:null,remainingQuota:null};},
 async run(_task,text,controls){
  controls.beforeRequest();controls.emit('visible.progress',{text:'正在整理本次输入'});
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,text==='长任务'?5000:300);controls.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('aborted'));},{once:true});});
  return {text:`测试适配器结果：${text}`,scope:'仅本次文字（测试替身）',evidence:[],unfinished:[],externalSessionId:null};
 },
};
const runner=createRunner(store,adapter);const server=createServer(store,runner,adapter);server.listen(4319,'127.0.0.1');
async function close(){server.close();await runner.stop();server.closeAllConnections();store.close();}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
