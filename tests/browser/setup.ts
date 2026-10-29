import { randomUUID } from 'node:crypto';
import { migrate } from '../../scripts/migrate.ts';
import { db, pool } from '../../src/server/db.ts';
import { briefs } from '../../src/server/schema.ts';
import { saveSettings } from '../../src/server/settings.ts';
import { defaultSettings, type BriefContent } from '../../src/server/types.ts';
import { defaultSections } from '../../src/server/editorial.ts';
import { fixtureContent } from '../fixtures.ts';
export default async function setup() {
  if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
    throw new Error('界面测试必须使用独立_test数据库');
  await migrate();
  await pool.query(
    'TRUNCATE reprocessing_batches,edition_runs,processing_steps,model_calls,brief_requests,collection_runs,source_hosts,deliveries,subscriptions,briefs,articles,events,sources,login_attempts,sessions,wechat_credentials,wechat_login_sessions CASCADE',
  );
  await saveSettings({ ...defaultSettings, collectionEnabled: false });
  const base = fixtureContent();
  const content: BriefContent = {
    ...base,
    format: 'ai-daily-v1',
    title: 'AI治理与工具进展',
    overview: {},
    items: base.items.slice(0, 6).map((i, index) => ({
      ...i,
      eventId: randomUUID(),
      industryId: 'ai',
      section: defaultSections[index].name,
      rating: index === 0 ? 4.3 : 4,
      tags: ['金融'],
    })),
    highlights: [],
    rotations: [],
  };
  content.highlights = [
    { eventId: content.items[0].eventId, text: 'AI治理与工具进展', rating: 4.3 },
  ];
  await db.insert(briefs).values({
    kind: 'daily',
    periodDate: '2026-10-22',
    issueNumber: 1,
    published: content,
    publishedAt: new Date(),
  });
  await pool.query(
    "INSERT INTO edition_runs(period_date,section,status,candidate_count,selected_count,reason) VALUES('2026-10-22','政策与监管','published',2,1,'按评分与篇幅采用'),('2026-10-22','一周观察','unscheduled',0,0,'本期未排期')",
  );
  await pool.end();
}
