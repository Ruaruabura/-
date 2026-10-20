import { createServer as nodeServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import type { Store } from './store.js';
import type { Runner } from './runner.js';
import type { Adapter } from './adapter.js';
type Middleware=(req:IncomingMessage,res:ServerResponse,next:()=>void)=>void;
class HttpError extends Error {constructor(public status:number,public code:string){super(code);}}
const messages:Record<string,string>={not_found:'未找到记录',invalid_input:'输入格式不正确',idempotency_conflict:'该发送编号已用于另一条消息',invalid_transition:'任务当前状态不支持此操作',recording_failed:'记录保存失败，执行已停止。请检查磁盘并重启服务。',forbidden:'仅允许本地同源访问',too_large:'请求过大',json_required:'请使用 JSON 请求'};
function json(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
 if(!req.headers['content-type']?.startsWith('application/json'))throw new HttpError(415,'json_required');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>131072)throw new HttpError(413,'too_large');chunks.push(chunk);}
 try{const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value as Record<string,unknown>;}catch{throw new HttpError(400,'invalid_input');}
}
export function createServer(store:Store,runner:Runner,adapter:Adapter,options:{staticDir?:string;middleware?:Middleware}={}){
 const server=nodeServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  try{
   const address=server.address();const port=typeof address==='object'&&address?address.port:0;
   const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
   if(!req.headers.host||!hosts.has(req.headers.host)||req.headers['sec-fetch-site']==='cross-site')throw new HttpError(403,'forbidden');
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)throw new HttpError(403,'forbidden');
   const url=new URL(req.url??'/','http://localhost');const path=url.pathname;const method=req.method??'GET';
   if(path.startsWith('/api/')){
    if(runner.health())throw new HttpError(503,'recording_failed');
    if(method==='GET'&&path==='/api/health')return json(res,200,{ok:true});
    if(method==='GET'&&path==='/api/connection')return json(res,200,await adapter.status());
    if(path==='/api/conversations'){
     if(method==='GET')return json(res,200,store.conversations());
     if(method==='POST'){await body(req);return json(res,201,store.createConversation());}
    }
    const conversation=path.match(/^\/api\/conversations\/([\w-]+)\/(messages|events|tasks)$/);
    if(conversation){
     const [,id,kind]=conversation;if(!store.hasConversation(id))throw new HttpError(404,'not_found');
     if(method==='GET'){
      if(kind==='messages')return json(res,200,store.messages(id));
      if(kind==='tasks')return json(res,200,store.tasks(id).map(task=>({...task,result:store.result(task.id)})));
      const after=Number(url.searchParams.get('after')??'0');if(!Number.isSafeInteger(after)||after<0)throw new HttpError(400,'invalid_input');
      return json(res,200,store.events(id,after));
     }
     if(method==='POST'&&kind==='messages'){
      const data=await body(req);if(typeof data.clientId!=='string'||!/^[\w-]{1,100}$/.test(data.clientId)||typeof data.text!=='string'||!data.text.trim())throw new HttpError(400,'invalid_input');
      const task=store.submit({conversationId:id,clientId:data.clientId,text:data.text});runner.wake();return json(res,201,task);
     }
    }
    const taskRoute=path.match(/^\/api\/tasks\/([\w-]+)(?:\/(cancel|resume))?$/);
    if(taskRoute){
     const [,id,action]=taskRoute,task=store.getTask(id);if(!task)throw new HttpError(404,'not_found');
     if(method==='GET'&&!action)return json(res,200,{...task,result:store.result(id)});
     if(method==='POST'&&action){
      await body(req);
      if(action==='cancel'){
       if(!['queued','paused','running','cancelled'].includes(task.status))throw new HttpError(409,'invalid_transition');
       // Cancellation is asynchronous; the slot is retained until the adapter settles.
       void runner.cancel(id).catch(()=>{});
      }else runner.resume(id);
      if(runner.health())throw new HttpError(503,'recording_failed');
      return json(res,202,store.getTask(id));
     }
    }
    throw new HttpError(404,'not_found');
   }
   if(method!=='GET'&&method!=='HEAD')throw new HttpError(404,'not_found');
   if(options.middleware){options.middleware(req,res,()=>{if(!res.writableEnded)json(res,404,{error:{code:'not_found',message:'未找到页面'}});});return;}
   const root=resolve(options.staticDir??'dist'),requested=path==='/'?'index.html':decodeURIComponent(path).replace(/^\//,'');
   const file=resolve(root,requested);if(!file.startsWith(root+sep))throw new HttpError(403,'forbidden');
   const data=await readFile(file).catch(()=>{throw new HttpError(404,'not_found');});
   const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ico':'image/x-icon'};
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
   res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream'});res.end(method==='HEAD'?undefined:data);
  }catch(error){
   if(res.writableEnded||res.destroyed)return;
   const known=error instanceof Error?error.message:'';
   const status=error instanceof HttpError?error.status:known==='not_found'?404:['invalid_transition','idempotency_conflict'].includes(known)?409:503;
   const code=error instanceof HttpError?error.code:status===503?'recording_failed':known;
   json(res,status,{error:{code,message:messages[code]??'请求无法完成'}});
  }
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 return server;
}
