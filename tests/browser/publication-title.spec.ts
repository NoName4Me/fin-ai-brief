import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { createServer } from 'node:http';

test('全文编辑、AI候选确认、修订稿与正式版分离，手机可操作', async ({ page }) => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const before = (
    await db.query("SELECT * FROM briefs WHERE period_date='2026-10-22' AND kind='daily'")
  ).rows[0];
  const originalDraft = before.draft;
  const modelEnabled = process.env.TEST_MODEL_CALLS_ENABLED === 'true';
  let delayNext = false;
  let receivedRequest: (() => void) | undefined;
  let releaseReply: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    const input = JSON.parse(request.messages[1].content);
    const title = request.messages[0].content.includes('期刊大标题');
    const result = title
      ? { title: '香港金管局明确智能体责任' }
      : { text: '机构发布治理规则，明确人工复核责任。' };
    if (!title && !delayNext) expect(input.current).toBe('人工补充的摘要。');
    if (delayNext) {
      receivedRequest?.();
      await new Promise<void>((resolve) => (releaseReply = resolve));
      delayNext = false;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
    );
  });
  if (modelEnabled)
    await new Promise<void>((resolve) =>
      server.listen(Number(new URL(process.env.TEST_LLM_BASE_URL!).port), '127.0.0.1', resolve),
    );
  let articleId = '';
  try {
    await db.query('UPDATE briefs SET draft=NULL WHERE id=$1', [before.id]);
    articleId = (
      await db.query(
        `INSERT INTO articles(title,url,excerpt,published_at,source_name,industry_id,state) VALUES('原始材料',$1,'机构发布治理规则，明确人工复核责任。','2026-10-21T12:00:00Z','官方','ai','processed') RETURNING id`,
        [before.published.items[0].sources[0].url],
      )
    ).rows[0].id;
    await page.goto('/login');
    await page.getByLabel('管理员密码').fill(process.env.ADMIN_PASSWORD!);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.goto('/admin/publications');
    await page.getByRole('link', { name: before.published.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/briefs/${before.id}$`));
    await expect(page.locator('.edition-calendar-day')).toHaveCount(0);
    const readerTitleFont = await page
      .locator('.edition-subject h1')
      .evaluate((node) => getComputedStyle(node).fontSize);
    await page.goto('/admin/publications');
    await expect(page.getByRole('columnheader')).toHaveText([
      '出刊日期/期号',
      '标题',
      '状态',
      '操作',
    ]);
    await expect(page.getByRole('link', { name: '正式版', exact: true })).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '先重新处理资讯' })).toHaveCount(0);
    await page.getByRole('link', { name: '重新生成', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '重新生成', exact: true });
    await expect(dialog.getByRole('checkbox', { name: '先重新处理资讯' })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('link', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('要览名称', { exact: true })).toHaveCount(0);
    await expect(page.getByText('资讯1标题', { exact: true })).toHaveCount(0);
    await expect(page.getByText('要览1', { exact: true })).toHaveCount(0);
    await page.getByLabel('标题', { exact: true }).fill('金管局明确智能体责任边界');
    await page.getByLabel('资讯1摘要', { exact: true }).fill('人工补充的摘要。');
    const inputBox = await page.getByLabel('资讯1摘要', { exact: true }).boundingBox();
    const aiBox = await page
      .getByRole('button', { name: '资讯1摘要AI重写', exact: true })
      .boundingBox();
    expect(aiBox!.x).toBeGreaterThanOrEqual(inputBox!.x);
    expect(aiBox!.y).toBeGreaterThanOrEqual(inputBox!.y);
    expect(aiBox!.x + aiBox!.width).toBeLessThanOrEqual(inputBox!.x + inputBox!.width);
    expect(aiBox!.y + aiBox!.height).toBeLessThanOrEqual(inputBox!.y + inputBox!.height);
    await page.getByRole('button', { name: '资讯1摘要AI重写', exact: true }).click();
    if (modelEnabled) {
      await expect(page.getByText('AI候选', { exact: true })).toBeVisible();
      await expect(page.locator('.brief-ai-candidate')).toHaveCSS(
        'background-color',
        'rgb(255, 241, 219)',
      );
      await page.locator('.brief-ai-candidate').scrollIntoViewIfNeeded();
      await page.screenshot({ path: '.data/brief-editor-ai-candidate.png' });
      await expect(page.getByLabel('资讯1摘要', { exact: true })).toHaveValue('人工补充的摘要。');
      await page.getByRole('button', { name: '保留原文', exact: true }).click();
      await expect(page.getByText('AI候选', { exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: '资讯1摘要AI重写', exact: true }).click();
      await page.getByRole('button', { name: '替换', exact: true }).click();
      await expect(page.getByLabel('资讯1摘要', { exact: true })).toHaveValue(
        '机构发布治理规则，明确人工复核责任。',
      );
      await page.getByRole('button', { name: '标题AI重写', exact: true }).click();
      await expect(page.getByLabel('标题', { exact: true })).toHaveValue(
        '金管局明确智能体责任边界',
      );
      await page.getByRole('button', { name: '保留原文', exact: true }).click();
    } else {
      await expect(page.locator('.brief-editor').getByRole('alert')).toContainText(
        'MODEL_CALLS_ENABLED',
      );
    }
    if (modelEnabled) {
      delayNext = true;
      const received = new Promise<void>((resolve) => (receivedRequest = resolve));
      await page.getByRole('button', { name: '资讯1摘要AI重写', exact: true }).click();
      await received;
      await page.getByLabel('刊末备注', { exact: true }).fill('生成期间继续编辑');
      releaseReply?.();
      await expect(page.locator('.brief-editor').getByRole('alert')).toHaveText(
        '内容已变化，请重新生成候选',
      );
      await expect(page.getByText('AI候选', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('刊末备注', { exact: true })).toHaveValue('生成期间继续编辑');
    }
    await page.getByLabel('刊末备注', { exact: true }).fill('编辑后的刊末备注');
    await page.getByRole('button', { name: '保存修订稿', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('修订稿已保存');
    let row = (await db.query('SELECT * FROM briefs WHERE id=$1', [before.id])).rows[0];
    expect(row.published).toEqual(before.published);
    expect(row.draft.title).toBe('金管局明确智能体责任边界');
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('金管局明确智能体责任边界');
    await page.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('.brief-editor-preview .edition-calendar-day')).toHaveCount(0);
    await expect(page.locator('.brief-editor-preview .edition-calendar-compact')).toBeVisible();
    await expect(page.locator('.brief-editor-preview .edition-subject h1')).toHaveCSS(
      'font-size',
      readerTitleFont,
    );
    await page.screenshot({ path: '.data/brief-editor-preview.png' });
    await expect(
      page.getByRole('heading', { name: '金管局明确智能体责任边界', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    await page.screenshot({ path: '.data/brief-editor-mobile.png', fullPage: false });
    await page.getByRole('button', { name: '更新正式版', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('正式版已更新');
    row = (await db.query('SELECT * FROM briefs WHERE id=$1', [before.id])).rows[0];
    expect(row.draft).toBe(null);
    expect(row.published.title).toBe('金管局明确智能体责任边界');
    expect(row.published.note).toBe('编辑后的刊末备注');
    expect(row.published.items[1]).toEqual(before.published.items[1]);
    expect(row.published_at).toEqual(before.published_at);
    expect(row.issue_number).toBe(before.issue_number);
  } finally {
    releaseReply?.();
    await db.query('UPDATE briefs SET published=$2,draft=$3 WHERE id=$1', [
      before.id,
      JSON.stringify(before.published),
      originalDraft ? JSON.stringify(originalDraft) : null,
    ]);
    if (articleId) await db.query('DELETE FROM articles WHERE id=$1', [articleId]);
    await db.end();
    if (modelEnabled)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
});
