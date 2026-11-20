'use strict';

module.exports = async function checkNotifications(page, base) {
  const checks = [];
  const record = (name, pass) => checks.push({ name, pass });
  const settings = base + '/settings#notifications';
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(settings);
  const panel = page.locator('[data-tab="notifications"]');
  record('手机设置可打开通知与推送', await panel.isVisible());
  const form = panel.locator('form[action="/settings/notifications/channels"]');
  await form.locator('[name="name"]').fill('手机测试渠道');
  await form.locator('[name="url"]').fill('http://127.0.0.1:5/test-sensitive-config');
  await form.getByRole('button', { name: '添加渠道' }).click();
  record('设置页真实添加并持久保存渠道', await panel.getByText('手机测试渠道', { exact: true }).isVisible());
  record('页面不回显服务地址或凭据', !(await page.content()).includes('test-sensitive-config'));
  await panel.getByRole('button', { name: '发送测试通知' }).first().click();
  record('测试按钮展示实际后端失败并记入日志', (await panel.locator('[data-push-log]').innerText()).includes('目标地址不允许访问'));
  const daily = panel.locator('form[action="/settings/notifications/daily"]');
  await daily.locator('[name="budget"]').fill('300');
  await daily.locator('[name="alert_pct"]').fill('80');
  await daily.locator('[name="enabled"]').check();
  await daily.getByRole('button', { name: '保存消费预警' }).click();
  record('当天预算和提醒比例成功保存', await daily.locator('[name="budget"]').inputValue() === '300.00'
    && await daily.locator('[name="alert_pct"]').inputValue() === '80'
    && await daily.locator('[name="enabled"]').isChecked());
  await daily.locator('[name="ledger_id"]').evaluate(field => { field.value = '0'; });
  await daily.locator('[name="budget"]').fill('400');
  await daily.getByRole('button', { name: '保存消费预警' }).click();
  record('过期账本页面无法覆盖当前账本的预警', await daily.locator('[name="budget"]').inputValue() === '300.00'
    && (await page.getByText('当前账本已切换，请刷新设置页后再保存').count()) === 1);
  for (const [width, theme] of [[390, 'dark'], [1440, 'light']]) {
    await page.goto(base + '/theme/' + theme);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(settings);
    await panel.getByText('编辑渠道', { exact: true }).first().click();
    await panel.getByText('协议、端口与请求设置', { exact: true }).first().click();
    record(`${theme} ${width}px 渠道编辑自然展开`,
      await panel.isVisible() && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  return checks;
};
