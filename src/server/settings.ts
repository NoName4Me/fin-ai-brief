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
