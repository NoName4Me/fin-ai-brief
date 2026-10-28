import { createHash } from 'node:crypto';
import { pool } from './db.ts';
import { stageNames } from './task-labels.ts';
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    v instanceof Date
      ? v.toISOString()
      : Array.isArray(v)
        ? v.map(normalize)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, x]) => [k, normalize(x)]),
            )
          : v;
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
export class BudgetWait extends Error {}
export async function stage<T>(
  subject: string,
  runKey: string,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const old = await pool.query(
    "SELECT result FROM processing_steps WHERE subject=$1 AND run_key=$2 AND stage=$3 AND state='succeeded'",
    [subject, runKey, name],
  );
  if (old.rows.length) return old.rows[0].result as T;
  await pool.query(
    `INSERT INTO processing_steps(subject,run_key,stage,state) VALUES($1,$2,$3,'running')
    ON CONFLICT(subject,run_key,stage) DO UPDATE SET state='running',started_at=now(),finished_at=NULL,error=NULL`,
    [subject, runKey, name],
  );
  try {
    const result = await fn();
    await pool.query(
      "UPDATE processing_steps SET state='succeeded',finished_at=now(),result=$4 WHERE subject=$1 AND run_key=$2 AND stage=$3",
      [subject, runKey, name, JSON.stringify(result ?? null)],
    );
    return result;
  } catch (error) {
    const raw = error instanceof Error ? error.message : '处理失败';
    const annotate =
      !(error instanceof BudgetWait) && !(error instanceof Error && error.name === 'EventChanged');
    const message = annotate ? `${stageNames[name] ?? name}失败：${raw}` : raw;
    await pool.query(
      'UPDATE processing_steps SET state=$4,finished_at=now(),error=$5 WHERE subject=$1 AND run_key=$2 AND stage=$3',
      [
        subject,
        runKey,
        name,
        error instanceof BudgetWait ? 'waiting' : 'failed',
        message.slice(0, 1000),
      ],
    );
    throw annotate ? new Error(message, { cause: error }) : error;
  }
}
