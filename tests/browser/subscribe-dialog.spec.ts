import { test, expect } from '@playwright/test';

test('订阅在当前页弹窗填写，失败保留邮箱，关闭恢复焦点', async ({ page }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: '邮箱订阅', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '订阅数智参阅' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('邮箱地址')).toBeFocused();
    await dialog.getByLabel('邮箱地址').fill('dialog-test@example.invalid');
    // 测试环境关闭发信，验证错误留在弹窗且不会跳转或丢失输入。
    await dialog.getByRole('button', { name: '发送确认邮件', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('确认邮件暂时无法发送，请稍后重试。');
    await expect(dialog.getByLabel('邮箱地址')).toHaveValue('dialog-test@example.invalid');
    await expect(page).toHaveURL(/\/$/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: `.data/subscribe-dialog-error-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});
