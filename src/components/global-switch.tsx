'use client';
import { useActionState } from 'react';
import { Switch } from './switch.tsx';
import { globalSwitchAction } from '../app/actions.ts';
export function GlobalSwitch({
  setting,
  label,
  enabled,
}: {
  setting: 'collectionEnabled' | 'deliveryEnabled';
  label: string;
  enabled: boolean;
}) {
  const [result, action, pending] = useActionState(globalSwitchAction, null);
  return (
    <form action={action} className="source-toggle-form global-switch">
      <input type="hidden" name="setting" value={setting} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <Switch type="submit" aria-label={label} checked={enabled} disabled={pending} size="medium" />
      <span>
        {label}
        {pending ? ' · 保存中' : ''}
      </span>
      {result?.error && (
        <p role="alert" className="source-toggle-error">
          {result.error}
        </p>
      )}
    </form>
  );
}
