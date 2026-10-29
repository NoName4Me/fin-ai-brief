'use client';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function SourceFilters({
  enabled,
  section,
  format,
  sections,
  formats,
}: {
  enabled: string;
  section: string;
  format: string;
  sections: string[];
  formats: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function update(key: string, value: string) {
    const query = new URLSearchParams(window.location.search);
    if (value) query.set(key, value);
    else query.delete(key);
    for (const key of ['notice', 'error', 'event']) query.delete(key);
    startTransition(() =>
      router.replace(`/admin/sources${query.size ? `?${query}` : ''}`, { scroll: false }),
    );
  }
  return (
    <div className="source-filters" role="search" aria-label="信源筛选">
      <label>
        <select
          aria-label="启用状态筛选"
          value={enabled}
          disabled={pending}
          onChange={(event) => update('enabled', event.target.value)}
        >
          <option value="">全部状态</option>
          <option value="true">已启用</option>
          <option value="false">已关闭</option>
        </select>
      </label>
      <label>
        <select
          aria-label="栏目筛选"
          value={section}
          disabled={pending}
          onChange={(event) => update('section', event.target.value)}
        >
          <option value="">全部栏目</option>
          <option value="general">通用</option>
          {sections.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <select
          aria-label="采集格式筛选"
          value={format}
          disabled={pending}
          onChange={(event) => update('format', event.target.value)}
        >
          <option value="">全部格式</option>
          {Object.entries(formats).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
