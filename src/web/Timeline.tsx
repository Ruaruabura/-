import type { Event, Message } from '../shared/contracts.js';
import { reasons, time } from './labels.js';
import { Icon } from './Icon.js';
const labels: Record<string, string> = {
  'message.sent': '用户原话',
  'task.queued': '任务已排队',
  'task.running': '开始执行',
  'task.paused': '任务已暂停',
  'task.failed': '执行失败',
  'task.completed': '任务完成',
  'task.cancelled': '任务已取消',
  'task.cancel_requested': '请求取消',
  'assistant.message': '助手回复',
  'model.request': '调用订阅模型',
  'model.usage': '服务返回的用量',
  'tool.read': '读取材料',
  'visible.progress': '可见输出',
};
export function Timeline({ events, messages }: { events: Event[]; messages: Message[] }) {
  return (
    <section className="timeline-view">
      <header className="section-heading">
        <p className="eyebrow">WORK JOURNAL</p>
        <h1>每一步，都有来处。</h1>
        <p>原始表达、执行记录与助手输出，按发生顺序保留。</p>
      </header>
      {!events.length ? (
        <div className="timeline-empty">
          <Icon name="history" size={28} />
          <h3>第一条记录，从你的消息开始</h3>
          <p>发送后的原话会保存在这里。草稿不会进入工作记录。</p>
        </div>
      ) : (
        <ol className="timeline">
          {events.map((event) => {
            const source = messages.find((m) => m.id === event.payload.messageId);
            let detail = source?.text;
            if (event.payload.reason)
              detail = reasons[String(event.payload.reason)] ?? String(event.payload.reason);
            if (event.type === 'visible.progress') detail = String(event.payload.text);
            if (event.type === 'model.request')
              detail = `${event.payload.provider} · ${event.payload.model}`;
            if (event.type === 'tool.read')
              detail = `${event.payload.path} · ${event.payload.characters} 字符`;
            if (event.type === 'model.usage')
              detail = `输入 ${event.payload.input} / 输出 ${event.payload.output} tokens；剩余额度未知`;
            return (
              <li key={event.seq}>
                <span
                  className={`timeline-dot ${event.type === 'message.sent' ? 'primary' : ''}`}
                />
                <div className="timeline-meta">
                  <strong>{labels[event.type] ?? event.type}</strong>
                  <time>{time(event.createdAt)}</time>
                  <span className="sequence">#{event.seq}</span>
                </div>
                {detail && <p>{detail}</p>}
                {source && (
                  <span className="source-tag">
                    {source.role === 'user' ? '用户原文 · 未改写' : '助手输出 · 不代表用户已采纳'}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
