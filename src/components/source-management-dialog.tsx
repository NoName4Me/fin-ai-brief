'use client';

import { useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';

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
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          dialog.current?.close();
      }}
    >
      <header className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="dialog-close" onClick={() => dialog.current?.close()}>
          关闭
        </button>
      </header>
      <div className="source-management-body">{children}</div>
    </dialog>
  );
}
