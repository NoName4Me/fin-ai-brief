'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ModelActivityPoint } from '../server/admin-models.ts';

const palette = [
  '#9f3030',
  '#bf4138',
  '#d3542f',
  '#df6d29',
  '#e7862d',
  '#e9a32e',
  '#e1bd3b',
  '#c99a2c',
  '#ad4c39',
  '#c2622d',
];
const categories: Record<string, string> = {
  timeout: '超时',
  network: '网络异常',
  'server-error': '服务端错误',
  'rate-limited': '请求限流',
  auth: '认证失败',
  request: '请求失败',
  quality: '内容校验失败',
  unknown: '未知异常',
};

export function ModelActivityChart({
  models,
  buckets,
  points,
}: {
  models: { id: string; name: string }[];
  buckets: { key: string; label: string }[];
  points: ModelActivityPoint[];
}) {
  const [selected, setSelected] = useState<ModelActivityPoint | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const originRef = useRef<SVGGElement>(null);
  useEffect(() => {
    if (!selected) return;
    const origin = originRef.current;
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    closeRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      origin?.focus();
    };
  }, [selected]);
  const ordered = [...buckets].reverse();
  const left = 58;
  const top = 42;
  const column = 100;
  const row = 52;
  const width = Math.max(340, left + Math.max(1, models.length) * column);
  const height = top + Math.max(1, ordered.length) * row + 20;
  const maxCount = Math.max(1, ...points.map((point) => point.count));
  const at = (modelId: string, bucket: string) =>
    points.find((point) => point.modelId === modelId && point.hour.slice(0, 13) === bucket);
  const radius = (count: number) => Math.min(14, Math.max(4, 4 + Math.sqrt(count / maxCount) * 10));
  const hourText = (label: string) => (label === '00' ? '0 时' : `${Number(label)} 时`);
  return (
    <div className="model-chart-wrap">
      <svg
        className="model-activity-chart"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="按小时统计的模型异常分布，最新时间在上方"
      >
        <text x={left - 12} y={20} textAnchor="end" className="chart-now-label">
          现在
        </text>
        {models.map((model, index) => (
          <g key={model.id}>
            <line
              x1={left + index * column + column / 2}
              x2={left + index * column + column / 2}
              y1={top}
              y2={height - 12}
              className="chart-model-guide"
            />
            <text
              x={left + index * column + column / 2}
              y={20}
              textAnchor="middle"
              className="chart-model-name"
            >
              {model.name}
            </text>
          </g>
        ))}
        {ordered.map((bucket, rowIndex) => (
          <g key={bucket.key}>
            {models.map((model, modelIndex) => {
              const point = at(model.id, bucket.key);
              if (!point) return null;
              const cx = left + modelIndex * column + column / 2;
              const cy = top + rowIndex * row + row / 2;
              return (
                <g
                  key={model.id}
                  className="model-bubble"
                  role="button"
                  tabIndex={0}
                  aria-label={`${model.name} ${hourText(bucket.label)} 异常 ${point.count} 次，查看详情`}
                  onClick={(event) => {
                    originRef.current = event.currentTarget;
                    setSelected(point);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      originRef.current = event.currentTarget;
                      setSelected(point);
                    }
                  }}
                >
                  <circle
                    cx={cx}
                    cy={cy}
                    r={radius(point.count)}
                    fill={palette[modelIndex % palette.length]}
                  />
                  {point.count >= 10 && (
                    <text x={cx} y={cy + 3} textAnchor="middle" className="bubble-count">
                      {point.count}
                    </text>
                  )}
                </g>
              );
            })}
            {bucket.label === '00' ? (
              <>
                <text
                  x={left - 10}
                  y={top + (rowIndex + 1) * row - 2}
                  textAnchor="end"
                  className="chart-midnight-label"
                >
                  今
                </text>
                <text
                  x={left - 10}
                  y={top + (rowIndex + 1) * row + 8}
                  textAnchor="end"
                  className="chart-midnight-label"
                >
                  昨
                </text>
              </>
            ) : (
              <text
                x={left - 10}
                y={top + (rowIndex + 1) * row + 3}
                textAnchor="end"
                className="chart-hour-label"
              >
                {bucket.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {selected && (
        <dialog
          ref={dialogRef}
          className="model-event-dialog"
          onCancel={() => setSelected(null)}
          onClose={() => setSelected(null)}
          aria-labelledby="model-event-dialog-title"
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setSelected(null);
          }}
        >
          <div className="model-event-dialog-heading">
            <div>
              <h3 id="model-event-dialog-title">
                {models.find((model) => model.id === selected.modelId)?.name} ·{' '}
                {hourText(selected.label)}
              </h3>
              <p>{selected.count} 次异常</p>
            </div>
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              onClick={() => setSelected(null)}
              aria-label="关闭异常详情"
            >
              <X className="icon" strokeWidth={1.75} aria-hidden="true" />
            </button>
          </div>
          <ol className="model-event-list">
            {selected.failures.map((failure) => (
              <li key={failure.id}>
                <time dateTime={failure.at.toISOString()}>
                  {new Intl.DateTimeFormat('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  }).format(new Date(failure.at))}
                </time>
                <strong>
                  {categories[failure.category] ?? failure.category}
                  {failure.httpStatus ? ` · HTTP ${failure.httpStatus}` : ''}
                </strong>
                <p>{failure.error}</p>
              </li>
            ))}
          </ol>
        </dialog>
      )}
    </div>
  );
}
