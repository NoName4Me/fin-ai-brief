import { getSettings, saveSettingsPatch } from './settings.ts';
import { getModelConnection, modelConfig } from './model.ts';
import { pool } from './db.ts';

const text = (form: FormData, name: string) => String(form.get(name) ?? '').trim();
export async function connectionFromForm(form: FormData) {
  const saved = await getModelConnection();
  const connection = {
    enabled: form.has('modelCallsEnabled'),
    baseUrl: text(form, 'modelBaseUrl'),
    model: text(form, 'modelName'),
    apiKey: text(form, 'modelApiKey') || saved.apiKey,
  };
  if (connection.enabled || connection.baseUrl || connection.model || connection.apiKey)
    modelConfig(connection);
  return connection;
}
export async function saveSystemSettings(form: FormData) {
  return saveSettingsPatch({
    modelConnection: await connectionFromForm(form),
    modelOffPeakOnly: form.has('modelOffPeakOnly'),
    modelDailyLimit: Number(text(form, 'modelDailyLimit')),
    retentionEnabled: form.has('retentionEnabled'),
    newsRetentionDays: Number(text(form, 'newsRetentionDays')),
    taskRetentionDays: Number(text(form, 'taskRetentionDays')),
    mailRetentionDays: Number(text(form, 'mailRetentionDays')),
  });
}
export async function testModelConnection(form: FormData, fetcher: typeof fetch = fetch) {
  const config = modelConfig(await connectionFromForm(form));
  const settings = await getSettings();
  const client = await pool.connect();
  let id: string;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(76140502)');
    const { rows } = await client.query(
      `INSERT INTO model_calls(purpose,state,model,api_attempts)
     SELECT 'connection-test','started',$1,1
     WHERE (SELECT coalesce(sum(greatest(api_attempts,1)),0) FROM model_calls
       WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai') < $2
     RETURNING id`,
      [config.model, settings.modelDailyLimit],
    );
    if (!rows.length) throw new Error('今日模型调用次数已达上限');
    id = rows[0].id;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  try {
    const response = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'test' }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`连接失败：HTTP ${response.status}`);
    const body = await response.json();
    const result = body.choices?.[0]?.message?.content;
    if (typeof result !== 'string' || !result.trim()) throw new Error('模型未返回正文');
    await pool.query(
      "UPDATE model_calls SET state='succeeded',finished_at=now(),input_tokens=$2,output_tokens=$3 WHERE id=$1",
      [id, body.usage?.prompt_tokens ?? null, body.usage?.completion_tokens ?? null],
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : '连接失败';
    await pool.query(
      "UPDATE model_calls SET state='failed',finished_at=now(),error=$2 WHERE id=$1",
      [id, message],
    );
    throw error;
  }
}
