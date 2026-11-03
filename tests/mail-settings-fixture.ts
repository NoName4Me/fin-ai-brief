import { mailConnectionFromEnvironment } from '../src/server/mail-connection.ts';
import { saveSettingsPatch } from '../src/server/settings.ts';

export async function syncMailSettings() {
  await saveSettingsPatch({
    deliveryEnabled: process.env.MAIL_ENABLED === 'true',
    mailConnection: mailConnectionFromEnvironment(),
  });
}
