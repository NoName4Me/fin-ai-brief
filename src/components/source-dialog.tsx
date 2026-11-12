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
      <dialog ref={dialog} id={id} className="source-dialog" aria-labelledby={`${id}-title`}>
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
