import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { migrate } from '../scripts/migrate.ts';
import { pool, db } from '../src/server/db.ts';
import { sources, events, articles } from '../src/server/schema.ts';
import { defaultSettings, settingsSchema } from '../src/server/types.ts';
import {
  getSettings,
  saveSettings,
  saveEditorialConfig,
  saveSettingsPatch,
} from '../src/server/settings.ts';
import {
  defaultRatingRules,
  defaultSections,
  ratingFor,
  normalizedRatingRules,
  assessmentFor,
  ratingInstructionsFor,
  rotationRules,
  sectionRuleSchema,
} from '../src/server/editorial.ts';
import { weeklyMaterials } from '../src/server/weekly-review.ts';
import { processArticle } from '../src/server/process.ts';
import { importArticle } from '../src/server/collect.ts';
import { generateDaily } from '../src/server/daily.ts';
import { saveSourceConfig } from '../src/server/source-config.ts';

if (!process.env.DATABASE_URL || !/_test$/.test(new URL(process.env.DATABASE_URL).pathname))
  throw new Error('必须使用独立_test数据库');
const originalFetch = globalThis.fetch;
before(migrate);
beforeEach(async () => {
  await pool.query(
    'TRUNCATE edition_runs,briefs,articles,events,sources,processing_steps,model_calls CASCADE',
  );
  await saveSettings({ ...defaultSettings, reviewEnabled: false, rotationsEnabled: false });
  process.env.MODEL_CALLS_ENABLED = 'true';
  process.env.MAIL_ENABLED = 'false';
  process.env.LLM_API_KEY = 'test';
  process.env.LLM_BASE_URL = 'http://model.invalid/v1';
  process.env.LLM_MODEL = 'test';
});
after(async () => {
  globalThis.fetch = originalFetch;
  await pool.end();
});
const scores = Object.fromEntries(
  defaultRatingRules.map((r) => [
    r.id,
    { score: r.id === 'actionability' ? 1 : 4, reason: '材料可核对' },
  ]),
);
const range = { start: new Date('2026-10-26T00:00:00Z'), end: new Date('2026-10-27T00:00:00Z') };
function reply(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    }),
  );
}
async function seed() {
  const [source] = await db
    .insert(sources)
    .values({ name: 'AI原始来源', industryId: 'ai', format: 'manual', sections: ['工具与开源'] })
    .returning();
  const [event] = await db
    .insert(events)
    .values({
      industryId: 'ai',
      section: '工具与开源',
      title: 'AI工具进展',
      summary: 'AI工具公布更新',
      score: 68,
      assessment: scores,
      occurredAt: new Date('2026-10-26T12:00:00Z'),
    })
    .returning();
  const [article] = await db
    .insert(articles)
    .values({
      sourceId: source.id,
      sourceName: source.name,
      industryId: 'ai',
      eventId: event.id,
      url: `https://example.invalid/${randomUUID()}`,
      title: 'AI工具进展',
      excerpt: 'AI工具公布更新',
      state: 'processed',
      assessment: scores,
      publishedAt: new Date('2026-10-26T12:00:00Z'),
    })
    .returning();
  await pool.query(
    'INSERT INTO event_developments(event_id,article_id,fact_hash,facts,happened_at,editorial) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',
    [
      event.id,
      article.id,
      randomUUID(),
      JSON.stringify([
        { statement: 'AI工具公布更新', evidence: 'AI工具公布更新', status: 'announced' },
      ]),
      article.publishedAt,
      JSON.stringify({
        title: event.title,
        summary: event.summary,
        section: event.section,
        score: event.score,
        assessment: scores,
        tags: [],
      }),
    ],
  );
  return { source, event, article };
}
test('暂停指标等比归一，不降低其它指标总分；缺失启用指标不能按零分计算', () => {
  assert.equal(ratingFor(scores), 3.4);
  const rules = defaultRatingRules.map((r) => ({ ...r, enabled: r.id !== 'actionability' }));
  assert.deepEqual(
    normalizedRatingRules(rules).map((r) => r.share),
    [0.375, 0.25, 0.25, 0.125],
  );
  assert.equal(ratingFor(scores, rules), 4);
  const partial = { ...scores };
  delete partial.actionability;
  assert.equal(ratingFor(partial, rules), 4);
  assert.equal(ratingFor(partial), null);
  assert.equal(assessmentFor(rules).safeParse(partial).success, true);
  assert.equal(
    settingsSchema.safeParse({
      ...defaultSettings,
      ratingRules: rules.map((r) => ({ ...r, enabled: false })),
    }).success,
    false,
  );
  assert.equal(
    settingsSchema.safeParse({ ...defaultSettings, candidateRating: 4.5, highlightRating: 4 })
      .success,
    false,
  );
});
test('旧设置合并轮动栏目一次，并保留原预算与隔周基准', () => {
  const { editorialConfigVersion, ...legacy } = defaultSettings;
  const current = settingsSchema.parse({
    ...legacy,
    sections: defaultSections.map((s) => ({ ...s, budget: 600 })),
    rotationAnchor: '2026-11-01',
    rotationsEnabled: false,
  });
  assert.equal(current.sections.length, 9);
  assert.equal(current.sections[0].budget, 600);
  assert.ok(
    current.sections
      .filter((s) => s.kind === 'rotation')
      .every((s) => !s.enabled && s.anchorDate === '2026-11-01'),
  );
  assert.deepEqual(settingsSchema.parse(current), current);
  assert.equal(
    settingsSchema.parse({
      ...legacy,
      sections: defaultSections,
      candidateRating: undefined,
      minScore: 0,
    }).candidateRating,
    1,
  );
  assert.equal(
    settingsSchema.parse({
      ...legacy,
      sections: defaultSections,
      candidateRating: undefined,
      highlightRating: undefined,
      minScore: 95,
    }).highlightRating,
    4.75,
  );
});
test('自定义轮动改名、星期、隔周和取材范围使用配置，不依赖固定名称', () => {
  const rule = sectionRuleSchema.parse({
    id: randomUUID(),
    name: '本周案例',
    kind: 'rotation',
    weekdays: [2, 4],
    intervalWeeks: 2,
    anchorDate: '2026-10-26',
    lookbackDays: 10,
    minItems: 2,
    maxItems: 4,
    budget: 700,
  });
  assert.equal(rotationRules('2026-10-27', '2026-10-26', [rule])[0].scheduled, true);
  assert.equal(rotationRules('2026-11-03', '2026-10-26', [rule])[0].scheduled, false);
  assert.equal(rotationRules('2026-10-29', '2026-10-26', [rule])[0].days, 14);
  assert.equal(rotationRules('2026-10-28', '2026-10-26', [rule])[0].scheduled, false);
});
test('栏目改名同步信源范围且旧进展仍可选；删除已关联栏目不会把信源意外变成通用', async () => {
  const { source } = await seed();
  const before = await getSettings();
  const changed = {
    ...before,
    sections: before.sections.map((s) =>
      s.name === '工具与开源' ? { ...s, name: '软件与工具' } : s,
    ),
  };
  await saveEditorialConfig(changed);
  const saved = await getSettings();
  assert.deepEqual(
    (await pool.query('SELECT sections FROM sources WHERE id=$1', [source.id])).rows[0].sections,
    ['软件与工具'],
  );
  const material = await weeklyMaterials(range, 0, 100, saved);
  assert.equal(material.selected[0].section, '软件与工具');
  await assert.rejects(
    saveEditorialConfig({
      ...saved,
      sections: saved.sections.filter((s) => s.name !== '软件与工具'),
    }),
    /仍被信源/,
  );
  assert.equal(
    (await getSettings()).sections.some((s) => s.name === '软件与工具'),
    true,
  );
  await pool.query("UPDATE sources SET sections='[]'::jsonb WHERE id=$1", [source.id]);
  await saveEditorialConfig({
    ...saved,
    sections: saved.sections.filter((s) => s.name !== '软件与工具'),
  });
  assert.equal(
    (await getSettings()).sections.some((s) => s.name === '软件与工具'),
    false,
  );
  assert.equal((await weeklyMaterials(range, 0, 100, await getSettings())).selected.length, 0);
});
test('暂停指标后按新权重重新筛选旧资讯，旧的低总分不能继续挡住入选', async () => {
  await seed();
  const settings = await getSettings();
  const updated = {
    ...settings,
    ratingRules: settings.ratingRules.map((r) => ({ ...r, enabled: r.id !== 'actionability' })),
    candidateRating: 3.8,
    highlightRating: 4,
  };
  await saveSettings(updated);
  const materials = await weeklyMaterials(range, 3.8 * 20, 100, updated);
  assert.equal(materials.selected.length, 1);
  assert.equal(materials.selected[0].score, 80);
  let modelInput: any;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    modelInput = JSON.parse(body.messages[1].content);
    return reply({
      title: 'AI工具更新',
      items: modelInput.selected.map((e: any) => ({
        eventId: e.id,
        title: '工具更新',
        summary: 'AI工具公布更新。',
      })),
      highlights: modelInput.selected.map((e: any) => ({ eventId: e.id, text: '工具更新' })),
      rotations: [],
    });
  };
  const edition = await generateDaily('2026-10-27');
  assert.equal(edition?.published?.items[0].rating, 4);
  assert.equal(edition?.published?.highlights?.[0].rating, 4);
  assert.equal(modelInput.highlightRating, 4);
  await saveSettings({ ...updated, candidateRating: 4.1, highlightRating: 4.2 });
  assert.equal(
    (await weeklyMaterials(range, 4.1 * 20, 100, await getSettings())).selected.length,
    0,
  );
  assert.equal(
    (await pool.query("SELECT published FROM briefs WHERE period_date='2026-10-27'")).rows[0]
      .published.items[0].rating,
    4,
  );
});
test('新指标描述进入处理提示词，暂停项不再要求输出，自定义栏目可采集归类', async () => {
  const settings = await getSettings();
  const custom = sectionRuleSchema.parse({
    id: randomUUID(),
    name: '工程实践',
    minItems: 1,
    maxItems: 3,
    budget: 500,
  });
  const rule = {
    id: 'engineering',
    name: '工程价值',
    description: '评估部署条件和可复用方法',
    weight: 70,
    enabled: true,
  };
  await saveSettings({
    ...settings,
    sections: [...settings.sections, custom],
    ratingRules: [...settings.ratingRules.map((r) => ({ ...r, enabled: false })), rule],
  });
  const source = await saveSourceConfig(undefined, {
    name: '工程源',
    originAddress: '',
    url: null,
    format: 'manual',
    sections: ['工程实践'],
    priority: 'P1',
    verificationStatus: 'pending',
    verificationNote: '',
    notes: '',
    intervalMinutes: 60,
    autoInterval: false,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 240,
  });
  const [article] = await importArticle({
    title: 'AI部署工具',
    url: `https://example.invalid/${randomUUID()}`,
    excerpt: '工具公布AI部署方法',
    sourceName: source.name,
    sourceId: source.id,
    publishedAt: '2026-10-26T12:00:00Z',
  });
  let prompt = '';
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    prompt = body.messages[0].content;
    return reply({
      relevant: true,
      title: 'AI部署工具',
      summary: '工具公布AI部署方法',
      section: '工程实践',
      assessment: { engineering: { score: 5, reason: '有部署方法' } },
      tags: [],
      existingEventId: null,
      scoreReason: '',
      novelty: 'new',
      needsReview: false,
      conflict: false,
      facts: [
        {
          statement: '工具公布AI部署方法',
          evidence: '工具公布AI部署方法',
          status: 'announced',
          entities: [],
        },
      ],
    });
  };
  await processArticle(article.id);
  assert.ok(prompt.includes('评估部署条件和可复用方法'));
  assert.ok(!ratingInstructionsFor([rule]).includes('actionability'));
  assert.equal(
    (
      await pool.query(
        'SELECT score,section FROM events WHERE id=(SELECT event_id FROM articles WHERE id=$1)',
        [article.id],
      )
    ).rows[0].score,
    100,
  );
});

test('新增或修改启用指标的含义时，旧评分标为待重评，不发布空白日报掩盖缺失', async () => {
  await seed();
  const settings = await getSettings();
  const added = {
    id: 'evidence',
    name: '证据质量',
    description: '可独立核对的证据强度',
    weight: 10,
    enabled: true,
  };
  await saveSettings({ ...settings, ratingRules: [...settings.ratingRules, added] });
  const materials = await weeklyMaterials(range, 0, 100, await getSettings());
  assert.equal(materials.selected.length, 0);
  assert.equal(materials.unscored, 1);
  await assert.rejects(generateDaily('2026-10-27'), /缺少当前启用指标/);
  assert.equal((await pool.query('SELECT count(*)::int n FROM model_calls')).rows[0].n, 0);
  await saveSettings({
    ...settings,
    ratingRules: settings.ratingRules.map((r) =>
      r.id === 'impact' ? { ...r, description: '新的影响面定义' } : r,
    ),
  });
  assert.equal((await weeklyMaterials(range, 0, 100, await getSettings())).unscored, 1);
});

test('新增轮动栏目按自定义排期、事件数和预算出刊，超预算不覆盖正式版', async () => {
  await seed();
  const settings = await getSettings();
  const rotation = sectionRuleSchema.parse({
    id: randomUUID(),
    name: '工程案例观察',
    kind: 'rotation',
    weekdays: [2],
    intervalWeeks: 1,
    anchorDate: '2026-10-26',
    lookbackDays: 3,
    minItems: 1,
    maxItems: 2,
    budget: 80,
    description: '只分析工程部署案例',
  });
  await saveSettings({
    ...settings,
    rotationsEnabled: true,
    sections: [
      ...settings.sections.map((s) => (s.kind === 'rotation' ? { ...s, enabled: false } : s)),
      rotation,
    ],
    ratingRules: settings.ratingRules.map((r) => ({ ...r, enabled: r.id !== 'actionability' })),
    candidateRating: 3.8,
    highlightRating: 4.5,
  });
  let tooLong = false;
  let request: any;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    request = JSON.parse(body.messages[1].content);
    return reply({
      title: 'AI工具更新',
      items: request.selected.map((e: any) => ({
        eventId: e.id,
        title: '工具更新',
        summary: 'AI工具公布更新。',
      })),
      highlights: [],
      rotations: [
        {
          name: rotation.name,
          text: tooLong ? '长'.repeat(81) : '工具公布了新的AI部署方法。',
          eventIds: request.rotationMaterials
            .find((r: any) => r.name === rotation.name)
            .events.map((e: any) => e.id),
        },
      ],
    });
  };
  const result = await generateDaily('2026-10-27');
  assert.equal(result?.published?.rotations?.[0].name, rotation.name);
  assert.equal(
    request.rotationMaterials.find((r: any) => r.name === rotation.name).description,
    rotation.description,
  );
  const current = await getSettings();
  await saveSettings({
    ...current,
    sections: current.sections.map((s) => (s.id === rotation.id ? { ...s, budget: 79 } : s)),
  });
  tooLong = true;
  await assert.rejects(generateDaily('2026-10-27'), /预算/);
  assert.equal(
    (await pool.query("SELECT published FROM briefs WHERE period_date='2026-10-27'")).rows[0]
      .published.rotations[0].text,
    '工具公布了新的AI部署方法。',
  );
});

test('分页面保存只更新本页字段，互不清空栏目、评分和运行参数', async () => {
  const original = await getSettings();
  const changedSections = original.sections.map((s, index) =>
    index === 0 ? { ...s, budget: 601 } : s,
  );
  await saveEditorialConfig({ sections: changedSections, maxItems: 25, briefTitleMaxLength: 40 });
  await saveEditorialConfig({
    ratingRules: original.ratingRules.map((r) =>
      r.id === 'actionability' ? { ...r, enabled: false } : r,
    ),
    candidateRating: 3.8,
    highlightRating: 4.6,
  });
  await saveEditorialConfig({
    tags: [],
    keywords: 'AI工程',
    editorialPrompt: '只关注AI工程',
    reviewEnabled: true,
  });
  await Promise.all([
    saveSettingsPatch({
      taskRetryLimit: 2,
      processingConcurrency: 4,
      collectionEnabled: true,
      modelDailyLimit: 200,
    }),
    saveSettingsPatch({ autoPublish: false, dailyEnabled: false, startDate: '2026-01-01' }),
  ]);
  const saved = await getSettings();
  assert.equal(saved.sections[0].budget, 601);
  assert.equal(saved.maxItems, 25);
  assert.equal(saved.briefTitleMaxLength, 40);
  assert.equal(saved.candidateRating, 3.8);
  assert.equal(saved.highlightRating, 4.6);
  assert.equal(saved.ratingRules.find((r) => r.id === 'actionability')?.enabled, false);
  assert.deepEqual(saved.tags, []);
  assert.equal(saved.keywords, 'AI工程');
  assert.equal(saved.editorialPrompt, '只关注AI工程');
  assert.equal(saved.reviewEnabled, true);
  assert.equal(saved.taskRetryLimit, 2);
  assert.equal(saved.processingConcurrency, 4);
  assert.equal(saved.collectionEnabled, true);
  assert.equal(saved.modelDailyLimit, 200);
  assert.equal(saved.autoPublish, false);
  assert.equal(saved.dailyEnabled, false);
  assert.equal(saved.rotationsEnabled, original.rotationsEnabled);
});
