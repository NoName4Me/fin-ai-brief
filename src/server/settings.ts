import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { settings } from './schema.ts';
import { defaultSettings, settingsSchema } from './types.ts';
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
  const value = settingsSchema.parse(input);
  await db
    .insert(settings)
    .values({ id: 1, value })
    .onConflictDoUpdate({ target: settings.id, set: { value } });
}

export async function saveEditorialConfig(input: {
  sections: unknown;
  ratingRules: unknown;
  candidateRating: number;
  highlightRating: number;
  tags: string[];
  keywords: string;
  editorialPrompt: string;
}) {
  const { sql } = await import('drizzle-orm');
  const { sources } = await import('./schema.ts');
  const { sectionRuleSchema } = await import('./editorial.ts');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
    const current = settingsSchema.parse(row?.value ?? defaultSettings);
    const incoming = sectionRuleSchema
      .array()
      .parse(input.sections)
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
    const value = settingsSchema.parse({
      ...current,
      ...input,
      sections: incoming,
      rotationsEnabled: true,
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
