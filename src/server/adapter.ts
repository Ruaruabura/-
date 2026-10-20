import type { ConnectionStatus, Task, Result, Message } from '../shared/contracts.js';
export type ErrorCode = 'auth_required' | 'unverified' | 'quota' | 'input_limit' | 'request_limit' | 'timeout' | 'cancelled' | 'interrupted' | 'execution_failed' | 'recording_failed';
export class ExecutionError extends Error { constructor(public readonly code: ErrorCode) { super(code); } }
export type Controls = { history?: Message[]; signal: AbortSignal; beforeRequest: () => void; emit: (type: string, payload: Record<string, unknown>) => void };
export interface Adapter { status(): Promise<ConnectionStatus>; run(task: Task, text: string, controls: Controls): Promise<Result>; }
