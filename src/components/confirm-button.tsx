'use client';

import { useId, useRef, type ButtonHTMLAttributes } from 'react';

export function ConfirmButton({
  title,
  message,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  onConfirm,
  children,
  type = 'submit',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        {...props}
        ref={trigger}
        type={type}
        onClick={(event) => {
          event.preventDefault();
          if (type === 'submit' && !event.currentTarget.form?.reportValidity()) return;
          dialog.current?.showModal();
        }}
      >
        {children}
      </button>
      <dialog
        ref={dialog}
        className="unsubscribe-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onClose={(event) => {
          event.stopPropagation();
          trigger.current?.focus();
        }}
      >
        <div className="unsubscribe-dialog-body">
          <h2 id={`${id}-title`}>{title}</h2>
          <p id={`${id}-description`}>{message}</p>
        </div>
        <div className="unsubscribe-dialog-actions">
          <button
            type="button"
            className="outline-button"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="solid-button unsubscribe-confirm"
            onClick={() => {
              dialog.current?.close();
              if (onConfirm) onConfirm();
              else if (trigger.current) trigger.current.form?.requestSubmit(trigger.current);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </dialog>
    </>
  );
}
