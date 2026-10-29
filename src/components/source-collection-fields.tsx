'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Switch } from './switch.tsx';
import type { WechatAccount } from '../modules/wechat/types.ts';

export function SourceCollectionFields({
  row,
  account,
  wechatConnected,
  wechatExpired,
}: {
  row?: {
    format: string;
    url: string | null;
    additionalUrls: string[];
    readDetails: boolean;
  };
  account?: WechatAccount;
  wechatConnected: boolean;
  wechatExpired: boolean;
}) {
  const [format, setFormat] = useState(row?.format ?? 'manual');
  const [selected, setSelected] = useState<WechatAccount | undefined>(account);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WechatAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function selectAccount(value: WechatAccount) {
    setSelected(value);
    setResults([]);
    const name = document.querySelector<HTMLInputElement>('input[name="name"]');
    const origin = document.querySelector<HTMLInputElement>('input[name="originAddress"]');
    if (name) name.value = value.nickname;
    if (origin) origin.value = value.alias || value.nickname;
  }

  async function search() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/admin/wechat/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '公众号搜索失败');
      setResults(body.accounts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公众号搜索失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="source-collection source-field-wide">
      <legend>采集方式</legend>
      <label>
        采集格式
        <select name="format" value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="manual">未知</option>
          <option value="rss">RSS / Atom</option>
          <option value="json">公开接口 / JSON</option>
          <option value="html">网页 / HTML</option>
          <option value="wechat">微信公众号</option>
        </select>
      </label>
      {format === 'wechat' ? (
        <div className="source-wechat-fields source-field-wide">
          <input type="hidden" name="readDetails" value="on" />
          {selected && (
            <>
              <input type="hidden" name="wechatFakeid" value={selected.fakeid} />
              <input type="hidden" name="wechatNickname" value={selected.nickname} />
              <input type="hidden" name="wechatAlias" value={selected.alias} />
              <input type="hidden" name="wechatAvatarUrl" value={selected.avatarUrl} />
            </>
          )}
          <div className="source-wechat-search">
            <label>
              公众号名称
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void search();
                  }
                }}
                placeholder={selected?.nickname ?? '输入名称搜索'}
              />
            </label>
            <button
              type="button"
              className="outline-button"
              disabled={busy || !query.trim() || !wechatConnected || wechatExpired}
              onClick={() => void search()}
            >
              搜索
            </button>
          </div>
          {(!wechatConnected || wechatExpired) && (
            <p className="form-hint">
              <Link href="/admin/wechat">
                {wechatExpired ? '微信登录已过期，请重新扫码' : '请先扫码连接自己的公众号'}
              </Link>
            </p>
          )}
          {selected && (
            <p className="form-hint">
              已选择：{selected.nickname}
              {selected.alias ? `（${selected.alias}）` : ''}
            </p>
          )}
          {error && <p className="notice error">{error}</p>}
          {results.length > 0 && (
            <ul className="source-wechat-results">
              {results.map((item) => (
                <li key={item.fakeid}>
                  <span>
                    {item.nickname}
                    {item.alias ? `（${item.alias}）` : ''}
                  </span>
                  <button type="button" onClick={() => selectAccount(item)}>
                    选择
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <label className="check source-detail-option">
            <Switch
              name="readDetails"
              aria-label="读取详情页"
              size="small"
              defaultChecked={row?.readDetails ?? false}
            />
            读取详情页
          </label>
          <label className="source-field-wide">
            <span>
              采集入口 <small className="muted">（多入口一行一个）</small>
            </span>
            <textarea
              aria-label="采集入口"
              name="urls"
              defaultValue={[row?.url, ...(row?.additionalUrls ?? [])].filter(Boolean).join('\n')}
              rows={3}
              maxLength={20009}
            />
          </label>
        </>
      )}
    </fieldset>
  );
}
