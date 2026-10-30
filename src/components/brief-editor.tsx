'use client';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import { saveBriefEditAction, rewriteBriefFieldAction } from '../app/brief-edit-actions.ts';
import { fieldValue, replaceField, type EditField } from '../server/brief-edit-fields.ts';
import type { BriefContent, Kind } from '../server/types.ts';
import { Brief } from './brief.tsx';

type Candidate = { field: EditField; text: string; snapshot: string };
function EditableText({
  label,
  value,
  multiline,
  onChange,
  onRewrite,
  pending,
  candidate,
  onApply,
  onDiscard,
  showLabel = false,
  rows = 4,
}: {
  label: string;
  showLabel?: boolean;
  rows?: number;
  value: string;
  multiline: boolean;
  onChange: (text: string) => void;
  onRewrite: () => void;
  pending: boolean;
  candidate?: string;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const inputId = useId();
  return (
    <div className="brief-edit-field">
      {showLabel && (
        <label className="brief-edit-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className="brief-edit-control">
        {multiline ? (
          <textarea
            id={inputId}
            aria-label={label}
            rows={rows}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <input
            id={inputId}
            aria-label={label}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        <button
          type="button"
          className="quiet-button brief-ai-button"
          title="AI重写"
          aria-label={`${label}AI重写`}
          disabled={pending}
          onClick={onRewrite}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden="true"
          >
            <path d="m14 3 1.8 5.2L21 10l-5.2 1.8L14 17l-1.8-5.2L7 10l5.2-1.8L14 3ZM5 14l1.2 3.8L10 19l-3.8 1.2L5 24l-1.2-3.8L0 19l3.8-1.2L5 14Z" />
          </svg>
        </button>
      </div>
      <small className="brief-edit-count">{[...value].length} 字</small>
      {candidate !== undefined && (
        <div className="brief-ai-candidate">
          <strong>AI候选</strong>
          <p>{candidate}</p>
          <div className="row-actions">
            <button type="button" onClick={onApply}>
              替换
            </button>
            <button type="button" className="quiet-button" onClick={onDiscard}>
              保留原文
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
export function BriefEditor({
  id,
  initialContent,
  initialVersion,
  initialBase,
  initialHasPublished,
  kind,
  date,
  issueNumber,
  industries,
}: {
  id: string;
  initialContent: BriefContent;
  initialVersion: string;
  initialBase: 'draft' | 'published';
  initialHasPublished: boolean;
  kind: Kind;
  date: string;
  issueNumber: number | null;
  industries: {
    id: string;
    name: string;
    sections: string[];
    description: string;
    position: number;
  }[];
}) {
  const [content, setContent] = useState(initialContent),
    current = useRef(content);
  const [version, setVersion] = useState(initialVersion),
    [base, setBase] = useState(initialBase),
    [hasPublished, setHasPublished] = useState(initialHasPublished);
  const [saved, setSaved] = useState(JSON.stringify(initialContent)),
    [preview, setPreview] = useState(false),
    [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [saving, setSaving] = useState(false),
    [rewriting, setRewriting] = useState(false),
    [pending, startTransition] = useTransition();
  const recentCandidates = useRef(new Map<string, { snapshot: string; texts: string[] }>());
  const dirty = JSON.stringify(content) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const update = (next: BriefContent) => {
    current.current = next;
    setContent(next);
    setNotice('');
  };
  const request = () => ({ id, content: current.current, version, base });
  function rewrite(field: EditField) {
    setRewriting(true);
    const snapshot = JSON.stringify(current.current);
    const fieldKey = JSON.stringify(field);
    const recent = recentCandidates.current.get(fieldKey);
    const previous = recent?.snapshot === snapshot ? recent.texts : [];
    setError('');
    setNotice('');
    setCandidate(null);
    startTransition(async () => {
      try {
        const result = await rewriteBriefFieldAction(request(), field, previous);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (snapshot !== JSON.stringify(current.current)) {
          setError('内容已变化，请重新生成候选');
          return;
        }
        recentCandidates.current.set(fieldKey, {
          snapshot,
          texts: [...new Set([...previous, result.text])].slice(-5),
        });
        setCandidate({ field, text: result.text, snapshot });
      } catch {
        setError('重写请求失败，请重试');
      } finally {
        setRewriting(false);
      }
    });
  }
  function save(mode: 'save' | 'publish') {
    setError('');
    setNotice('');
    setSaving(true);
    startTransition(async () => {
      try {
        const result = await saveBriefEditAction(request(), mode);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setVersion(result.version);
        setBase(result.base);
        setHasPublished(result.hasPublished);
        current.current = result.content;
        setContent(result.content);
        setSaved(JSON.stringify(result.content));
        setCandidate(null);
        setNotice(mode === 'save' ? '修订稿已保存' : '正式版已更新');
      } catch {
        setError('保存请求失败，请重试');
      } finally {
        setSaving(false);
      }
    });
  }
  function field(target: EditField, label: string, multiline = true, showLabel = false) {
    const selected =
      candidate && JSON.stringify(candidate.field) === JSON.stringify(target)
        ? candidate
        : undefined;
    return (
      <EditableText
        key={JSON.stringify(target)}
        label={label}
        showLabel={showLabel}
        rows={target.kind === 'highlight' ? 2 : 4}
        value={fieldValue(content, target)}
        multiline={multiline}
        pending={pending}
        onChange={(text) => {
          update(replaceField(current.current, target, text));
          setCandidate(null);
        }}
        onRewrite={() => rewrite(target)}
        candidate={selected?.text}
        onDiscard={() => setCandidate(null)}
        onApply={() => {
          if (!selected) return;
          if (JSON.stringify(current.current) !== selected.snapshot) {
            setError('内容已变化，请重新生成候选');
            setCandidate(null);
            return;
          }
          update(replaceField(current.current, target, selected.text));
          setCandidate(null);
        }}
      />
    );
  }
  return (
    <div className="brief-editor">
      <div className="brief-editor-toolbar">
        <div>
          <h1>{date} 期刊编辑</h1>
          <span className="muted">
            {hasPublished ? '正式版已发布' : '待审核稿'}
            {dirty ? ' · 未保存' : ''}
          </span>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="quiet-button"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? '继续编辑' : '预览'}
          </button>
          <button type="button" disabled={pending} onClick={() => save('save')}>
            保存修订稿
          </button>
          <button
            type="button"
            className="solid-button"
            disabled={pending}
            onClick={() => save('publish')}
          >
            {hasPublished ? '更新正式版' : '审核并发布'}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {rewriting && (
        <p role="status" className="muted">
          正在生成候选…
        </p>
      )}
      {preview ? (
        <div className="brief-editor-preview">
          <Brief
            content={content}
            kind={kind}
            date={date}
            issueNumber={issueNumber}
            industries={industries}
          />
        </div>
      ) : (
        <fieldset disabled={saving} className="brief-editor-fields">
          {field({ kind: 'title' }, '标题', false, true)}
          {Object.keys(content.overview).map((key) =>
            field(
              { kind: 'overview', key },
              `${industries.find((i) => i.id === key)?.name ?? key}概览`,
              true,
              true,
            ),
          )}
          {content.highlights?.length ? (
            <section className="brief-edit-section">
              <h2>{content.highlightsTitle ?? '今日要览'}</h2>
              {content.highlights.map((_, index) =>
                field({ kind: 'highlight', index }, `要览${index + 1}`),
              )}
            </section>
          ) : null}
          {[...new Set(content.items.map((i) => i.section))].map((section) => (
            <section key={section} className="brief-edit-section">
              <h2>{section}</h2>
              {content.items.map((item, index) =>
                item.section === section ? (
                  <div className="brief-edit-story" key={item.eventId}>
                    {field({ kind: 'itemTitle', index }, `资讯${index + 1}标题`, false)}
                    {field({ kind: 'itemSummary', index }, `资讯${index + 1}摘要`)}
                    {item.progress?.map((_, subIndex) =>
                      field(
                        { kind: 'itemProgress', index, subIndex },
                        `资讯${index + 1}进展${subIndex + 1}`,
                      ),
                    )}
                    <details>
                      <summary>来源 {item.sources.length}</summary>
                      {item.sources.map((source, i) => (
                        <p key={i}>
                          <a href={source.url} target="_blank" rel="noreferrer">
                            {source.name} · {source.title}
                          </a>
                        </p>
                      ))}
                    </details>
                  </div>
                ) : null,
              )}
            </section>
          ))}
          {content.rotations?.map((rotation, index) => (
            <section className="brief-edit-section" key={index}>
              <h2>{rotation.displayName ?? rotation.name}</h2>
              {field({ kind: 'rotationText', index }, `轮动${index + 1}正文`)}
            </section>
          ))}
          {field({ kind: 'note' }, '刊末备注', true, true)}
        </fieldset>
      )}
    </div>
  );
}
