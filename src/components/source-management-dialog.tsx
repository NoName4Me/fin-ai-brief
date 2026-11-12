'use client';

import { useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';

export function SourceManagementDialog({
  title,
  closeHref,
  children,
}: {
  title: string;
  closeHref: string;
  children: React.ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const router = useRouter();

  useEffect(() => {
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="source-dialog source-management-dialog"
      aria-labelledby={titleId}
      onClose={() => router.replace(closeHref, { scroll: false })}
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
