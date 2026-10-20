import type { Limits } from '../shared/contracts.js';
import { ExecutionError } from './adapter.js';
export function createGate(limits: Limits, now: () => number = Date.now): { beforeRequest(): void } {
 const start=now(); let requests=0;
 return { beforeRequest() { if (now()-start >= limits.timeoutMs) throw new ExecutionError('timeout'); if (requests >= limits.maxRequests) throw new ExecutionError('request_limit'); requests++; } };
}
