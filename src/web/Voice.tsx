import { useEffect, useRef, useState } from 'react';
export function Voice({
  disabled,
  onTranscript,
  onBusy,
}: {
  disabled: boolean;
  onTranscript: (id: string, text: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [available, setAvailable] = useState(false),
    [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void fetch('/api/capabilities')
      .then((r) => r.json())
      .then((v) => {
        if (alive.current) setAvailable(v.speech);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);
  async function transcribe(blob: Blob) {
    if (blob.size > 16 * 1024 * 1024) {
      setError('语音文件不能超过 16 MiB');
      return;
    }
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const response = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error?.message ?? '转写失败');
      if (alive.current) onTranscript(data.id, data.text);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const r = new MediaRecorder(stream),
        chunks: Blob[] = [];
      recorder.current = r;
      r.ondataavailable = (e) => chunks.push(e.data);
      const timer = setTimeout(() => {
        if (r.state === 'recording') r.stop();
      }, 120000);
      r.onstop = () => {
        clearTimeout(timer);
        stream.getTracks().forEach((t) => t.stop());
        if (alive.current) {
          setRecording(false);
          onBusy(false);
          void transcribe(new Blob(chunks, { type: r.mimeType }));
        }
      };
      r.start();
      setRecording(true);
      onBusy(true);
      setError('');
    } catch {
      setError('无法使用麦克风，请检查浏览器权限或选择语音文件。');
    }
  }
  return (
    <div className="voice-controls">
      <button
        type="button"
        disabled={!available || busy || (!recording && disabled)}
        onClick={() => (recording ? recorder.current?.stop() : void start())}
      >
        {recording ? '停止并转写' : '录音（最多 2 分钟）'}
      </button>
      <label>
        选择语音文件
        <input
          aria-label="选择语音文件"
          type="file"
          accept="audio/*"
          disabled={!available || disabled || busy || recording}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void transcribe(file);
            e.target.value = '';
          }}
        />
      </label>
      <small>
        {busy
          ? '正在本地转写…'
          : available
            ? '转写后可编辑，点击发送才提交；音频转写后删除。'
            : '本地语音模型未就绪，录音暂不可用。'}
      </small>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
