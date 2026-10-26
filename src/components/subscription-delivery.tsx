'use client';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { manualDeliveryAction, removeSubscriberAction } from '../app/actions.ts';

type Recipient = { id: string; email: string; kinds: string; active: boolean };
type Issue = { id: string; label: string };
function SendButton({ disabled, count }: { disabled: boolean; count: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="solid-button" disabled={disabled || pending}>
      {pending ? '正在提交…' : `推送至 ${count} 个邮箱`}
    </button>
  );
}
export function SubscriptionDelivery({
  recipients,
  issues,
  configError,
}: {
  recipients: Recipient[];
  issues: Issue[];
  configError: string | null;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [briefId, setBriefId] = useState('');
  const active = recipients.filter((r) => r.active);
  return (
    <>
      <form id="manual-delivery" action={manualDeliveryAction} className="stack-form delivery-form">
        <h2>手动推送</h2>
        <label>
          推送刊期
          <select
            name="briefId"
            value={briefId}
            onChange={(e) => setBriefId(e.target.value)}
            required
          >
            <option value="">{issues.length ? '选择已发布刊期' : '暂无已发布刊期'}</option>
            {issues.map((issue) => (
              <option key={issue.id} value={issue.id}>
                {issue.label}
              </option>
            ))}
          </select>
        </label>
        {briefId && (
          <a href={`/briefs/${briefId}`} target="_blank" rel="noreferrer">
            查看本期内容
          </a>
        )}
        <div>
          <label className="check">
            <input type="checkbox" name="force" defaultChecked />
            强制推送（已发送或结果待确认的邮件也重新发送）
          </label>
        </div>
        <p className="form-hint" id="delivery-hint">
          {configError ?? '排队中、发送中的记录会跳过。'}
        </p>
        <SendButton
          disabled={!!configError || !briefId || !selected.length}
          count={selected.length}
        />
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>
                <label className="check">
                  <input
                    type="checkbox"
                    aria-label="全选可推送邮箱"
                    disabled={!active.length}
                    checked={active.length > 0 && selected.length === active.length}
                    onChange={(e) => setSelected(e.target.checked ? active.map((r) => r.id) : [])}
                  />
                  全选
                </label>
              </th>
              <th>邮箱</th>
              <th>订阅类型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {recipients.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    form="manual-delivery"
                    name="subscriptionIds"
                    value={row.id}
                    aria-label={`选择 ${row.email}`}
                    disabled={!row.active}
                    checked={selected.includes(row.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, row.id]
                          : selected.filter((id) => id !== row.id),
                      )
                    }
                  />
                </td>
                <td>{row.email}</td>
                <td>{row.kinds}</td>
                <td>{row.active ? '已登记' : '已退订'}</td>
                <td>
                  <form action={removeSubscriberAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <button className="quiet-button">删除登记</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!recipients.length && <p className="empty-state">暂无订阅登记。</p>}
    </>
  );
}
