import { z } from 'zod';
import { pool } from './db.ts';
import { getSettings } from './settings.ts';
import { dailyTitleRequest } from './daily-title.ts';
import { fingerprint } from './processing-log.ts';
import { modelJSON } from './model.ts';
import type { BriefContent } from './types.ts';

export async function reviseBriefTitle(id: string, target: 'draft' | 'published', title?: string) {
  z.uuid().parse(id);
  target = z.enum(['draft', 'published']).parse(target);
  const config = await getSettings();
  const before = await pool.query('SELECT draft,published FROM briefs WHERE id=$1', [id]);
  const content: BriefContent | undefined = before.rows[0]?.[target];
  if (!content) throw new Error('未找到对应版本的期刊');
  const request = dailyTitleRequest(
    {
      items: content.items,
      highlights: content.highlights ?? [],
      rotations: content.rotations ?? [],
    },
    config.briefTitleMaxLength,
    config.briefTitlePrompt,
  );
  const next =
    title === undefined
      ? await modelJSON('brief', request.system, request.input, request.schema, {
          subject: `brief-title:${id}:${target}`,
        })
      : request.schema.parse({ title });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Compare the complete snapshot so a concurrent reissue cannot receive a stale title.
    const result = await client.query(
      `UPDATE briefs SET ${target}=jsonb_set(${target},'{title}',to_jsonb($2::text)) WHERE id=$1 AND ${target}=$3::jsonb RETURNING id`,
      [id, next.title, JSON.stringify(content)],
    );
    if (!result.rowCount) throw new Error('期刊内容已变化，请重新修改标题');
    await client.query(
      `INSERT INTO processing_steps(subject,run_key,stage,state,finished_at,result) VALUES($1,$2,'title_revision','succeeded',now(),$3) ON CONFLICT(subject,run_key,stage) DO NOTHING`,
      [
        `brief-title:${id}:${target}`,
        fingerprint({ before: content.title, after: next.title, content }),
        JSON.stringify({ target, before: content.title, after: next.title }),
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return next.title;
}
