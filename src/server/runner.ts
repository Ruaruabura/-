import { isStoreConflict, type Store } from './store.js';
import type { Task } from '../shared/contracts.js';
import { ExecutionError, type Adapter, type ErrorCode } from './adapter.js';
import { createGate } from './gate.js';
export function createRunner(store: Store, adapter: Adapter) {
  let stopped = false,
    fatal: string | null = null,
    pumping: Promise<void> | null = null;
  let active: {
    id: string;
    controller: AbortController;
    reason: ErrorCode | null;
    done: Promise<void>;
  } | null = null;
  function recordingFailed() {
    fatal = 'recording_failed';
    active?.controller.abort();
  }
  function persist<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (isStoreConflict(error)) throw error;
      recordingFailed();
      throw new ExecutionError('recording_failed');
    }
  }
  async function execute(task: Task) {
    let settled!: () => void;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const current = {
      id: task.id,
      controller: new AbortController(),
      reason: null as ErrorCode | null,
      done,
    };
    active = current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      persist(() => store.transition(task.id, ['queued'], 'running'));
      const gate = createGate(task.limits);
      timer = setTimeout(() => {
        current.reason ??= 'timeout';
        current.controller.abort();
      }, task.limits.timeoutMs);
      const connection = await adapter.status();
      if (current.controller.signal.aborted)
        throw new ExecutionError(current.reason ?? 'interrupted');
      if (connection.state !== 'available')
        throw new ExecutionError(
          connection.state === 'unverified' ? 'unverified' : 'auth_required',
        );
      const text = persist(() => store.sourceText(task));
      if (text.length > task.limits.maxInputChars) throw new ExecutionError('input_limit');
      const result = await adapter.run(task, text, {
        signal: current.controller.signal,
        history: persist(() => {
          const turns = store.tasks(task.conversationId);
          const earlier = turns.slice(
            0,
            turns.findIndex((turn) => turn.id === task.id),
          );
          const messages = store.messages(task.conversationId);
          return earlier.flatMap((turn) =>
            messages.filter((message) => message.taskId === turn.id),
          );
        }),
        beforeRequest() {
          if (current.controller.signal.aborted || fatal)
            throw new ExecutionError(current.reason ?? 'recording_failed');
          gate.beforeRequest();
        },
        emit(type, payload) {
          if (current.controller.signal.aborted) return;
          // Adapters emit only visible, normalized events; raw SDK errors and reasoning are never persisted.
          if (!['visible.progress', 'tool.read', 'model.request', 'model.usage'].includes(type))
            return;
          persist(() => store.append(task.id, type, payload));
        },
      });
      if (fatal) return;
      if (current.reason) throw new ExecutionError(current.reason);
      persist(() => store.complete(task.id, result));
    } catch (error) {
      if (fatal) return;
      const code =
        current.reason ?? (error instanceof ExecutionError ? error.code : 'execution_failed');
      const status =
        code === 'cancelled' ? 'cancelled' : code === 'execution_failed' ? 'failed' : 'paused';
      persist(() => store.transition(task.id, ['running'], status, code));
    } finally {
      clearTimeout(timer);
      active = null;
      settled();
    }
  }
  async function pump() {
    while (!stopped && !fatal) {
      const task = persist(() => store.queued())[0];
      if (!task) break;
      await execute(task);
    }
  }
  const runner = {
    wake() {
      if (stopped || fatal || pumping) return;
      pumping = pump()
        .catch(() => {
          recordingFailed();
        })
        .finally(() => {
          pumping = null;
          if (!stopped && !fatal) {
            try {
              if (persist(() => store.queued()).length) runner.wake();
            } catch {
              /* Fatal state is already latched. */
            }
          }
        });
    },
    async cancel(id: string) {
      const task = persist(() => store.getTask(id));
      if (!task) throw new Error('not_found');
      if (task.status === 'queued' || task.status === 'paused') {
        persist(() => store.transition(id, [task.status], 'cancelled'));
        return;
      }
      if (task.status === 'cancelled') return;
      if (task.status !== 'running' || active?.id !== id) throw new Error('invalid_transition');
      if (active.reason !== 'cancelled') {
        persist(() => store.append(id, 'task.cancel_requested', {}));
        active.reason = 'cancelled';
        active.controller.abort();
      }
      // Do not wait on the entire queue, only this running task's settlement.
      await active.done;
    },
    resume(id: string) {
      if (fatal) throw new Error('recording_failed');
      persist(() => store.transition(id, ['paused'], 'queued'));
      runner.wake();
    },
    recordingFailed,
    health() {
      return fatal;
    },
    async stop() {
      stopped = true;
      if (active) {
        active.reason ??= 'interrupted';
        active.controller.abort();
      }
      await pumping;
    },
  };
  return runner;
}
export type Runner = ReturnType<typeof createRunner>;
