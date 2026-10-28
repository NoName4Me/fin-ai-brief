'use client';
import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { requestSubscriptionAction } from '../app/actions.ts';

function SubscribeDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [email, setEmail] = useState('');
  const [result, action, pending] = useActionState(requestSubscriptionAction, null);
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>('input[name="email"]')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="subscription-reader-dialog"
      aria-labelledby={titleId}
      onClose={close}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          dialog.current?.close();
      }}
    >
      <button
        type="button"
        className="subscription-dialog-close"
        aria-label="关闭订阅弹窗"
        onClick={() => dialog.current?.close()}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
      <h2 id={titleId}>{result?.status === 'sent' ? '请查收确认邮件' : '订阅数智参阅'}</h2>
      {result?.status === 'sent' ? (
        <div className="subscription-dialog-result" role="status">
          <p>
            前往邮箱，点击“确认订阅”后生效。
            <br />
            确认链接24小时内有效。
          </p>
          <p className="muted">未收到时请检查垃圾邮件。已生效的订阅无需重复确认。</p>
          <button type="button" className="solid-button" onClick={() => dialog.current?.close()}>
            知道了
          </button>
        </div>
      ) : (
        <form action={action} className="stack-form">
          <p>每日资讯，送至您的邮箱。</p>
          <label>
            邮箱地址
            <input
              name="email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              autoFocus
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label className="honey" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          {result?.status === 'error' && (
            <p className="subscription-dialog-error" role="alert">
              {result.message}
            </p>
          )}
          <button className="solid-button" disabled={pending}>
            {pending ? '正在发送确认邮件…' : '发送确认邮件'}
          </button>
          <p className="subscription-dialog-note">邮件确认后生效，随时可以退订。</p>
        </form>
      )}
    </dialog>
  );
}
export function SubscribeButton({
  className = 'subscribe-link',
  children = '邮箱订阅',
  initiallyOpen = false,
}: {
  className?: string;
  children?: React.ReactNode;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      {open && <SubscribeDialog close={() => setOpen(false)} />}
    </>
  );
}
