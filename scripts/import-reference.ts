import { readFile } from 'node:fs/promises';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '../src/server/db.ts';
import { briefs, articles, events } from '../src/server/schema.ts';
import { assignIssueNumber } from '../src/server/issue-number.ts';
import { readReferenceSnapshot } from './reference-snapshot.ts';
const content = readReferenceSnapshot(await readFile('docs/visual-reference/index.html', 'utf8'));
try {
  await db.transaction(async (tx) => {
    const fake = await tx
      .delete(articles)
      .where(
        and(
          sql`${articles.url} LIKE 'https://example.invalid/demo/%'`,
          sql`${articles.title} LIKE '【演示】%'`,
        ),
      )
      .returning({ eventId: articles.eventId });
    for (const row of fake)
      if (row.eventId) await tx.delete(events).where(eq(events.id, row.eventId));
    for (const item of content.items) {
      const ref = item.sources[0];
      const dateOnly = ref.publishedAt.length === 10;
      // 日期级资料用当天零点作为内部排序边界，精度另存，界面不把它显示成真实时刻。
      const time = new Date(dateOnly ? `${ref.publishedAt}T00:00:00+08:00` : ref.publishedAt);
      const value = {
        industryId: item.industryId,
        title: item.title,
        summary: item.summary,
        section: item.section,
        score: 0,
        occurredAt: time,
      };
      await tx
        .insert(events)
        .values({ id: item.eventId, ...value })
        .onConflictDoUpdate({ target: events.id, set: value });
      const article = {
        sourceName: ref.name,
        industryId: item.industryId,
        url: ref.url,
        title: item.title,
        excerpt: item.summary,
        publishedAt: time,
        publishedPrecision: dateOnly ? 'day' : 'time',
        state: 'processed',
        eventId: item.eventId,
      };
      await tx
        .insert(articles)
        .values(article)
        .onConflictDoUpdate({ target: articles.url, set: article });
    }
    const [issue] = await tx
      .insert(briefs)
      .values({
        kind: 'daily',
        periodDate: '2026-10-22',
        published: content,
        publishedAt: new Date(),
        generatedAt: null,
      })
      .onConflictDoUpdate({
        target: [briefs.kind, briefs.periodDate],
        set: { published: content, draft: null, publishedAt: new Date(), generatedAt: null },
      })
      .returning();
    await assignIssueNumber(tx, issue.id, 'daily', '2026-10-22');
  });
  console.log(
    '已用视觉稿 index.html 的8条真实选读替换演示资料；保留来源与时间精度；未调用模型或发送邮件。',
  );
} finally {
  await pool.end();
}
