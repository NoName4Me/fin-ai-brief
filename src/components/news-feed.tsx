'use client';
import { Switch } from './switch.tsx';
import { useEffect, useRef, useState } from 'react';
import type { NewsItem } from '../server/publication.ts';
import { dateLabel, timeLabel } from '../server/periods.ts';
const revive = (row: NewsItem): NewsItem => ({
  ...row,
  occurredAt: new Date(row.occurredAt),
  updatedAt: new Date(row.updatedAt),
});
export function NewsFeed({
  initial,
  cursor: initialCursor,
  industry,
  q,
  topics,
  searchTools,
}: {
  initial: NewsItem[];
  cursor: string;
  industry: string;
  q: string;
  topics: { id: string; name: string }[];
  searchTools: React.ReactNode;
}) {
  const [rows, setRows] = useState(initial),
    [pending, setPending] = useState<Map<string, NewsItem>>(new Map()),
    [removed, setRemoved] = useState<Set<string>>(new Set());
  const [connectionVersion, setConnectionVersion] = useState(0);
  const known = useRef(new Map(initial.map((r) => [r.id, r])));
  const [live, setLive] = useState(true),
    [visible, setVisible] = useState(true),
    [status, setStatus] = useState('连接中'),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [more, setMore] = useState(initial.length === 100),
    [highlight, setHighlight] = useState<Set<string>>(new Set());
  const cursor = useRef(initialCursor),
    loaded = useRef(new Set(initial.map((r) => r.id))),
    top = useRef<HTMLDivElement>(null);
  const args = () => new URLSearchParams({ industry, q });
  useEffect(() => {
    const handler = () => setVisible(document.visibilityState === 'visible');
    handler();
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);
  useEffect(() => {
    if (!live || !visible) return;
    const params = new URLSearchParams({ industry, q, since: cursor.current });
    const source = new EventSource('/api/news/stream?' + params);
    source.onopen = () => setStatus('实时已连接');
    source.onerror = () => setStatus('连接中断，正在重连');
    source.addEventListener('update', (event: MessageEvent<string>) => {
      const data: { cursor: string; items: NewsItem[]; changed: string[] } = JSON.parse(event.data);
      cursor.current = data.cursor;
      const items = data.items.map(revive),
        ids = new Set(items.map((r) => r.id));
      setPending((previous) => {
        const next = new Map(previous);
        for (const id of data.changed) if (!ids.has(id)) next.delete(id);
        for (const item of items)
          if (JSON.stringify(known.current.get(item.id)) !== JSON.stringify(item))
            next.set(item.id, item);
          else next.delete(item.id);
        return next;
      });
      setRemoved((previous) => {
        const next = new Set(previous);
        for (const id of data.changed) if (loaded.current.has(id) && !ids.has(id)) next.add(id);
        for (const id of ids) next.delete(id);
        return next;
      });
    });
    return () => source.close();
  }, [live, visible, industry, q, connectionVersion]);
  useEffect(() => {
    if (!highlight.size) return;
    const timer = setTimeout(() => setHighlight(new Set()), 4000);
    return () => clearTimeout(timer);
  }, [highlight]);
  const newCount = [...pending.keys()].filter((id) => !loaded.current.has(id)).length;
  const updates = pending.size - newCount + removed.size;
  function apply() {
    setRows((old) => {
      const map = new Map(old.map((r) => [r.id, r]));
      for (const id of removed) map.delete(id);
      for (const [id, item] of pending) map.set(id, item);
      const next = [...map.values()].sort(
        (a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id),
      );
      loaded.current = new Set(next.map((r) => r.id));
      known.current = new Map(next.map((r) => [r.id, r]));
      return next;
    });
    setHighlight(new Set(pending.keys()));
    setPending(new Map());
    setRemoved(new Set());
    top.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
      block: 'start',
    });
  }
  async function refresh(older = false) {
    setLoading(true);
    setError('');
    try {
      const params = args();
      const last = rows.at(-1);
      if (older && last) {
        params.set('beforeTime', last.occurredAt.toISOString());
        params.set('beforeId', last.id);
      }
      const response = await fetch('/api/news?' + params, { cache: 'no-store' });
      if (!response.ok) throw new Error('读取资讯失败，请重试');
      const data: { items: NewsItem[]; cursor: string } = await response.json();
      const incoming = data.items.map(revive);
      setRows((old) => {
        const map = new Map((older ? old : []).map((r) => [r.id, r]));
        for (const item of incoming) map.set(item.id, item);
        const next = [...map.values()];
        loaded.current = new Set(next.map((r) => r.id));
        known.current = new Map(next.map((r) => [r.id, r]));
        return next;
      });
      setMore(incoming.length === 100);
      if (!older) {
        cursor.current = data.cursor;
        setPending(new Map());
        setRemoved(new Set());
        setConnectionVersion((v) => v + 1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <div className="news-toolbar">
        {searchTools}
        <div className="live-controls">
          <label className="check">
            <Switch aria-label="实时更新" size="small" checked={live} onCheckedChange={setLive} />
            实时更新
          </label>
          <button className="outline-button" onClick={() => void refresh()} disabled={loading}>
            {loading ? '更新中…' : '刷新资讯'}
          </button>
          <span className="muted" role="status">
            {!live ? '自动更新已暂停' : !visible ? '后台暂停连接' : status}
          </span>
        </div>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {(pending.size > 0 || removed.size > 0) && (
        <button className="news-update-prompt" onClick={apply} aria-live="polite">
          ↑ {newCount ? `${newCount}条新资讯` : ''}
          {newCount && updates ? '，' : ''}
          {updates ? `${updates}条更新` : ''}，点击查看
        </button>
      )}
      <div ref={top} className="news-list-top" />
      {rows.map((row) => (
        <article
          id={'news-' + row.id}
          key={row.id}
          className={`live-entry domain-${row.industryId} ${highlight.has(row.id) ? 'news-highlight' : ''}`}
        >
          <time dateTime={row.occurredAt.toISOString()}>
            <span>{dateLabel(row.occurredAt)}</span>
            <span>{row.timeKnown ? timeLabel(row.occurredAt) : '时刻未披露'}</span>
          </time>
          <div>
            <div className="live-heading">
              {topics.find((i) => i.id === row.industryId)?.name} / {row.section}
            </div>
            <h2>{row.title}</h2>
            <p>{row.summary}</p>
            <div className="source-row">
              {row.sources.map((s) => (
                <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.name} ↗
                </a>
              ))}
            </div>
          </div>
        </article>
      ))}
      {!rows.length && <p className="empty-state">暂无符合条件的资讯。</p>}
      {more && (
        <button className="outline-button" disabled={loading} onClick={() => void refresh(true)}>
          加载更早资讯
        </button>
      )}
    </>
  );
}
