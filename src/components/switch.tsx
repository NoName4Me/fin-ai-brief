'use client';
import { useState, type ButtonHTMLAttributes } from 'react';
type Props = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'name' | 'value' | 'defaultChecked'
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  name?: string;
  size?: 'small' | 'medium' | 'large';
};
export function Switch({
  checked,
  defaultChecked = false,
  onCheckedChange,
  name,
  size = 'medium',
  type = 'button',
  onClick,
  disabled,
  className = '',
  ...props
}: Props) {
  const [local, setLocal] = useState(defaultChecked);
  const value = checked ?? local;
  return (
    <>
      <button
        {...props}
        type={type}
        role="switch"
        aria-checked={value}
        disabled={disabled}
        className={`ui-switch ${className}`}
        data-size={size}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || type === 'submit') return;
          if (checked === undefined) setLocal(!value);
          onCheckedChange?.(!value);
        }}
      >
        <span />
      </button>
      {name && <input type="hidden" name={name} value="true" disabled={disabled || !value} />}
    </>
  );
}
