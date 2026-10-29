import { pool } from './db.ts';
export function nextInterval(
  source: {
    intervalMinutes: number;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
    autoInterval: boolean;
    quietRuns: number;
    failureCount: number;
    stableRuns: number;
  },
  outcome: { inserted?: number; failed?: boolean },
) {
  const quiet = outcome.failed ? source.quietRuns : outcome.inserted ? 0 : source.quietRuns + 1;
  const failures = outcome.failed ? source.failureCount + 1 : 0;
  const stable = outcome.failed ? 0 : source.stableRuns + 1;
  let interval = source.intervalMinutes;
  let reason = '固定间隔';
  if (outcome.failed) {
    interval = Math.min(
      Math.max(source.maxIntervalMinutes, source.intervalMinutes),
      source.intervalMinutes * 2,
    );
    reason = `连续失败${failures}次，延长等待`;
  } else if (source.autoInterval) {
    if (quiet >= 3) {
      interval = Math.ceil(interval * 1.5);
      reason = '连续无新增，降低抓取频率';
    } else if (outcome.inserted && stable >= 3) {
      interval = Math.floor(interval * 0.8);
      reason = '持续稳定更新，逐步提高频率';
    } else reason = stable < 3 ? '观察恢复情况，暂不提频' : '保持当前节奏';
    interval = Math.max(source.minIntervalMinutes, Math.min(source.maxIntervalMinutes, interval));
  }
  return { interval: Math.max(60, interval), quiet, failures, stable, reason };
}
export async function reserveHost(host: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO source_hosts(host) VALUES($1) ON CONFLICT DO NOTHING', [host]);
    const {
      rows: [row],
    } = await client.query('SELECT * FROM source_hosts WHERE host=$1 FOR UPDATE', [host]);
    if (row.blocked_until && row.blocked_until.getTime() > Date.now()) {
      await client.query('COMMIT');
      return { blockedUntil: row.blocked_until as Date, wait: 0 };
    }
    const at = Math.max(Date.now(), row.next_request_at.getTime());
    await client.query('UPDATE source_hosts SET next_request_at=$2 WHERE host=$1', [
      host,
      new Date(at + 1500),
    ]);
    await client.query('COMMIT');
    return { blockedUntil: null, wait: Math.max(0, at - Date.now()) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
