'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { WechatAccount } from '../modules/wechat/types.ts';

type Auth = { connected: boolean; expired: boolean; nickname: string; expiresAt: string | null };
type Account = WechatAccount & {
  id: string;
  sourceId: string;
  enabled: boolean;
  intervalMinutes: number;
  lastFetchedAt: string | null;
  nextFetchAt: string | null;
  lastError: string | null;
};
type Login = { sessionId: string; qrCode: string };

const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '—';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '操作失败');
  return body as T;
}

export function WechatManager({
  initialAuth,
  initialAccounts,
}: {
  initialAuth: Auth;
  initialAccounts: Account[];
}) {
  const router = useRouter();
  const [login, setLogin] = useState<Login | null>(null);
  const [loginMessage, setLoginMessage] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WechatAccount[]>([]);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!login) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await request<{ state: string; message: string; nickname?: string }>(
          `/api/admin/wechat/login/${login.sessionId}`,
        );
        if (stopped) return;
        setLoginMessage(status.message);
        if (status.state === 'success') {
          setLogin(null);
          setNotice('公众号连接成功');
          router.refresh();
          return;
        }
        timer = setTimeout(poll, 2000);
      } catch (cause) {
        if (!stopped) {
          setError(cause instanceof Error ? cause.message : '扫码登录失败');
          setLogin(null);
        }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [login, router]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  const startLogin = () =>
    run('login', async () => {
      setResults([]);
      setLoginMessage('正在获取二维码');
      setLogin(await request<Login>('/api/admin/wechat/login', { method: 'POST' }));
      setLoginMessage('请使用微信扫描二维码');
    });

  const search = () =>
    run('search', async () => {
      const body = await request<{ accounts: WechatAccount[] }>('/api/admin/wechat/search', {
        method: 'POST',
        body: JSON.stringify({ query }),
      });
      setResults(body.accounts);
      if (!body.accounts.length) setNotice('没有找到匹配的公众号');
    });

  return (
    <>
      {notice && (
        <p className="notice success" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <section className="wechat-panel" aria-labelledby="wechat-auth-title">
        <div className="wechat-panel-heading">
          <div>
            <h2 id="wechat-auth-title">登录凭证</h2>
            <p className="form-hint">
              {initialAuth.connected
                ? `${initialAuth.nickname} · ${initialAuth.expired ? '已过期' : `有效期至 ${date(initialAuth.expiresAt)}`}`
                : '使用自己的公众号管理员微信扫码，用于查询其他公众号的公开文章'}
            </p>
          </div>
          <div className="wechat-actions">
            {initialAuth.connected && (
              <button
                disabled={busy === 'logout'}
                onClick={() =>
                  run('logout', async () => {
                    await request('/api/admin/wechat/login', { method: 'DELETE' });
                    setResults([]);
                    router.refresh();
                  })
                }
              >
                断开连接
              </button>
            )}
            <button className="solid-button" disabled={busy === 'login'} onClick={startLogin}>
              {initialAuth.connected ? '重新扫码' : '扫码登录'}
            </button>
          </div>
        </div>
        {login && (
          <div className="wechat-login">
            {/* 微信服务器实时生成的登录二维码。 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={login.qrCode} alt="微信公众号登录二维码" width={208} height={208} />
            <p role="status">{loginMessage}</p>
          </div>
        )}
      </section>

      <section className="wechat-panel" aria-labelledby="wechat-add-title">
        <h2 id="wechat-add-title">添加公众号</h2>
        <form
          className="wechat-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <label htmlFor="wechat-query">公众号名称</label>
          <input
            id="wechat-query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            required
            maxLength={100}
          />
          <button
            className="solid-button"
            disabled={busy === 'search' || !initialAuth.connected || initialAuth.expired}
          >
            搜索
          </button>
        </form>
        {results.length > 0 && (
          <ul className="wechat-results">
            {results.map((account) => (
              <li key={account.fakeid}>
                <div>
                  <strong>{account.nickname}</strong>
                  {account.alias && <span className="muted"> {account.alias}</span>}
                </div>
                <button
                  disabled={
                    busy === account.fakeid ||
                    initialAccounts.some((item) => item.fakeid === account.fakeid)
                  }
                  onClick={() =>
                    run(account.fakeid, async () => {
                      await request('/api/admin/wechat/accounts', {
                        method: 'POST',
                        body: JSON.stringify(account),
                      });
                      setNotice(`已添加 ${account.nickname}`);
                      setResults([]);
                      router.refresh();
                    })
                  }
                >
                  {initialAccounts.some((item) => item.fakeid === account.fakeid)
                    ? '已添加'
                    : '添加'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="wechat-panel" aria-labelledby="wechat-list-title">
        <h2 id="wechat-list-title">采集列表</h2>
        {initialAccounts.length ? (
          <div className="table-scroll">
            <table className="wechat-table">
              <thead>
                <tr>
                  <th>公众号</th>
                  <th>最近采集</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {initialAccounts.map((account) => (
                  <tr key={account.id} data-source-id={account.sourceId}>
                    <td>
                      <strong>{account.nickname}</strong>
                      {account.alias && <small>{account.alias}</small>}
                      {account.lastError && <p className="wechat-error">{account.lastError}</p>}
                    </td>
                    <td>
                      {date(account.lastFetchedAt)}
                      <small>每{account.intervalMinutes}分钟</small>
                    </td>
                    <td>{account.enabled ? '已启用' : '已停用'}</td>
                    <td>
                      <div className="wechat-actions">
                        <button
                          disabled={
                            !account.enabled ||
                            !initialAuth.connected ||
                            initialAuth.expired ||
                            busy === `sync-${account.id}`
                          }
                          onClick={() =>
                            run(`sync-${account.id}`, async () => {
                              await request('/api/admin/wechat/sync', {
                                method: 'POST',
                                body: JSON.stringify({ sourceId: account.sourceId }),
                              });
                              setNotice('已加入采集队列');
                            })
                          }
                        >
                          立即采集
                        </button>
                        <button
                          disabled={busy === `toggle-${account.id}`}
                          onClick={() =>
                            run(`toggle-${account.id}`, async () => {
                              await request(`/api/admin/wechat/accounts/${account.sourceId}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ enabled: !account.enabled }),
                              });
                              router.refresh();
                            })
                          }
                        >
                          {account.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          className="danger-link"
                          disabled={busy === `delete-${account.id}`}
                          onClick={() => {
                            if (!window.confirm(`确定移除 ${account.nickname}？已采集文章会保留。`))
                              return;
                            void run(`delete-${account.id}`, async () => {
                              await request(`/api/admin/wechat/accounts/${account.sourceId}`, {
                                method: 'DELETE',
                              });
                              router.refresh();
                            });
                          }}
                        >
                          移除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="form-hint">尚未添加公众号</p>
        )}
      </section>
    </>
  );
}
