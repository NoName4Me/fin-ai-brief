import { eq } from 'drizzle-orm';
import { db } from './db.ts';
import { settings } from './schema.ts';
import { defaultSettings, settingsSchema } from './types.ts';
import { getMailConnection } from './mail-config.ts';
import {
  mailConnectionSchema,
  validateMailConnection,
  type MailConnection,
} from './mail-connection.ts';
import { createMailTransport } from './mail-transport.ts';
import { mailFailure } from './mail-errors.ts';

function connectionFromForm(form: FormData, saved: MailConnection) {
  const text = (key: string) => String(form.get(key) ?? '').trim();
  return validateMailConnection({
    host: text('smtpHost'),
    port: Number(text('smtpPort')),
    security: text('smtpSecurity'),
    user: text('smtpUser'),
    password: String(form.get('smtpPassword') ?? '') || saved.password,
    from: text('mailFrom'),
  });
}
export async function saveMailSettings(form: FormData) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(eq(settings.id, 1)).for('update');
    const current = settingsSchema.parse(row?.value ?? defaultSettings);
    const saved = mailConnectionSchema.parse(current.mailConnection ?? {});
    const connection = connectionFromForm(form, saved);
    const value = settingsSchema.parse({ ...current, mailConnection: connection });
    await tx
      .insert(settings)
      .values({ id: 1, value })
      .onConflictDoUpdate({ target: settings.id, set: { value } });
  });
}
export async function testMailConnection(form: FormData, factory = createMailTransport) {
  const connection = connectionFromForm(form, await getMailConnection());
  const transport = factory(connection);
  try {
    await transport.verify();
  } catch (error) {
    throw new Error(mailFailure(error, [connection.password, connection.user]).error);
  } finally {
    transport.close();
  }
}
