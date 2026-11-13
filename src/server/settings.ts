import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { settings } from './schema.ts';
import { defaultSettings, settingsSchema, type Settings } from './types.ts';
export async function getSettings() {
  const [row] = await db.select().from(settings).where(eq(settings.id, 1));
  const value = settingsSchema.parse(row?.value ?? defaultSettings);
  return {
    ...value,
    weeklyTime: value.weeklyTime ?? value.dailyTime,
    monthlyTime: value.monthlyTime ?? value.dailyTime,
  };
}
export async function saveSettings(input: unknown) {
  let normalized = input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const candidate = input as Record<string, unknown>;
    const legacy = candidate.modelConnection;
    const configured = candidate.modelConnections;
    if (legacy && typeof legacy === 'object') {
      const connection = legacy as Record<string, unknown>;
      const models = Array.isArray(configured) ? configured : [];
      const first =
        models[0] && typeof models[0] === 'object'
          ? (models[0] as Record<string, unknown>)
          : undefined;
      const differs =
        !first ||
        first.enabled !== connection.enabled ||
        first.baseUrl !== connection.baseUrl ||
        first.apiKey !== connection.apiKey ||
        first.model !== connection.model;
      if (differs)
        normalized = {
          ...candidate,
          modelConnections: [
            {
              id: first?.id ?? 'legacy-primary',
              name: first?.name ?? (String(connection.model ?? '').trim() || '主力模型'),
              ...connection,
            },
            ...models.slice(1),
          ],
          modelConnection: undefined,
        };
    }
  }
  const value = settingsSchema.parse(normalized);
  await db
    .insert(settings)
    .values({ id: 1, value })
    .onConflictDoUpdate({ target: settings.id, set: { value } });
}

export async function saveSettingsPatch(
  update: Partial<Settings> | ((current: Settings) => Partial<Settings>),
) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
    const current = settingsSchema.parse(row?.value ?? defaultSettings);
    const patch = typeof update === 'function' ? update(current) : update;
    const input = {
      ...current,
      ...patch,
    };
    if (patch.modelConnections !== undefined && patch.modelConnection === undefined)
      input.modelConnection = undefined;
    // Older callers still patch the single legacy connection. Treat that as an update
    // to the first model so they cannot silently bypass the new ordered list.
    if (patch.modelConnection !== undefined && patch.modelConnections === undefined) {
      const first = current.modelConnections[0];
      input.modelConnections = [
        {
          id: first?.id ?? 'legacy-primary',
          name: first?.name ?? patch.modelConnection.model ?? '主力模型',
          enabled: patch.modelConnection.enabled,
          baseUrl: patch.modelConnection.baseUrl,
          apiKey: patch.modelConnection.apiKey,
          model: patch.modelConnection.model,
        },
        ...current.modelConnections.slice(1),
      ];
    }
    const value = settingsSchema.parse(input);
    await tx
      .insert(settings)
      .values({ id: 1, value })
      .onConflictDoUpdate({ target: settings.id, set: { value } });
    return value;
  });
}

export async function saveEditorialConfig(input: {
  sections?: unknown;
  ratingRules?: unknown;
  candidateRating?: number;
  highlightRating?: number;
  ratingRelaxationEnabled?: boolean;
  ratingRelaxationMaxDrop?: number;
  budgetTolerancePercent?: number;
  highlightsName?: string;
  highlightsDeleted?: boolean;
  highlightsMinItems?: number;
  highlightsEnabled?: boolean;
  highlightsMaxItems?: number;
  highlightsBudget?: number;
  highlightsPrompt?: string;
  tags?: string[];
  keywords?: string;
  editorialPrompt?: string;
  reviewEnabled?: boolean;
  briefTitleMaxLength?: number;
  briefTitlePrompt?: string;
}) {
  const { sql } = await import('drizzle-orm');
  const { sources } = await import('./schema.ts');
  const { sectionRuleSchema } = await import('./editorial.ts');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
    const current = settingsSchema.parse(row?.value ?? defaultSettings);
    const incoming = sectionRuleSchema
      .array()
      .parse(input.sections ?? current.sections)
      .map((section) => {
        const previous = current.sections.find((s) => s.id === section.id);
        return {
          ...section,
          aliases: [
            ...new Set([
              ...(previous?.aliases ?? []),
              ...(previous && previous.name !== section.name ? [previous.name] : []),
            ]),
          ].filter((name) => name !== section.name),
        };
      });
    const keys = [
      'ratingRules',
      'candidateRating',
      'highlightRating',
      'ratingRelaxationEnabled',
      'ratingRelaxationMaxDrop',
      'budgetTolerancePercent',
      'highlightsName',
      'highlightsDeleted',
      'highlightsMinItems',
      'highlightsEnabled',
      'highlightsMaxItems',
      'highlightsBudget',
      'highlightsPrompt',
      'tags',
      'keywords',
      'editorialPrompt',
      'reviewEnabled',
      'briefTitleMaxLength',
      'briefTitlePrompt',
    ] as const;
    const patch = Object.fromEntries(
      keys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
    );
    const value = settingsSchema.parse({
      ...current,
      ...patch,
      sections: incoming,
      ...(input.sections !== undefined &&
      incoming.some(
        (s) =>
          s.kind === 'rotation' &&
          s.enabled &&
          !current.sections.some((old) => old.id === s.id && old.enabled),
      )
        ? { rotationsEnabled: true }
        : {}),
    });
    for (const previous of current.sections) {
      const next = value.sections.find((s) => s.id === previous.id);
      const names = [previous.name, ...previous.aliases];
      if (!next || (previous.kind === 'fixed' && next.kind !== 'fixed')) {
        const used = await tx
          .select({ name: sources.name })
          .from(sources)
          .where(
            sql`${sources.sections} ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))`,
          )
          .limit(1);
        if (used.length)
          throw new Error(`栏目「${previous.name}」仍被信源「${used[0].name}」使用，请先取消关联`);
      } else if (next.name !== previous.name) {
        await tx.execute(
          sql`UPDATE sources SET sections=(SELECT jsonb_agg(DISTINCT CASE WHEN v=ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))) THEN ${next.name} ELSE v END) FROM jsonb_array_elements_text(sections) AS v) WHERE sections ?| ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))`,
        );
      }
    }
    await tx
      .insert(settings)
      .values({ id: 1, value })
      .onConflictDoUpdate({ target: settings.id, set: { value } });
    return value;
  });
}
