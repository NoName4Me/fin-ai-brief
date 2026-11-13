import { pool } from './db.ts';

export type ModelHealthState = 'unverified' | 'healthy' | 'degraded' | 'unavailable';
export interface ModelHealth {
  state: ModelHealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  cooldownUntil: Date | null;
  lastProbeAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
}
interface HealthRow {
  model_config_id: string;
  state: ModelHealthState;
  consecutive_failures: number;
  consecutive_successes: number;
  cooldown_until: Date | null;
  last_probe_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}
const fromRow = (row: HealthRow): ModelHealth => ({
  state: row.state,
  consecutiveFailures: row.consecutive_failures,
  consecutiveSuccesses: row.consecutive_successes,
  cooldownUntil: row.cooldown_until,
  lastProbeAt: row.last_probe_at,
  lastSuccessAt: row.last_success_at,
  lastFailureAt: row.last_failure_at,
  lastError: row.last_error,
  updatedAt: row.updated_at,
});

export async function modelHealthMap() {
  const { rows } = await pool.query<HealthRow>('SELECT * FROM model_health');
  return new Map(rows.map((row) => [row.model_config_id, fromRow(row)]));
}

export function modelFailureLabel(category: string) {
  return (
    {
      timeout: '请求超时',
      network: '网络异常',
      'server-error': '服务端错误',
      'rate-limited': '请求限流',
      auth: '认证失败',
      request: '请求失败',
      probe: '恢复探测失败',
      'connection-test': '连通测试失败',
    }[category] ?? '调用失败'
  );
}

export async function recordModelFailure(input: {
  modelId: string;
  modelName?: string;
  error: string;
  category: string;
  failedAt?: Date;
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<HealthRow>(
      'SELECT * FROM model_health WHERE model_config_id=$1 FOR UPDATE',
      [input.modelId],
    );
    const previous = rows[0];
    const failures = (previous?.consecutive_failures ?? 0) + 1;
    const unavailable = failures >= 3;
    const cooldownMinutes = Math.min(30, 5 * 2 ** Math.min(failures - 3, 3));
    const cooldownUntil = unavailable
      ? new Date((input.failedAt ?? new Date()).getTime() + cooldownMinutes * 60_000)
      : null;
    await client.query(
      `INSERT INTO model_health(
        model_config_id,state,consecutive_failures,consecutive_successes,cooldown_until,
        last_failure_at,last_error,updated_at
      ) VALUES($1,$2,$3,0,$4,$5,$6,$5)
      ON CONFLICT(model_config_id) DO UPDATE SET
        state=EXCLUDED.state,consecutive_failures=EXCLUDED.consecutive_failures,
        consecutive_successes=0,cooldown_until=EXCLUDED.cooldown_until,
        last_failure_at=EXCLUDED.last_failure_at,last_error=EXCLUDED.last_error,
        updated_at=EXCLUDED.updated_at`,
      [
        input.modelId,
        unavailable ? 'unavailable' : 'degraded',
        failures,
        cooldownUntil,
        input.failedAt ?? new Date(),
        `${input.category}: ${input.error}`.slice(0, 1000),
      ],
    );
    if (unavailable && (!previous || previous.state !== 'unavailable')) {
      await client.query(
        `INSERT INTO model_events(model_config_id,event_type,message,created_at)
         VALUES($1,'unavailable',$2,$3)`,
        [
          input.modelId,
          `${input.modelName ? `${input.modelName} ` : ''}连续 ${failures} 次${modelFailureLabel(input.category)}，进入冷却`.slice(
            0,
            1000,
          ),
          input.failedAt ?? new Date(),
        ],
      );
    }
    await client.query('COMMIT');
    return { state: unavailable ? 'unavailable' : 'degraded', failures, cooldownUntil } as const;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordModelSuccess(input: {
  modelId: string;
  succeededAt?: Date;
  probe?: boolean;
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<HealthRow>(
      'SELECT * FROM model_health WHERE model_config_id=$1 FOR UPDATE',
      [input.modelId],
    );
    const previous = rows[0];
    const at = input.succeededAt ?? new Date();
    const successes = (previous?.consecutive_successes ?? 0) + 1;
    const needsSecondProbe = input.probe && previous?.state === 'unavailable' && successes < 2;
    await client.query(
      `INSERT INTO model_health(
        model_config_id,state,consecutive_failures,consecutive_successes,cooldown_until,
        last_probe_at,last_success_at,last_error,updated_at
      ) VALUES($1,$2,0,$3,NULL,$4,$4,NULL,$4)
      ON CONFLICT(model_config_id) DO UPDATE SET
        state=EXCLUDED.state,consecutive_failures=0,
        consecutive_successes=EXCLUDED.consecutive_successes,cooldown_until=NULL,
        last_probe_at=EXCLUDED.last_probe_at,last_success_at=EXCLUDED.last_success_at,
        last_error=NULL,updated_at=EXCLUDED.updated_at`,
      [input.modelId, needsSecondProbe ? 'unavailable' : 'healthy', successes, at],
    );
    await client.query('COMMIT');
    return {
      recovered: previous?.state === 'unavailable' && !needsSecondProbe,
      remaining: needsSecondProbe ? 1 : 0,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markProbeAttempted(modelId: string, at = new Date()) {
  await pool.query(
    `INSERT INTO model_health(model_config_id,last_probe_at,updated_at) VALUES($1,$2,$2)
     ON CONFLICT(model_config_id) DO UPDATE SET last_probe_at=$2,updated_at=$2`,
    [modelId, at],
  );
}

export async function updateModelRoute(input: {
  primaryId: string;
  modelId: string;
  healthy: boolean;
  modelNames?: Record<string, string>;
  reason?: string;
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ current_model_config_id: string | null }>(
      'SELECT current_model_config_id FROM model_routing WHERE id=1 FOR UPDATE',
    );
    const previous = rows[0]?.current_model_config_id ?? null;
    await client.query(
      `INSERT INTO model_routing(id,current_model_config_id,current_model_healthy,updated_at)
       VALUES(1,$1,$2,now())
       ON CONFLICT(id) DO UPDATE SET current_model_config_id=$1,current_model_healthy=$2,updated_at=now()`,
      [input.modelId, input.healthy],
    );
    const fromModelId =
      previous && (!input.modelNames || previous in input.modelNames) ? previous : input.primaryId;
    if (fromModelId !== input.modelId) {
      const recovered = input.modelId === input.primaryId;
      const from = input.modelNames?.[fromModelId] ?? fromModelId;
      const to = input.modelNames?.[input.modelId] ?? input.modelId;
      await client.query(
        `INSERT INTO model_events(
          model_config_id,event_type,from_model_config_id,to_model_config_id,message
        ) VALUES($1,$2,$3,$1,$4)`,
        [
          input.modelId,
          recovered ? 'recovered' : 'fallback',
          fromModelId,
          recovered
            ? `主模型 ${to} 恢复，${from} → ${to}`
            : `${from} ${input.reason ?? '暂不可用'}，${from} → ${to}`,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordModelEvent(
  eventType: 'paused' | 'healthy' | 'primary-changed' | 'config-changed',
  modelId: string | null,
  message: string,
) {
  await pool.query(
    'INSERT INTO model_events(model_config_id,event_type,message) VALUES($1,$2,$3)',
    [modelId, eventType, message.slice(0, 1000)],
  );
}
