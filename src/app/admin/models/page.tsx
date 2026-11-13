import Link from 'next/link';
import {
  Activity,
  ArrowLeftRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePlus,
  Clock3,
  FilePenLine,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { requireAdmin } from '../../../server/auth.ts';
import { getModelManagement, type ModelTimelineEvent } from '../../../server/admin-models.ts';
import { modelPolicyAction, modelRemoveAction, modelSaveAction } from '../../actions.ts';
import { Notice, type Query } from '../../../components/notice.tsx';
import { GlobalSwitch } from '../../../components/global-switch.tsx';
import { Switch } from '../../../components/switch.tsx';
import { ConfirmSubmit } from '../../../components/confirm-submit.tsx';
import { ManagedModelList } from '../../../components/managed-model-list.tsx';
import { ModelActivityChart } from '../../../components/model-activity-chart.tsx';
import { SourceManagementDialog } from '../../../components/source-management-dialog.tsx';

const one = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const clock = (date: Date | string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(date));
const automaticEvents = new Set(['fallback', 'recovered', 'unavailable', 'healthy']);
function timelinePresentation(type: string, message: string) {
  if (type === 'paused') return message.startsWith('启用') ? { Icon: Play } : { Icon: Pause };
  if (type === 'config-changed') {
    if (message.startsWith('添加')) return { Icon: Plus };
    if (message.startsWith('移除')) return { Icon: Trash2 };
    return { Icon: FilePenLine };
  }
  if (type === 'primary-changed') return { Icon: ArrowLeftRight };
  if (type === 'fallback') return { Icon: ArrowLeftRight };
  if (type === 'recovered') return { Icon: RotateCcw };
  if (type === 'unavailable') return { Icon: CircleAlert };
  if (type === 'healthy') return { Icon: CircleCheck };
  return { Icon: Circle };
}
const timelineActions = [
  '进入冷却',
  '切换主力',
  '调用异常',
  '请求超时',
  '网络异常',
  '服务端错误',
  '请求限流',
  '认证失败',
  '请求失败',
  '恢复',
  '添加',
  '启用',
  '暂停',
  '移除',
  '更新',
];
function TimelineMessage({
  event,
  modelNames,
}: {
  event: ModelTimelineEvent;
  modelNames: Map<string, string>;
}) {
  const from = event.fromModelId ? modelNames.get(event.fromModelId) : undefined;
  const to = event.toModelId ? modelNames.get(event.toModelId) : undefined;
  const message =
    event.type === 'recovered' && from && to
      ? `主模型 ${to} 恢复，${from} → ${to}`
      : event.type === 'fallback' && from && to
        ? (() => {
            const prefix = `${from} `;
            const suffix = `，${from} → ${to}`;
            const reason =
              event.message.startsWith(prefix) && event.message.endsWith(suffix)
                ? event.message.slice(prefix.length, -suffix.length).trim()
                : '调用异常';
            return `${from} ${reason || '调用异常'}，${from} → ${to}`;
          })()
        : event.message;
  const highlighted = timelineActions.find((value) => message.includes(value));
  if (!highlighted) return <span className="model-timeline-message">{message}</span>;
  const start = message.indexOf(highlighted);
  return (
    <span className="model-timeline-message">
      {message.slice(0, start)}
      <b className="timeline-action">{highlighted}</b>
      {message.slice(start + highlighted.length)}
    </span>
  );
}

export default async function ModelsPage({ searchParams }: { searchParams: Promise<Query> }) {
  await requireAdmin();
  const query = await searchParams;
  const data = await getModelManagement();
  const panel = one(query.panel);
  const logsOpen = panel === 'logs';
  const tab = one(query.tab) === 'events' ? 'events' : 'activity';
  const editId = one(query.edit);
  const editOpen = panel === 'edit' || Boolean(editId);
  const editing =
    editId && editId !== 'new' ? data.models.find((model) => model.id === editId) : undefined;
  const returnTo = logsOpen
    ? `/admin/models?${new URLSearchParams({
        panel: 'logs',
        ...(tab ? { tab } : {}),
      })}`
    : '/admin/models';
  const addModelHref = `${returnTo}${returnTo.includes('?') ? '&' : '?'}edit=new`;
  const enabledModels = data.models.filter((model) => model.enabled);
  const modelNames = new Map(data.models.map((model) => [model.id, model.name]));
  return (
    <div className="admin-model-page">
      <Notice query={query} />
      <fieldset className="model-policy-group">
        <legend>模型调用</legend>
        <GlobalSwitch
          setting="modelSchedulingEnabled"
          label="开启模型调用"
          enabled={data.settings.modelSchedulingEnabled}
          disabled={!data.models.length}
        />
        <form action={modelPolicyAction} className="stack-form model-policy-form">
          <div className="model-policy-bar">
            <label className="settings-switch-label">
              <Switch
                name="modelOffPeakOnly"
                defaultChecked={data.settings.modelOffPeakOnly}
                aria-label="模型任务仅在波谷运行"
              />
              仅在波谷处理任务
            </label>
            <label>
              每日调用上限
              <input
                type="number"
                name="modelDailyLimit"
                min={1}
                max={100000}
                defaultValue={data.settings.modelDailyLimit}
                required
              />
            </label>
            <span>
              今日已用 <strong>{data.usage.used}</strong> / {data.usage.limit}
            </span>
          </div>
          <input type="hidden" name="returnTo" value={returnTo} />
          <button className="solid-button">
            <Save className="icon" strokeWidth={1.75} aria-hidden="true" />
            保存
          </button>
        </form>
      </fieldset>

      <div className={`model-management-layout ${logsOpen ? 'has-panel' : ''}`}>
        <section className="model-list-panel" aria-label="模型列表">
          <div className={`model-list-toolbar ${logsOpen ? 'is-log-open' : ''}`}>
            <div className="model-list-actions">
              <Link className="outline-button" href={addModelHref}>
                <CirclePlus className="icon" strokeWidth={1.75} aria-hidden="true" />
                添加模型
              </Link>
              <Link
                className={`outline-button model-log-toggle ${logsOpen ? 'is-active' : ''}`}
                href={logsOpen ? '/admin/models' : '/admin/models?panel=logs&tab=activity'}
                aria-current={logsOpen ? 'page' : undefined}
              >
                <Activity className="icon" strokeWidth={1.75} aria-hidden="true" />
                运行记录
              </Link>
            </div>
          </div>
          {data.models.length ? (
            <ManagedModelList
              models={data.models.map(
                ({ id, name, enabled, model, total, failed, avgLatency }) => ({
                  id,
                  name,
                  enabled,
                  model,
                  total,
                  failed,
                  avgLatency,
                }),
              )}
              returnTo={returnTo}
            />
          ) : (
            <div className="model-empty">
              <ShieldCheck className="icon" strokeWidth={1.5} aria-hidden="true" />
              <h3>还没有模型配置</h3>
              <p>添加第一个模型后，它将成为主力模型。</p>
              <Link className="solid-button" href={addModelHref}>
                添加模型
              </Link>
            </div>
          )}
        </section>

        {logsOpen && (
          <aside className="model-side-panel model-log-panel" aria-label="运行记录">
            <div className="model-log-toolbar">
              <nav className="model-log-tabs" aria-label="运行记录视图">
                <Link
                  href="/admin/models?panel=logs&tab=activity"
                  aria-current={tab === 'activity' ? 'page' : undefined}
                >
                  异常分布
                </Link>
                <Link
                  href="/admin/models?panel=logs&tab=events"
                  aria-current={tab === 'events' ? 'page' : undefined}
                >
                  运行事件
                </Link>
              </nav>
              <Link
                className="icon-button model-log-close"
                href="/admin/models"
                aria-label="关闭运行记录"
              >
                <X className="icon" strokeWidth={1.75} aria-hidden="true" />
              </Link>
            </div>
            {tab === 'activity' ? (
              enabledModels.length ? (
                <ModelActivityChart
                  models={enabledModels.map(({ id, name }) => ({ id, name }))}
                  buckets={data.buckets}
                  points={data.points}
                />
              ) : (
                <p className="model-panel-empty">暂无启用模型</p>
              )
            ) : data.events.length ? (
              <div className="model-event-timeline">
                <div className="model-timeline-now-row">
                  <span className="model-timeline-now">现在</span>
                </div>
                <ol className="model-timeline">
                  {data.events.map((event) => {
                    const { Icon } = timelinePresentation(event.type, event.message);
                    return (
                      <li key={event.id} className={`timeline-${event.type}`}>
                        <time dateTime={event.createdAt.toISOString()}>
                          {clock(event.createdAt)}
                        </time>
                        <span className="timeline-mark" aria-hidden="true">
                          <Icon className="timeline-mark-icon" strokeWidth={2.25} />
                        </span>
                        <div className="model-timeline-copy">
                          <TimelineMessage event={event} modelNames={modelNames} />
                          <small>{automaticEvents.has(event.type) ? '自动' : '手动'}</small>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : (
              <div className="model-panel-empty">
                <Clock3 className="icon" strokeWidth={1.5} aria-hidden="true" />
                <p>本周期还没有运行事件。</p>
              </div>
            )}
          </aside>
        )}
      </div>

      <SourceManagementDialog
        key={editOpen ? `${editId ?? 'new'}:${one(query.event) ?? ''}` : 'closed'}
        open={editOpen}
        title={editing ? '编辑模型' : '添加模型'}
        closeHref={returnTo}
        className="model-edit-dialog"
      >
        {editOpen && (
          <>
            <form action={modelSaveAction} className="stack-form model-edit-form">
              {editing && <input type="hidden" name="modelId" value={editing.id} />}
              <input type="hidden" name="returnTo" value={returnTo} />
              <label>
                显示名称
                <input
                  name="modelDisplayName"
                  defaultValue={editing?.name}
                  placeholder="例如：主力 GPT / 备用 DeepSeek"
                  required
                />
              </label>
              <label>
                API 地址
                <input
                  name="modelBaseUrl"
                  type="url"
                  defaultValue={editing?.baseUrl}
                  placeholder="https://api.example.com/v1"
                  required
                />
              </label>
              <label>
                API Key
                <input
                  name="modelApiKey"
                  type="password"
                  autoComplete="new-password"
                  placeholder={editing?.hasApiKey ? '已配置，留空保留' : '填写 API Key'}
                  required={!editing?.hasApiKey}
                />
              </label>
              <label>
                模型名称
                <input name="modelName" defaultValue={editing?.model} required />
              </label>
              <button className="solid-button">保存模型</button>
            </form>
            {editing && (
              <form action={modelRemoveAction} className="model-danger-zone">
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <div>
                  <strong>移除模型配置</strong>
                  <p>历史异常与切换记录会按保留期限继续保存。</p>
                </div>
                <ConfirmSubmit
                  className="text-button danger"
                  message={`确定移除模型「${editing.name}」？`}
                >
                  <Trash2 className="icon" strokeWidth={1.75} aria-hidden="true" />
                  移除
                </ConfirmSubmit>
              </form>
            )}
          </>
        )}
      </SourceManagementDialog>
    </div>
  );
}
