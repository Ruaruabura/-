import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_LIMITS, type Conversation, type Message, type Task, type TaskStatus, type Result, type Event, type SubmitInput } from '../shared/contracts.js';

const allowed: Record<TaskStatus, TaskStatus[]> = {
 queued: ['running','cancelled'], running: ['paused','failed','completed','cancelled'], paused: ['queued','cancelled'], failed: [], completed: [], cancelled: [],
};
export function openStore(path: string): Store { return new Store(path); }
export class Store {
 private db: DatabaseSync;
 private closed = false;
 constructor(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  this.db = new DatabaseSync(path);
  this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
 }
 private transaction<T>(work: () => T): T {
  this.db.exec('BEGIN IMMEDIATE');
  try { const value=work(); this.db.exec('COMMIT'); return value; }
  catch(error) { this.db.exec('ROLLBACK'); throw error; }
 }
 private task(row: unknown): Task | null {
  if (!row) return null; const r=row as Task & {limits:string}; return {...r, limits:JSON.parse(r.limits)};
 }
 createConversation(): Conversation {
  const c={id:randomUUID(),title:'新对话',createdAt:new Date().toISOString()};
  this.db.prepare('INSERT INTO conversations VALUES(?,?,?)').run(c.id,c.title,c.createdAt); return c;
 }
 conversations(): Conversation[] { return this.db.prepare('SELECT * FROM conversations ORDER BY rowid DESC').all() as unknown as Conversation[]; }
 hasConversation(id: string): boolean { return !!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(id); }
 messages(id: string): Message[] { return this.db.prepare('SELECT id,conversationId,taskId,role,text,createdAt FROM messages WHERE conversationId=? ORDER BY rowid').all(id) as unknown as Message[]; }
 submit(input: SubmitInput): Task {
  return this.transaction(() => {
   if (!this.hasConversation(input.conversationId)) throw new Error('not_found');
   const existing=this.db.prepare('SELECT taskId,text FROM messages WHERE conversationId=? AND clientId=?').get(input.conversationId,input.clientId);
   if (existing) { if (existing.text!==input.text) throw new Error('idempotency_conflict'); return this.getTask(existing.taskId as string)!; }
   const now=new Date().toISOString(), id=randomUUID(), messageId=randomUUID();
   this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(id,input.conversationId,messageId,'queued',null,JSON.stringify(DEFAULT_LIMITS),now,now);
   this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run(messageId,input.conversationId,id,'user',input.text,now,input.clientId);
   this.db.prepare("UPDATE conversations SET title=? WHERE id=? AND title='新对话'").run(input.text.trim().slice(0,32),input.conversationId);
   this.append(id,'message.sent',{ messageId }); this.append(id,'task.queued',{}); return this.getTask(id)!;
  });
 }
 getTask(id: string): Task | null { return this.task(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id)); }
 queued(): Task[] { return this.db.prepare("SELECT * FROM tasks WHERE status='queued' ORDER BY rowid").all().map(r=>this.task(r)!); }
 tasks(conversationId: string): Task[] { return this.db.prepare('SELECT * FROM tasks WHERE conversationId=? ORDER BY rowid').all(conversationId).map(r=>this.task(r)!); }
 sourceText(task: Task): string { return (this.db.prepare('SELECT text FROM messages WHERE id=?').get(task.sourceMessageId)?.text as string) ?? ''; }
 append(id: string, type: string, payload: Record<string,unknown>): void {
  const task=this.getTask(id); if (!task) throw new Error('not_found');
  this.db.prepare('INSERT INTO events(taskId,conversationId,type,payload,createdAt) VALUES(?,?,?,?,?)').run(id,task.conversationId,type,JSON.stringify(payload),new Date().toISOString());
 }
 private change(id: string, from: TaskStatus[], to: TaskStatus, reason: string | null): Task {
  const t=this.getTask(id); if (!t) throw new Error('not_found');
  if (!from.includes(t.status) || !allowed[t.status].includes(to)) throw new Error('invalid_transition');
  this.db.prepare('UPDATE tasks SET status=?,reason=?,updatedAt=? WHERE id=?').run(to,reason,new Date().toISOString(),id);
  this.append(id,`task.${to}`,reason ? {reason}:{}); return this.getTask(id)!;
 }
 transition(id: string, from: TaskStatus[], to: TaskStatus, reason?: string): Task { return this.transaction(()=>this.change(id,from,to,reason??null)); }
 complete(id: string, result: Result): void {
  this.transaction(()=>{
   const t=this.getTask(id); if (t?.status!=='running') throw new Error('invalid_transition');
   const messageId=randomUUID();
   this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,NULL)').run(messageId,t.conversationId,id,'assistant',result.text,new Date().toISOString());
   this.db.prepare('INSERT INTO results VALUES(?,?)').run(id,JSON.stringify(result));
   this.append(id,'assistant.message',{messageId}); this.change(id,['running'],'completed',null);
  });
 }
 result(id: string): Result | null { const row=this.db.prepare('SELECT data FROM results WHERE taskId=?').get(id); return row ? JSON.parse(row.data as string):null; }
 events(conversationId: string, after: number): Event[] {
  return this.db.prepare('SELECT * FROM events WHERE conversationId=? AND seq>? ORDER BY seq LIMIT 200').all(conversationId,after).map(r=>({...r,payload:JSON.parse(r.payload as string)})) as Event[];
 }
 recoverInterrupted(): number {
  return this.transaction(()=>{ const rows=this.db.prepare("SELECT id FROM tasks WHERE status='running'").all(); for (const row of rows) this.change(row.id as string,['running'],'paused','interrupted'); return rows.length; });
 }
 close(): void { if (!this.closed) { this.db.close(); this.closed=true; } }
}
