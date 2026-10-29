import { requireAdmin } from '../../../server/auth.ts';
import { getWechatAuthStatus, listWechatAccounts } from '../../../server/wechat.ts';
import { getSettings } from '../../../server/settings.ts';
import { GlobalSwitch } from '../../../components/global-switch.tsx';
import { WechatManager } from '../../../components/wechat-manager.tsx';

export const metadata = { title: '公众号采集' };

export default async function WechatPage() {
  await requireAdmin();
  const [auth, accounts, settings] = await Promise.all([
    getWechatAuthStatus(),
    listWechatAccounts(),
    getSettings(),
  ]);
  return (
    <div className="wechat-page">
      <div className="source-toolbar">
        <p className="form-hint">{accounts.length}个公众号 · 采集间隔由各信源设置控制</p>
        <div className="source-toolbar-actions">
          <GlobalSwitch
            setting="collectionEnabled"
            label="自动采集"
            enabled={settings.collectionEnabled}
          />
        </div>
      </div>
      <WechatManager initialAuth={auth} initialAccounts={accounts} />
    </div>
  );
}
