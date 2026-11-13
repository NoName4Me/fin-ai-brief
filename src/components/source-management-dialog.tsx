'use client';

import { useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';

export function SourceManagementDialog({
  title,
  closeHref,
  className = '',
  open = true,
  children,
}: {
  title: string;
  closeHref: string;
  className?: string;
  open?: boolean;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const router = useRouter();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={`source-dialog source-management-dialog ${className}`.trim()}
      aria-labelledby={titleId}
      onClose={() => {
        if (open) router.replace(closeHref, { scroll: false });
      }}
    >
      <header className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="关闭"
          title="关闭"
          onClick={() => dialog.current?.close()}
        >
          <X className="icon" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </header>
      <div className="source-management-body">{children}</div>
    </dialog>
  );
}
