'use client';
import { useActionState } from 'react';
import { Switch } from './switch.tsx';
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
      <Switch
        type="submit"
        checked={enabled}
        aria-label={`启用${name}`}
        aria-busy={pending}
        disabled={pending || (!enabled && !canEnable)}
        size="small"
        title={
          !enabled && !canEnable ? '请先在详情中完成采集验证' : enabled ? '关闭信源' : '启用信源'
        }
      />
      {result?.error && (
        <p role="alert" className="source-toggle-error">
          {result.error}
        </p>
      )}
    </form>
  );
}
