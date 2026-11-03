'use client';
import { useState, useTransition } from 'react';
import { Save, PlugZap } from 'lucide-react';
import { saveMailSettingsAction, testMailConnectionAction } from '../app/actions.ts';
import type { PublicMailConnection } from '../server/mail-connection.ts';

export function MailSettingsForm({
  connection,
  onSaved,
}: {
  connection: PublicMailConnection;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [operation, setOperation] = useState<'save' | 'test'>('save');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (form: HTMLFormElement, operation: 'save' | 'test') => {
    if (!form.reportValidity()) return;
    setOperation(operation);
    setResult(null);
    const data = new FormData(form);
    startTransition(async () => {
      try {
        const response = await (operation === 'save'
          ? saveMailSettingsAction(data)
          : testMailConnectionAction(data));
        setResult(response);
        if (operation === 'save' && response.ok) onSaved();
      } catch {
        setResult({ ok: false, message: '操作失败，请重试' });
      }
    });
  };
  return (
    <form
      className="stack-form mail-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        run(event.currentTarget, 'save');
      }}
    >
      <div className="mail-connection-fields">
        <label>
          SMTP 地址
          <input
            name="smtpHost"
            defaultValue={connection.host}
            required
            autoComplete="off"
            placeholder="smtp.qq.com"
          />
        </label>
        <label>
          端口
          <input
            name="smtpPort"
            type="number"
            min="1"
            max="65535"
            defaultValue={connection.port}
            required
          />
        </label>
      </div>
      <label>
        加密方式
        <select name="smtpSecurity" defaultValue={connection.security}>
          <option value="tls">SSL/TLS</option>
          <option value="starttls">STARTTLS</option>
          <option value="none">不加密</option>
        </select>
      </label>
      <label>
        账号
        <input name="smtpUser" defaultValue={connection.user} autoComplete="off" />
      </label>
      <label>
        密码或授权码
        <input
          name="smtpPassword"
          type="password"
          autoComplete="new-password"
          placeholder={connection.passwordConfigured ? '已配置，留空保留原值' : '填写密码或授权码'}
        />
      </label>
      <label>
        发件人
        <input
          name="mailFrom"
          defaultValue={connection.from}
          required
          placeholder="数智参阅 <your@email.com>"
        />
      </label>
      {result && (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'model-test-success' : 'model-test-error'}
        >
          {result.message}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="outline-button"
          disabled={pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) run(form, 'test');
          }}
        >
          <PlugZap className="icon" strokeWidth={1.75} aria-hidden="true" />
          {pending && operation === 'test' ? '测试中…' : '测试连接'}
        </button>
        <button className="solid-button" disabled={pending}>
          <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
          {pending && operation === 'save' ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
