'use client';
import { useId, useRef } from 'react';
export function SourceDialog({
  title,
  children,
  label = '来源与依据',
}: {
  title: string;
  children: React.ReactNode;
  label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button
        className="source-link source-dialog-trigger"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="source-dialog"
        aria-labelledby={`${id}-title`}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            event.currentTarget.close();
        }}
      >
        <header className="dialog-header">
          <div>
            <h2 id={`${id}-title`}>来源与依据</h2>
            <p>{title}</p>
          </div>
          <button
            className="dialog-close"
            aria-label="关闭来源弹窗"
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </dialog>
    </>
  );
}
