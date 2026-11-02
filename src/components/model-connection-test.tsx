'use client';
import { useState, useTransition } from 'react';
import { PlugZap } from 'lucide-react';
import { testModelConnectionAction } from '../app/actions.ts';

export function ModelConnectionTest() {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; response: string } | null>(null);
  return (
    <div className="model-connection-test">
      <button
        type="button"
        className="outline-button"
        disabled={pending}
        onClick={(event) => {
          const form = event.currentTarget.closest('form');
          if (!form) return;
          const data = new FormData(form);
          setResult(null);
          startTransition(async () => {
            try {
              setResult(await testModelConnectionAction(data));
            } catch {
              setResult({ ok: false, response: '连接失败，请重试' });
            }
          });
        }}
      >
        <PlugZap className="icon" strokeWidth={1.75} aria-hidden="true" />
        {pending ? '测试中…' : '测试连通'}
      </button>
      {result && (
        <div role="status" className="model-test-result">
          <strong className={result.ok ? 'model-test-success' : 'model-test-error'}>
            {result.ok ? '成功' : '失败'}
          </strong>
          <p>{result.response}</p>
        </div>
      )}
    </div>
  );
}
