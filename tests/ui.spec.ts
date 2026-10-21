import { test, expect } from '@playwright/test';
test('sends original text, pauses without auth, restores history and shows timeline', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: '输入消息' }).fill('保留我的原话，整理今天的预算。');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.locator('main').getByText('保留我的原话，整理今天的预算。', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('main').getByText('需要登录订阅', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator('main').getByText('保留我的原话，整理今天的预算。', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '工作记录', exact: true }).click();
  await expect(page.locator('main').getByText('用户原话', { exact: true })).toBeVisible();
  await expect(page.locator('main').getByText('任务已暂停', { exact: true })).toBeVisible();
});
test('failed sends preserve draft; retry reuses client ID and cannot duplicate message', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const ids: string[] = [];
  let first = true;
  await page.route('**/api/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    ids.push(route.request().postDataJSON().clientId);
    if (first) {
      first = false;
      await route.fetch();
      return route.abort();
    }
    return route.continue();
  });
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('网络中断也别丢失');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('网络中断也别丢失');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(input).toHaveValue('');
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  await expect(page.locator('main').getByText('网络中断也别丢失', { exact: true })).toHaveCount(1);
});
test('draft is restored and narrow layout remains usable with keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  const input = page.getByRole('textbox', { name: '输入消息' });
  await input.fill('还没有发送的想法');
  await page.reload();
  await expect(input).toHaveValue('还没有发送的想法');
  await input.press('Control+Enter');
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('switching conversations does not display a stale delayed response', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('旧会话专属文字');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('main').getByText('旧会话专属文字', { exact: true })).toBeVisible();
  await page.route('**/api/conversations/*/messages', async (route) => {
    const response = await route.fetch();
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ response }).catch(() => {});
  });
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await expect(page.locator('main').getByText('旧会话专属文字', { exact: true })).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(page.locator('main').getByText('旧会话专属文字', { exact: true })).toHaveCount(0);
});
test('test adapter displays actual completed result and coverage', async ({ page }) => {
  await page.goto('http://127.0.0.1:4319');
  await page.getByRole('textbox', { name: '输入消息' }).fill('一个小任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(
    page.locator('main').getByText('测试适配器结果：一个小任务', { exact: true }),
  ).toBeVisible();
  await expect(page.locator('main').getByText('已完成', { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.locator('main').getByText('测试适配器结果：一个小任务', { exact: true }),
  ).toBeVisible();
});
test('test adapter running task can be cancelled without a late result', async ({ page }) => {
  await page.goto('http://127.0.0.1:4319');
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.getByRole('textbox', { name: '输入消息' }).fill('长任务');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await page.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(page.locator('main').getByText('已取消', { exact: true })).toBeVisible();
  await expect(
    page.locator('main').getByText('测试适配器结果：长任务', { exact: true }),
  ).toHaveCount(0);
});

for (const transition of ['reload', 'switch'] as const) {
  test(`lost acknowledgement remains idempotent after ${transition}`, async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    const text = `恢复发送测试-${transition}`,
      ids: string[] = [];
    let first = true;
    await page.route('**/api/conversations/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      ids.push(route.request().postDataJSON().clientId);
      if (first) {
        first = false;
        await route.fetch();
        return route.abort();
      }
      return route.continue();
    });
    const input = page.getByRole('textbox', { name: '输入消息' });
    await input.fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    if (transition === 'reload') await page.reload();
    else {
      await page.getByRole('button', { name: '新建对话', exact: true }).click();
      await page.getByRole('button', { name: `切换对话：${text}`, exact: true }).click();
    }
    await expect(input).toHaveValue(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(input).toHaveValue('');
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    await expect(page.locator('main').getByText(text, { exact: true })).toHaveCount(1);
  });
}

test('choosing attachments stays local until Send and preserves original message', async ({
  page,
}) => {
  await page.goto('/');
  let uploads = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/uploads') && r.method() === 'POST') uploads++;
  });
  await page.getByLabel('添加附件').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('附件中的原始材料'),
  });
  await expect(page.getByText('notes.txt', { exact: true })).toBeVisible();
  expect(uploads).toBe(0);
  await page.getByRole('textbox', { name: '输入消息' }).fill('请整理附件');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('');
  expect(uploads).toBeGreaterThan(0);
  await page.getByRole('button', { name: '工作记录', exact: true }).click();
  await expect(page.locator('main')).toContainText('附件中的原始材料');
});

test('voice transcript is editable and never sends itself', async ({ page }) => {
  await page.route('**/api/capabilities', (r) =>
    r.fulfill({ json: { speech: true, uploads: true } }),
  );
  await page.route('**/api/voice', (r) =>
    r.fulfill({ json: { id: 'test-transcript', text: '原始转写' } }),
  );
  await page.goto('/');
  await expect(page.getByLabel('选择语音文件')).toBeEnabled();
  await page
    .getByLabel('选择语音文件')
    .setInputFiles({ name: 'voice.webm', mimeType: 'audio/webm', buffer: Buffer.from('fixture') });
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('原始转写');
  await page.getByRole('textbox', { name: '输入消息' }).fill('编辑后的转写');
  await expect(page.locator('.chat-message')).toHaveCount(0);
});

test('reload after failed attachment upload refuses to silently send without files', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByLabel('添加附件')
    .setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('file') });
  await page.getByRole('textbox', { name: '输入消息' }).fill('有附件的消息');
  await page.route('**/api/uploads', (r) => r.abort());
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('重新选择');
  await expect(page.getByRole('textbox', { name: '输入消息' })).toHaveValue('有附件的消息');
});
