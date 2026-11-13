import { pool } from './db.ts';
import { getModelConnection, modelUsage } from './model.ts';
import { modelHealthMap, type ModelHealthState } from './model-health.ts';
import { publicationCycle, localDate } from './periods.ts';
import { getSettings } from './settings.ts';

export type DisplayModelState = ModelHealthState | 'paused' | 'fallback';
export interface ManagedModel {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  state: DisplayModelState;
  lastError: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  cooldownUntil: Date | null;
}
export interface ModelActivityPoint {
  modelId: string;
  hour: string;
  label: string;
  count: number;
  failures: {
    id: number;
    at: Date;
    category: string;
    httpStatus: number | null;
    error: string;
  }[];
}
export interface ModelTimelineEvent {
  id: number;
  modelId: string | null;
  type: string;
  fromModelId: string | null;
  toModelId: string | null;
  message: string;
  createdAt: Date;
}
const hourKey = (date: Date) => date.toISOString().slice(0, 13);
const hourLabel = (date: Date) => {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
    hour12: false,
  });
  return formatter.formatToParts(date).find((part) => part.type === 'hour')?.value ?? '00';
};
function timelineMessage(
  event: {
    event_type: string;
    from_model_config_id: string | null;
    to_model_config_id: string | null;
    message: string;
  },
  modelNames: Map<string, string>,
) {
  const from = event.from_model_config_id ? modelNames.get(event.from_model_config_id) : undefined;
  const to = event.to_model_config_id ? modelNames.get(event.to_model_config_id) : undefined;
  if (!from || !to) return event.message;
  if (event.event_type === 'recovered') return `主模型 ${to} 恢复，${from} → ${to}`;
  if (event.event_type === 'fallback') {
    const prefix = `${from} `;
    const suffix = `，${from} → ${to}`;
    const reason =
      event.message.startsWith(prefix) && event.message.endsWith(suffix)
        ? event.message.slice(prefix.length, -suffix.length).trim()
        : '调用异常';
    return `${from} ${reason || '调用异常'}，${from} → ${to}`;
  }
  return event.message;
}

export async function getModelManagement(now = new Date()) {
  const [settings, health, connection, usage] = await Promise.all([
    getSettings(),
    modelHealthMap(),
    getModelConnection(),
    modelUsage(),
  ]);
  const cycle = publicationCycle(now, settings.dailyTime);
  const models: ManagedModel[] = settings.modelConnections.map((entry) => {
    const state = health.get(entry.id);
    return {
      id: entry.id,
      name: entry.name,
      enabled: entry.enabled,
      baseUrl: entry.baseUrl,
      model: entry.model,
      hasApiKey: Boolean(entry.apiKey),
      state: entry.enabled ? (state?.state ?? 'unverified') : 'paused',
      lastError: state?.lastError ?? null,
      lastSuccessAt: state?.lastSuccessAt ?? null,
      lastFailureAt: state?.lastFailureAt ?? null,
      cooldownUntil: state?.cooldownUntil ?? null,
    };
  });
  // Match the effective request order; persisted routing describes the last call
  // and may refer to a model that has since been paused, removed or demoted.
  const currentModelId =
    models.find(
      (entry) =>
        entry.enabled &&
        entry.state !== 'unavailable' &&
        (!entry.cooldownUntil || entry.cooldownUntil <= now),
    )?.id ?? null;
  const events = await pool.query<{
    id: string;
    model_config_id: string | null;
    event_type: string;
    from_model_config_id: string | null;
    to_model_config_id: string | null;
    message: string;
    created_at: Date;
  }>(
    `SELECT id,model_config_id,event_type,from_model_config_id,to_model_config_id,message,created_at
     FROM model_events WHERE created_at >= $1 AND created_at <= $2
     ORDER BY created_at DESC,id DESC LIMIT 500`,
    [cycle.start, now],
  );
  const modelNames = new Map(models.map((model) => [model.id, model.name]));
  const failures = await pool.query<{
    id: string;
    model_config_id: string;
    error_category: string | null;
    http_status: number | null;
    error: string | null;
    started_at: Date;
  }>(
    `SELECT id,model_config_id,error_category,http_status,error,started_at
     FROM model_attempts WHERE kind='call' AND state='failed'
       AND started_at >= $1 AND started_at <= $2
     ORDER BY started_at DESC,id DESC LIMIT 5000`,
    [cycle.start, now],
  );
  const stats = await pool.query<{
    model_config_id: string;
    total: number;
    failed: number;
    avg_latency: number | null;
  }>(
    `SELECT model_config_id,count(*)::int total,
       count(*) FILTER (WHERE state='failed')::int failed,
       round(avg(latency_ms))::int avg_latency
     FROM model_attempts WHERE kind='call' AND started_at >= $1 AND started_at <= $2
     GROUP BY model_config_id`,
    [cycle.start, now],
  );
  const statByModel = new Map(stats.rows.map((row) => [row.model_config_id, row]));
  const buckets: Date[] = [];
  const firstHour = new Date(cycle.start);
  firstHour.setUTCMinutes(0, 0, 0);
  for (let at = firstHour.getTime(); at <= now.getTime(); at += 3_600_000)
    buckets.push(new Date(at));
  const failureByHour = new Map<string, ModelActivityPoint['failures']>();
  for (const row of failures.rows) {
    const key = `${row.model_config_id}|${hourKey(row.started_at)}`;
    const list = failureByHour.get(key) ?? [];
    list.push({
      id: Number(row.id),
      at: row.started_at,
      category: row.error_category ?? 'unknown',
      httpStatus: row.http_status,
      error: row.error ?? '未知异常',
    });
    failureByHour.set(key, list);
  }
  const points: ModelActivityPoint[] = [];
  for (const model of models) {
    for (const bucket of buckets) {
      const list = failureByHour.get(`${model.id}|${hourKey(bucket)}`) ?? [];
      if (!list.length) continue;
      points.push({
        modelId: model.id,
        hour: bucket.toISOString(),
        label: hourLabel(bucket),
        count: list.length,
        failures: list,
      });
    }
  }
  const current = models.find((model) => model.id === currentModelId) ?? null;
  const primary = models[0] ?? null;
  const enabledModels = models.filter((model) => model.enabled);
  const usableModels = enabledModels.filter(
    (model) =>
      model.state !== 'unavailable' && (!model.cooldownUntil || model.cooldownUntil <= now),
  );
  const status: DisplayModelState =
    !settings.modelSchedulingEnabled || !enabledModels.length
      ? 'paused'
      : !usableModels.length
        ? 'unavailable'
        : current && primary && current.id !== primary.id
          ? 'fallback'
          : current?.state === 'degraded'
            ? 'degraded'
            : current?.state === 'healthy'
              ? 'healthy'
              : 'unverified';
  return {
    settings,
    cycle,
    models: models.map((model) => {
      const stat = statByModel.get(model.id);
      return {
        ...model,
        total: stat?.total ?? 0,
        failed: stat?.failed ?? 0,
        avgLatency: stat?.avg_latency ?? null,
      };
    }),
    usage,
    connectionEnabled: connection.enabled,
    status,
    currentModelId,
    primaryModelId: primary?.id ?? null,
    points,
    buckets: buckets.map((date) => ({ key: hourKey(date), label: hourLabel(date) })),
    events: events.rows.map<ModelTimelineEvent>((row) => ({
      id: Number(row.id),
      modelId: row.model_config_id,
      type: row.event_type,
      fromModelId: row.from_model_config_id,
      toModelId: row.to_model_config_id,
      message: timelineMessage(row, modelNames),
      createdAt: row.created_at,
    })),
  };
}

export function describeModelOverviewStatus(input: {
  status: DisplayModelState;
  enabledCount: number;
  usableCount: number;
  currentName?: string;
  primaryName?: string;
  primaryEnabled?: boolean;
}) {
  if (input.status === 'healthy')
    return {
      label: '主力正常',
      detail: `当前主力 ${input.currentName ?? '—'}`,
    };
  if (input.status === 'fallback')
    return {
      label: input.primaryEnabled === false ? '主力已停用，备用接管' : '主力异常，备用接管',
      detail: `备用 ${input.currentName ?? '—'} 接管，主力 ${input.primaryName ?? '—'} ${input.primaryEnabled === false ? '已停用' : '异常'}`,
    };
  if (input.status === 'unavailable')
    return {
      label: input.enabledCount > 1 ? '主备均不可用' : '主力不可用',
      detail: `已启用 ${input.enabledCount} 个模型，可用 ${input.usableCount} 个`,
    };
  if (input.status === 'degraded')
    return {
      label: '主力调用波动',
      detail: `当前主力 ${input.currentName ?? '—'} 调用波动`,
    };
  if (input.status === 'unverified')
    return {
      label: '主力待验证',
      detail: `当前模型 ${input.currentName ?? '—'} 尚未完成验证`,
    };
  if (input.status === 'paused')
    return {
      label: '模型调用已暂停',
      detail: input.enabledCount ? '自动调度已关闭' : '没有启用模型',
    };
  return { label: '状态未知', detail: '无法获取模型状态' };
}

export async function modelOverviewStatus(now = new Date()) {
  const data = await getModelManagement(now);
  const primary = data.models[0] ?? null;
  const current = data.models.find((model) => model.id === data.currentModelId) ?? null;
  const enabledModels = data.models.filter((model) => model.enabled);
  const usableModels = enabledModels.filter(
    (model) =>
      model.state !== 'unavailable' && (!model.cooldownUntil || model.cooldownUntil <= now),
  );
  return {
    date: localDate(now),
    status: data.status,
    primary,
    current,
    enabledCount: enabledModels.length,
    usableCount: usableModels.length,
    failures: data.models.reduce((total, model) => total + model.failed, 0),
    fallbacks: data.events.filter((event) => event.type === 'fallback').length,
  };
}
