'use client';

export function PrintButton() {
  return (
    <button className="source-link" onClick={() => window.print()}>
      打印本期
    </button>
  );
}
