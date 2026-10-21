import { Voice } from './Voice.js';
import { uploadFile } from './uploads.js';
import { useEffect, useRef, useState } from 'react';
import type { Conversation, ConnectionStatus, Message, Event } from '../shared/contracts.js';
import { api, type TaskView } from './api.js';
import { Chat } from './Chat.js';
import { Timeline } from './Timeline.js';
import { Icon } from './Icon.js';
type Snapshot = { id: string; messages: Message[]; tasks: TaskView[]; events: Event[] };
const blank: Snapshot = { id: '', messages: [], tasks: [], events: [] };
function readLocal(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function saveLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState(''),
    [view, setView] = useState<'chat' | 'journal'>('chat');
  const [snapshot, setSnapshot] = useState<Snapshot>(blank),
    [connection, setConnection] = useState<ConnectionStatus | null>(null);
  const [draft, setDraft] = useState(''),
    [sending, setSending] = useState(false),
    [creating, setCreating] = useState(false),
    [error, setError] = useState(''),
    [pollError, setPollError] = useState(''),
    [version, setVersion] = useState(0);
  const [voiceBusy, setVoiceBusy] = useState(false),
    [transcriptId, setTranscriptId] = useState<string | undefined>();
  const [requiredFiles, setRequiredFiles] = useState<string[]>([]);
  const [files, setFiles] = useState<File[]>([]),
    [uploadProgress, setUploadProgress] = useState('');
  const [selectionRevision, setSelectionRevision] = useState('');
  const [range, setRange] = useState({ start: 1, end: 5 });
  const pending = useRef<{
      id: string;
      text: string;
      conversationId: string;
      attachmentKey?: string;
      materialKey?: string;
      materialIds?: string[];
    } | null>(null),
    input = useRef<HTMLTextAreaElement>(null),
    selectedRef = useRef('');
  function choose(id: string) {
    selectedRef.current = id;
    setSelected(id);
    saveLocal('harness:selected', id);
    setDraft(readLocal(`harness:draft:${id}`) ?? '');
    setError('');
    setFiles([]);
    try {
      setRequiredFiles(JSON.parse(readLocal(`harness:files:${id}`) ?? '[]'));
    } catch {
      setRequiredFiles([]);
    }
    setTranscriptId(readLocal(`harness:transcript:${id}`) || undefined);
    setSelectionRevision(readLocal(`harness:selection:${id}`) || '');
    try {
      const saved = JSON.parse(readLocal(`harness:range:${id}`) ?? 'null');
      setRange(
        saved && Number.isInteger(saved.start) && Number.isInteger(saved.end)
          ? saved
          : { start: 1, end: 5 },
      );
    } catch {
      setRange({ start: 1, end: 5 });
    }
    setUploadProgress('');
    try {
      const saved = JSON.parse(readLocal(`harness:pending:${id}`) ?? 'null');
      pending.current =
        saved &&
        saved.conversationId === id &&
        typeof saved.id === 'string' &&
        typeof saved.text === 'string'
          ? saved
          : null;
    } catch {
      pending.current = null;
    }
  }
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const list = await api.conversations();
        if (!live) return;
        const actual = list.length ? list : [await api.create()];
        if (!live) return;
        setConversations(actual);
        const last = readLocal('harness:selected');
        choose(actual.some((c) => c.id === last) ? last! : actual[0].id);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0,
      events: Event[] = [];
    async function poll() {
      try {
        const [messages, tasks, batch, status, list] = await Promise.all([
          api.messages(selected, controller.signal),
          api.tasks(selected, controller.signal),
          api.events(selected, cursor, controller.signal),
          api.connection(controller.signal),
          api.conversations(controller.signal),
        ]);
        if (!live) return;
        events = [...events, ...batch];
        cursor = events.at(-1)?.seq ?? 0;
        setSnapshot({ id: selected, messages, tasks, events });
        setConnection(status);
        setConversations(list);
        setPollError('');
      } catch (e) {
        if (live) setPollError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(poll, 1000);
      }
    }
    void poll();
    return () => {
      live = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [selected, version]);
  const data = snapshot.id === selected ? snapshot : blank;
  function edit(text: string) {
    setDraft(text);
    if (selected) saveLocal(`harness:draft:${selected}`, text);
  }
  async function create() {
    if (creating || sending) return;
    setCreating(true);
    try {
      const c = await api.create();
      setConversations((v) => [c, ...v]);
      choose(c.id);
      setView('chat');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }
  function replaceSelection(next: File[]) {
    const revision = crypto.randomUUID(),
      names = next.map((f) => `${f.name}:${f.size}`);
    setFiles(next);
    setRequiredFiles(names);
    setSelectionRevision(revision);
    saveLocal(`harness:files:${selectedRef.current}`, JSON.stringify(names));
    saveLocal(`harness:selection:${selectedRef.current}`, revision);
  }
  function changeRange(next: { start: number; end: number }) {
    setRange(next);
    saveLocal(`harness:range:${selected}`, JSON.stringify(next));
  }
  async function send() {
    if (sending || voiceBusy || !draft.trim() || !selected) return;
    const materialKey = JSON.stringify({ files: requiredFiles, range, selectionRevision });
    const reusable =
      pending.current?.materialKey === materialKey ? pending.current.materialIds : undefined;
    if (requiredFiles.length && files.length !== requiredFiles.length && !reusable) {
      setError('请重新选择原附件以续传，或明确移除附件。');
      return;
    }
    const attachmentKey = JSON.stringify({ materialKey, transcriptId: transcriptId || null });
    const target = selected,
      text = draft;
    if (
      !pending.current ||
      pending.current.text !== text ||
      pending.current.conversationId !== target ||
      pending.current.attachmentKey !== attachmentKey
    )
      pending.current = {
        id: crypto.randomUUID(),
        text,
        conversationId: target,
        attachmentKey,
        materialKey,
        materialIds: reusable,
      };
    if (!saveLocal(`harness:pending:${target}`, JSON.stringify(pending.current))) {
      setError('浏览器无法保存发送凭据，消息尚未发送。请释放本地存储后重试。');
      return;
    }
    setSending(true);
    setError('');
    try {
      const materialIds: string[] = pending.current.materialIds ?? [];
      if (!pending.current.materialIds)
        for (const file of files)
          materialIds.push(await uploadFile(file, range, setUploadProgress));
      pending.current.materialIds = materialIds;
      if (!saveLocal(`harness:pending:${target}`, JSON.stringify(pending.current)))
        throw Error('发送凭据保存失败，尚未提交消息。');
      await api.send(target, pending.current.id, text, materialIds, transcriptId);
      saveLocal(`harness:pending:${target}`, 'null');
      if (selectedRef.current === target) {
        edit('');
        setFiles([]);
        setRequiredFiles([]);
        saveLocal(`harness:files:${target}`, '[]');
        setTranscriptId(undefined);
        saveLocal(`harness:transcript:${target}`, '');
        setUploadProgress('');
        pending.current = null;
        setVersion((v) => v + 1);
      }
    } catch (e) {
      if (selectedRef.current === target) setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function action(task: TaskView, kind: 'cancel' | 'resume') {
    try {
      await api[kind](task.id);
      setError('');
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const connected = connection?.state === 'available';
  const active = data.tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="个人工作台首页">
          <span className="brand-mark">
            <Icon name="leaf" size={23} />
          </span>
          <div>
            个人工作台<small>PERSONAL HARNESS</small>
          </div>
        </a>
        <button
          className="new-chat"
          aria-label="新建对话"
          disabled={creating || sending || voiceBusy}
          onClick={() => void create()}
        >
          <Icon name="plus" /> 新的工作 <span>↗</span>
        </button>
        <div className="sidebar-label">
          工作空间 <span>{conversations.length.toString().padStart(2, '0')}</span>
        </div>
        <nav className="conversation-list" aria-label="会话列表">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? 'selected' : ''}
              aria-label={`切换对话：${c.title}`}
              disabled={sending || voiceBusy}
              onClick={() => choose(c.id)}
            >
              <Icon name="chat" size={16} />
              <span>{c.title}</span>
              {selected === c.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Icon name="history" size={20} />
          <p>
            不止保存答案，
            <br />
            也保留抵达答案的过程。
          </p>
        </div>
        <div className="profile">
          <span className="profile-avatar">我</span>
          <div>
            个人空间<small>本机存储 · 单人使用</small>
          </div>
          <span className="profile-dot" />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <span>/</span>{' '}
            <strong>{conversations.find((c) => c.id === selected)?.title ?? '新的工作'}</strong>
          </div>
          <span className={`connection-pill ${connected ? 'online' : ''}`}>
            <i />
            {connected ? '订阅已验证' : '订阅未连接'}
          </span>
        </header>
        <div className="workspace-header">
          <div className="tabs" aria-label="视图选择">
            <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
              <Icon name="chat" />
              聊天
            </button>
            <button
              aria-label="工作记录"
              className={view === 'journal' ? 'active' : ''}
              onClick={() => setView('journal')}
            >
              <Icon name="history" />
              工作记录{data.events.length > 0 && <span>{data.events.length}</span>}
            </button>
          </div>
          <span className="workspace-caption">想法 → 行动 → 记录</span>
        </div>
        <div className="workspace-body">
          <main>
            <div className="content-scroll">
              {(error || pollError) && (
                <div className="error-banner" role="alert">
                  {error || pollError}
                </div>
              )}
              {view === 'chat' ? (
                <Chat
                  {...data}
                  onAction={(t, a) => void action(t, a)}
                  onSuggest={(text) => {
                    edit(text);
                    input.current?.focus();
                  }}
                />
              ) : (
                <Timeline events={data.events} messages={data.messages} />
              )}
            </div>
            {view === 'chat' && (
              <div className="composer-area">
                {connection && !connected && (
                  <p className="connection-note">
                    <span className="tiny-dot amber" />{' '}
                    先记录，稍后执行。完成订阅登录与验证后，可恢复暂停的任务。
                  </p>
                )}
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <Voice
                    key={selected}
                    disabled={sending || !selected}
                    onBusy={setVoiceBusy}
                    onTranscript={(id, text) => {
                      setTranscriptId(id);
                      saveLocal(`harness:transcript:${selected}`, id);
                      edit(draft ? draft + '\n' + text : text);
                    }}
                  />
                  <div className="attachment-controls">
                    <label>
                      添加附件
                      <input
                        aria-label="添加附件"
                        type="file"
                        multiple
                        disabled={sending}
                        onChange={(e) => {
                          const selected = Array.from(e.target.files ?? []);
                          if (selected.length > 3) {
                            setError('每批最多 3 个附件，请先处理样本。');
                            return;
                          }
                          replaceSelection(selected);
                          setError('');
                        }}
                      />
                    </label>
                    {requiredFiles.length > 0 && files.length === 0 && (
                      <p>
                        待续传附件：{requiredFiles.join('、')}。请重新选择原文件。
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => {
                            replaceSelection([]);
                          }}
                        >
                          移除待续传附件
                        </button>
                      </p>
                    )}
                    {files.map((f, i) => (
                      <div key={i}>
                        <strong>{f.name}</strong> · {(f.size / 1024 / 1024).toFixed(1)} MiB{' '}
                        <button
                          type="button"
                          disabled={sending}
                          onClick={() => {
                            const next = files.filter((_, j) => i !== j);
                            replaceSelection(next);
                          }}
                        >
                          移除
                        </button>
                      </div>
                    ))}
                    {files.length > 0 && (
                      <div>
                        <p>
                          发送时上传并按以下范围本地提取。文本最多 12,000 字符；图片仅 OCR；PDF 最多
                          20 页；音视频只转写音轨，最多 600 秒。
                        </p>
                        <label>
                          起始页 / 秒
                          <input
                            aria-label="起始页或秒"
                            type="number"
                            min="1"
                            value={range.start}
                            disabled={sending}
                            onChange={(e) =>
                              changeRange({ ...range, start: Number(e.target.value) })
                            }
                          />
                        </label>
                        <label>
                          结束页 / 秒
                          <input
                            aria-label="结束页或秒"
                            type="number"
                            min="1"
                            value={range.end}
                            disabled={sending}
                            onChange={(e) => changeRange({ ...range, end: Number(e.target.value) })}
                          />
                        </label>
                      </div>
                    )}
                    {uploadProgress && <p role="status">{uploadProgress}</p>}
                  </div>
                  <textarea
                    ref={input}
                    aria-label="输入消息"
                    placeholder="说说你想做什么…"
                    value={draft}
                    disabled={sending || !selected}
                    onChange={(e) => edit(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        (e.ctrlKey || e.metaKey) &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="composer-bottom">
                    <span>
                      <span className="tiny-dot" /> 文字工作台 <em>·</em>{' '}
                      {draft.length.toLocaleString()} / 20,000
                    </span>
                    <button
                      className="send"
                      aria-label="发送消息"
                      disabled={sending || voiceBusy || !draft.trim() || !selected}
                      type="submit"
                    >
                      {sending ? (
                        <span className="sending-dot">…</span>
                      ) : (
                        <Icon name="arrow" size={20} />
                      )}
                    </button>
                  </div>
                </form>
                <p className="composer-hint">
                  Ctrl / ⌘ + Enter 发送 <span>·</span> 原话与助手解释分别保存
                </p>
              </div>
            )}
          </main>
          <aside className="context-panel">
            <div className="context-heading">
              <span className="tiny-dot" /> 本次工作
            </div>
            <div className="context-stats">
              <div>
                <strong>
                  {data.messages
                    .filter((m) => m.role === 'user')
                    .length.toString()
                    .padStart(2, '0')}
                </strong>
                <span>原始消息</span>
              </div>
              <div>
                <strong>{data.events.length.toString().padStart(2, '0')}</strong>
                <span>过程记录</span>
              </div>
            </div>
            <div className="context-rule" />
            <h3>安心推进，一步一步</h3>
            <ul className="principles">
              <li>
                <Icon name="check" />
                <div>
                  原话独立保存<small>整理和解释不会覆盖你的表达</small>
                </div>
              </li>
              <li>
                <Icon name="check" />
                <div>
                  有边界地执行<small>一次处理一个任务，随时可取消</small>
                </div>
              </li>
              <li>
                <Icon name="check" />
                <div>
                  仅使用订阅连接<small>不可用时暂停，不切换付费 API</small>
                </div>
              </li>
            </ul>
            <div className="quota-card">
              <span>订阅剩余额度</span>
              <strong>
                未知 <span>—</span>
              </strong>
              <p>
                只展示服务实际返回的信息，
                <br />
                不估算会员剩余百分比。
              </p>
            </div>
            <div className="activity-note">
              <span className={`tiny-dot ${active ? '' : 'neutral'}`} />
              {active ? `${active} 个任务待处理` : '当前没有执行中的任务'}
            </div>
            <p className="local-note">
              记录保存在本机。
              <br />
              执行时，所需材料会发送给模型服务。
            </p>
          </aside>
        </div>
        <footer className="app-footer">
          <span>
            <Icon name="leaf" size={12} /> 让工作留下脉络
          </span>
          <span>第二阶段 · 本地材料与工作记录</span>
        </footer>
      </div>
    </div>
  );
}
