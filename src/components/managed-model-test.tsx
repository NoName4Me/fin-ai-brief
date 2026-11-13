'use client';
import { useEffect, useState } from 'react';

export function ManagedModelTest({ id }: { id: string }) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; response: string } | null>(null);
  useEffect(() => setReady(true), []);
  async function test() {
    setPending(true);
    setResult(null);
    try {
      const response = await fetch('/api/admin/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await response.json();
      setResult(body);
    } catch {
      setResult({ ok: false, response: '连接测试失败' });
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="text-button"
        data-ready={ready}
        disabled={!ready || pending}
        onClick={test}
      >
        {pending ? '测试中…' : '测试'}
      </button>
      {result && (
        <span
          role="status"
          className={`managed-model-test-result ${
            result.ok ? 'model-test-success' : 'model-test-error'
          }`}
          title={result.response}
        >
          <strong>{result.ok ? '连通' : '失败'}</strong>
          <small>{result.response}</small>
        </span>
      )}
    </>
  );
}
