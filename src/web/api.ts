import type {
  Conversation,
  Message,
  Task,
  Event,
  ConnectionStatus,
  Result,
} from '../shared/contracts.js';
export type TaskView = Task & { result?: Result | null };
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('连接中断，内容已保留。请重试。');
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? '请求失败，请稍后重试。');
  return data as T;
}
const post = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
export const api = {
  conversations: (signal?: AbortSignal) => request<Conversation[]>('/conversations', { signal }),
  create: () => post<Conversation>('/conversations', {}),
  connection: (signal?: AbortSignal) => request<ConnectionStatus>('/connection', { signal }),
  messages: (id: string, signal?: AbortSignal) =>
    request<Message[]>(`/conversations/${id}/messages`, { signal }),
  tasks: (id: string, signal?: AbortSignal) =>
    request<TaskView[]>(`/conversations/${id}/tasks`, { signal }),
  events: (id: string, after: number, signal?: AbortSignal) =>
    request<Event[]>(`/conversations/${id}/events?after=${after}`, { signal }),
  send: (
    id: string,
    clientId: string,
    text: string,
    materialIds: string[] = [],
    transcriptId?: string,
  ) => post<Task>(`/conversations/${id}/messages`, { clientId, text, materialIds, transcriptId }),
  cancel: (id: string) => post<Task>(`/tasks/${id}/cancel`, {}),
  resume: (id: string) => post<Task>(`/tasks/${id}/resume`, {}),
};
