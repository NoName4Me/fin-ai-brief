import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/server/db.ts';
import { migrate } from '../scripts/migrate.ts';
import { briefTokenUsage } from '../src/server/brief-token-usage.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('测试必须连接独立_test数据库');

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE model_calls CASCADE');
});
after(async () => pool.end());

test('按刊期汇总采集处理与成稿 token，并区分本期与上一期', async () => {
  const currentArticleId = randomUUID();
  const previousArticleId = randomUUID();
  try {
    for (const [id, createdAt] of [
      [currentArticleId, '2026-10-21T09:00:00Z'],
      [previousArticleId, '2026-10-20T09:00:00Z'],
    ]) {
      await pool.query(
        `INSERT INTO articles(id,title,url,excerpt,published_at,source_name,industry_id,state,created_at)
         VALUES($1,'token 测试',$2,'AI更新','2026-10-20','token 测试','ai','processed',$3)`,
        [id, `https://example.invalid/token/${id}`, createdAt],
      );
    }
    for (const [purpose, subject, input, output] of [
      ['article', `article:${currentArticleId}`, 100, 20],
      ['article', `article:${previousArticleId}`, 30, 10],
      ['brief', 'brief:daily:2026-10-22', 50, 5],
      ['brief', 'brief:daily:2026-10-21', 40, 4],
      ['brief', 'brief:daily:2026-10-20', 999, 999],
    ]) {
      await pool.query(
        `INSERT INTO model_calls(purpose,state,subject,input_tokens,output_tokens)
         VALUES($1,'succeeded',$2,$3,$4)`,
        [purpose, subject, input, output],
      );
    }
    assert.deepEqual(await briefTokenUsage('2026-10-22', '2026-10-21', '08:00'), {
      current: 175,
      previous: 84,
    });
    assert.deepEqual(await briefTokenUsage('2026-10-22', null, '08:00'), {
      current: 175,
      previous: null,
    });
  } finally {
    await pool.query('DELETE FROM articles WHERE id=ANY($1::uuid[])', [
      [currentArticleId, previousArticleId],
    ]);
  }
});
