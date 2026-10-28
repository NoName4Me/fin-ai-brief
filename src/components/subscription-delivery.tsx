'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  addSubscriberAction,
  manualDeliveryAction,
  removeSubscriberAction,
} from '../app/actions.ts';
import { GlobalSwitch } from './global-switch.tsx';
import { SubscriptionTabs } from './admin-page-tabs.tsx';

type Recipient = { id: string; email: string; kinds: string; active: boolean; createdAt: string };
type Issue = { id: string; label: string };
type Send = {
  id: string;
  state: string;
  error: string | null;
  email: string;
  issue: string;
  briefId: string;
  createdAt: string;
};
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="source-dialog source-management-dialog subscription-dialog"
      aria-labelledby={titleId}
      onClose={close}
    >
      <header className="dialog-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="dialog-close" onClick={() => ref.current?.close()}>
          关闭
        </button>
      </header>
      <div className="source-management-body">{children}</div>
    </dialog>
  );
}
function SendButton({ disabled, count }: { disabled: boolean; count: number }) {
  const { pending } = useFormStatus();
  return (
    <button className="solid-button" disabled={disabled || pending}>
      {pending ? '正在提交…' : `推送至 ${count} 个邮箱`}
    </button>
  );
}
const states: Record<string, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  uncertain: '结果待确认',
};
export function SubscriptionDelivery({
  recipients,
  issues,
  sends,
  configError,
  deliveryEnabled,
  active,
}: {
  recipients: Recipient[];
  issues: Issue[];
  sends: Send[];
  configError: string | null;
  deliveryEnabled: boolean;
  active: 'subscribers' | 'history';
}) {
  const [modal, setModal] = useState<'add' | 'send' | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [briefId, setBriefId] = useState('');
  const available = recipients.filter((r) => r.active);
  return (
    <>
      <div className="subscription-toolbar">
        <button className="solid-button" onClick={() => setModal('add')}>
          添加订阅
        </button>
        <button className="outline-button" onClick={() => setModal('send')}>
          手动推送
        </button>
        <GlobalSwitch setting="deliveryEnabled" label="启动推送" enabled={deliveryEnabled} />
      </div>
      {deliveryEnabled && configError && <p className="form-hint">发信配置未就绪</p>}
      <SubscriptionTabs active={active} />
      {active === 'subscribers' ? (
        <>
          <div className="table-wrap subscription-table">
            <table>
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>订阅类型</th>
                  <th>订阅时间</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {recipients.map((row) => (
                  <tr key={row.id}>
                    <td>{row.email}</td>
                    <td>{row.kinds}</td>
                    <td>{row.createdAt}</td>
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
      ) : (
        <>
          <div className="table-wrap subscription-table">
            <table>
              <thead>
                <tr>
                  <th>邮箱</th>
                  <th>刊期</th>
                  <th>推送时间</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((row) => (
                  <tr key={row.id}>
                    <td>{row.email}</td>
                    <td>
                      <a href={`/briefs/${row.briefId}`}>{row.issue}</a>
                    </td>
                    <td>{row.createdAt}</td>
                    <td>
                      {states[row.state] ?? row.state}
                      {row.error && <p className="form-hint">{row.error}</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!sends.length && <p className="empty-state">暂无推送记录。</p>}
        </>
      )}
      {modal === 'add' && (
        <Modal title="添加订阅" close={() => setModal(null)}>
          <form action={addSubscriberAction} className="stack-form subscription-modal-form">
            <label>
              邮箱
              <input name="email" type="email" maxLength={254} required />
            </label>
            <input type="hidden" name="kinds" value="daily" />
            <button className="solid-button">添加订阅</button>
          </form>
        </Modal>
      )}
      {modal === 'send' && (
        <Modal title="手动推送" close={() => setModal(null)}>
          <form action={manualDeliveryAction} className="stack-form subscription-modal-form">
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
            <fieldset>
              <legend>推送邮箱</legend>
              <label className="check">
                <input
                  type="checkbox"
                  disabled={!available.length}
                  checked={available.length > 0 && selected.length === available.length}
                  onChange={(e) => setSelected(e.target.checked ? available.map((r) => r.id) : [])}
                />
                全选
              </label>
              <div className="subscription-recipients">
                {available.map((row) => (
                  <label className="check" key={row.id}>
                    <input
                      type="checkbox"
                      name="subscriptionIds"
                      value={row.id}
                      checked={selected.includes(row.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, row.id]
                            : selected.filter((id) => id !== row.id),
                        )
                      }
                    />
                    {row.email}
                  </label>
                ))}
              </div>
              {!available.length && <p className="muted">暂无可推送邮箱。</p>}
            </fieldset>
            <label className="check">
              <input type="checkbox" name="force" />
              重新推送已发送或结果待确认的邮件
            </label>
            {(!deliveryEnabled || configError) && (
              <p className="form-hint">
                {!deliveryEnabled ? '推送已关闭，请先开启推送。' : configError}
              </p>
            )}
            <SendButton
              disabled={!deliveryEnabled || !!configError || !briefId || !selected.length}
              count={selected.length}
            />
          </form>
        </Modal>
      )}
    </>
  );
}
