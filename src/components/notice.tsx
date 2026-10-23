'use client';
import { useEffect, useState } from 'react';
export type Query = Record<string, string | string[] | undefined>;
function Notification({ message, error }: { message: string; error: boolean }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (error) return;
    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, [error]);
  if (!visible) return null;
  return (
    <div className={`notification ${error ? 'error' : ''}`}>
      <p role={error ? 'alert' : 'status'}>{message}</p>
      <button type="button" onClick={() => setVisible(false)} aria-label="关闭通知">
        ×
      </button>
    </div>
  );
}
export function Notice({ query }: { query: Query }) {
  const message = query.error ?? query.notice;
  return typeof message === 'string' ? (
    <Notification key={`${query.event ?? ''}:${message}`} message={message} error={!!query.error} />
  ) : null;
}
export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
