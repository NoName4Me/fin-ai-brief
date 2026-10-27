'use client';
import { useActionState } from 'react';
import { sourceToggleAction } from '../app/actions.ts';
export function SourceSwitch({
  id,
  name,
  enabled,
  canEnable,
}: {
  id: string;
  name: string;
  enabled: boolean;
  canEnable: boolean;
}) {
  const [result, action, pending] = useActionState(sourceToggleAction, null);
  return (
    <form action={action} className="source-toggle-form">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <button
        type="submit"
        role="switch"
        aria-checked={enabled}
        aria-label={`启用${name}`}
        disabled={pending || (!enabled && !canEnable)}
        className="source-switch"
        title={
          !enabled && !canEnable
            ? '请先在详情中完成采集与内容评估'
            : enabled
              ? '关闭信源'
              : '启用信源'
        }
      >
        <span />
      </button>
      <span className="source-toggle-label">
        {pending ? '保存中' : enabled ? '已启用' : '已关闭'}
      </span>
      {result?.error && (
        <p role="alert" className="source-toggle-error">
          {result.error}
        </p>
      )}
    </form>
  );
}
