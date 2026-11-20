'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const harnessDir = process.env.DATA_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'homeledger-notifications-'));
process.env.DATA_DIR = tmp;
const { DatabaseSync } = require('node:sqlite');
const old = new DatabaseSync(path.join(tmp, 'homeledger.db'));
old.exec(`CREATE TABLE notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,ledger_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'info',title TEXT NOT NULL,body TEXT,link TEXT,is_read INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
  INSERT INTO notifications(user_id,title,created_at) VALUES(1,'旧提醒','2020-01-01 01:00:00');`);
old.close();
const db = require('../src/db');
const auth = require('../src/lib/auth');
const adapters = require('../src/lib/push-channels');
const push = require('../src/lib/notification-push');
const rules = require('../src/lib/notification-rules');
const { readableBody } = require('../src/lib/notification-types');
db.init();
let passed = 0;
function check(name, value, expected = true) {
  assert.deepEqual(value, expected, name);
  passed++;
  console.log('  PASS  ' + name);
}

const requests = [];
const receiver = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  requests.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
  if (req.url.startsWith('/retry') && requests.filter(item => item.path.startsWith('/retry')).length === 1) {
    res.writeHead(503); res.end('response-secret'); return;
  }
  if (req.url.startsWith('/reject')) { res.writeHead(403); res.end('response-secret'); return; }
  if (req.url.startsWith('/redirect')) { res.writeHead(302, { location: '/fake' }); res.end(); return; }
  if (req.url.startsWith('/hang')) return;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ code: req.url.endsWith('/push') ? 200 : 0 }));
});
const options = (type, url, extras = {}) => ({
  name: type, type, url, enabled: '1', all_events: '1', timeout_ms: '1200', timezone: 'UTC', ...extras,
});

async function checkHttpEndpoints() {
  if (!harnessDir || path.basename(harnessDir) !== 'data-verify-runall') return;
  const app = new DatabaseSync(path.join(harnessDir, 'homeledger.db'));
  const uid = app.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const lid = app.prepare('SELECT ledger_id FROM ledger_members WHERE user_id=? ORDER BY ledger_id LIMIT 1').get(uid).ledger_id;
  const token = 'hl_notification_test_' + crypto.randomUUID();
  app.prepare(`INSERT INTO api_tokens(user_id,ledger_id,name,token_hash,token_tail,created_at)
    VALUES(?,?,'推送回归',?,'test',?)`).run(uid, lid, crypto.createHash('sha256').update(token).digest('hex'), db.nowStr());
  const base = 'http://127.0.0.1:8099';
  async function api(subpath, body) {
    return fetch(base + '/api/open/notifications' + subpath, {
      method: body === undefined ? 'GET' : 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    });
  }
  try {
    const setting = { budget_cents: 30000, enabled: true, alert_pct: 80, scope: 'overall', timezone: 'UTC' };
    const saved = await api('/rules/daily', setting);
    check('API 保存每日预算和提示比例', (await saved.json()).daily.alert_pct, 80);
    check('API 读取日预算且附带信用卡提醒配置', (await (await api('/rules')).json()).daily.budget_cents, 30000);
    check('API 通知列表使用本人账本令牌', Array.isArray((await (await api('')).json()).notifications));
    const visitor = app.prepare("INSERT INTO users(username, password_hash, display_name, created_at) VALUES('notify_viewer','unused','访客',?)").run(db.nowStr()).lastInsertRowid;
    app.prepare("INSERT INTO ledger_members(ledger_id,user_id,role,joined_at) VALUES(?,?,'viewer',?)").run(lid, visitor, db.nowStr());
    app.prepare("UPDATE api_tokens SET user_id=? WHERE token_tail='test' AND name='推送回归'").run(visitor);
    check('只读成员不能通过 API 修改账本提醒', (await api('/rules/daily', setting)).status, 403);
  } finally { app.close(); }
}

(async () => {
  await checkHttpEndpoints();
  check('旧库通知保留且迁移为未分类，不进入推送', db.get("SELECT event_type FROM notifications WHERE title='旧提醒'").event_type, null);
  check('旧通知内部标志不出现在显示正文', readableBody('两天后扣费 |sub:5:2026-11-22'), '两天后扣费');
  const size = db.tableColumns('notifications').length;
  db.init();
  check('可重复初始化', db.tableColumns('notifications').length, size);
  check('回环和元数据地址始终拒绝', [adapters.allowedAddress('127.0.0.1', true), adapters.allowedAddress('169.254.169.254', true)], [false, false]);
  check('局域网目标需要授权', [adapters.allowedAddress('192.168.1.2', false), adapters.allowedAddress('192.168.1.2', true)], [false,true]);
  check('IPv6 映射回环被拒绝', adapters.allowedAddress('::ffff:127.0.0.1', true), false);
  const destination = (type, url, address, lan = false) => adapters.allowedDestination(type, new URL(url), address, lan);
  check('代理虚拟 IP 兼容 Turbo、Server 酱³ 与 Bark 官方 HTTPS',
    [
      destination('serverchan', 'https://sctapi.ftqq.com/', '198.18.0.244'),
      destination('serverchan', 'https://1.push.ft07.com/', '2001:2::f3'),
      destination('bark', 'https://api.day.app/', '198.18.0.246'),
    ], [true, true, true]);
  check('代理例外不放行自定义 Webhook、非官方域名、非默认端口或 HTTP',
    [
      destination('webhook', 'https://sctapi.ftqq.com/', '198.18.0.244', true),
      destination('serverchan', 'https://sctapi.ftqq.com.example.org/', '198.18.0.244', true),
      destination('serverchan', 'https://1.push.ft07.com:8443/', '198.18.0.244', true),
      destination('bark', 'http://api.day.app/', '198.18.0.244', true),
    ], [false, false, false, false]);
  check('官方域名仍不能解析到回环、链路本地或未授权私网',
    [
      destination('serverchan', 'https://sctapi.ftqq.com/', '127.0.0.1'),
      destination('serverchan', 'https://sctapi.ftqq.com/', '169.254.169.254'),
      destination('bark', 'https://api.day.app/', '192.168.1.1'),
    ], [false, false, false]);
  const encoded = adapters.buildRequest('webhook', { url: 'https://example.com/hook', method: 'GET', query: { text: '{{title}}' } },
    { title: '大 & 小' });
  check('GET 模板参数保留中文和 &', encoded.url.searchParams.get('text'), '大 & 小');
  const serverchan = adapters.buildRequest('serverchan', { key: 'sctp123tAbc' }, { title: '订阅', content: '正文' });
  check('Server 酱³ 按设备协议生成地址', serverchan.url.href, 'https://123.push.ft07.com/send/sctp123tAbc.send');
  const completeServerChan = 'https://123.push.ft07.com/send/sctp123tExample.send?channel=1';
  check('Server 酱³ 使用粘贴的完整地址，无需重复填写 SendKey',
    adapters.buildRequest('serverchan', { url: completeServerChan }, {}).url.href, completeServerChan);
  check('Server 酱³ 完整地址只包含一段 SendKey 路径',
    adapters.buildRequest('serverchan', { url: completeServerChan, key: 'sctp123tExample' }, {}).url.href, completeServerChan);
  check('Server 酱 Turbo 继续使用原官方地址',
    adapters.buildRequest('serverchan', { key: 'SCT_test123' }, {}).url.href, 'https://sctapi.ftqq.com/SCT_test123.send');
  const bark = adapters.buildRequest('bark', { key: 'device', url: 'http://bark.local:8181/custom', options: { sound: 'bell' } }, { title: '提醒' });
  check('自建 Bark 保留端口与路径，发送 JSON', [bark.url.href, JSON.parse(bark.body).sound], ['http://bark.local:8181/custom/push', 'bell']);

  const ledgerId = db.run("INSERT INTO ledgers (name,owner_id,created_at) VALUES ('测试',1,?)", db.nowStr()).lastInsertRowid;
  db.run("INSERT INTO users(id,username,password_hash,display_name,created_at) VALUES(1,'tester','unused','测试人',?)", db.nowStr());
  db.addLedgerMember(ledgerId, 1, 'owner');
  const accounts = db.run(`INSERT INTO accounts(ledger_id,name,type,created_at) VALUES(?,'日常','cash',?)`, ledgerId, db.nowStr());
  const accountId = accounts.lastInsertRowid;
  const f = new Date();
  const date = rules.localClock(f, 'UTC').date;
  function add(amount, dateStr = date, type = 'expense') {
    return require('../src/lib/txn').createTransaction(ledgerId, 1, {
      type, account_id: accountId, currency: 'CNY', amount_cents: amount, txn_date: dateStr,
    });
  }
  rules.saveDaily(ledgerId, { budget:'300', alert_pct:'80', timezone:'UTC', scope:'overall', enabled:'1' });
  add(10000);
  add(13999);
  check('当天多笔累计未达 80% 不提醒', rules.checkDaily(f), 0);
  add(1);
  check('当天累计消费恰好 80% 触发', rules.checkDaily(f), 1);
  add(9000);
  check('同日超过全部预算也保持一条', rules.checkDaily(f), 0);
  add(10000, date, 'refund');
  check('日报计算跟预算一致，单独退款不冲减', rules.dailyAmount(rules.dailyRule(ledgerId), date), 33000);
  const spendNotice = db.get("SELECT * FROM notifications WHERE event_type='daily_spend'");
  check('排队期间支出变化后，推送正文与金额变量采用当前累计',
    push.notificationValues(spendNotice, { hide_amount: 0 }).amount, '330.00');
  const category = db.get("SELECT id FROM categories WHERE ledger_id IS NULL AND kind='expense' ORDER BY id LIMIT 1");
  rules.saveDaily(ledgerId, { budget:'300', alert_pct:'80', timezone:'UTC', scope:'category', category_id:category.id, enabled:'1' });
  const categoryService = require('../src/lib/categories');
  categoryService.materialize(ledgerId);
  check('系统分类转为账本副本后日预警同步引用', rules.dailyRule(ledgerId).category_id, categoryService.resolveId(ledgerId, category.id));
  rules.saveDaily(ledgerId, { budget:'300', alert_pct:'80', timezone:'UTC', scope:'overall', enabled:'1' });
  const tomorrow = new Date(f.getTime() + 86400000);
  const tomorrowDate = rules.localClock(tomorrow, 'UTC').date;
  check('跨日使用新累计', rules.checkDaily(tomorrow), 0);
  add(24000, tomorrowDate);
  check('次日可再次触发', rules.checkDaily(tomorrow), 1);
  const subscriptions = require('../src/lib/subscriptions');
  const renewal = rules.localClock(new Date(f.getTime() + 2 * 86400000), 'UTC').date;
  db.run(`INSERT INTO subscriptions(ledger_id,name,amount_cents,next_charge_at,reminder_days,auto_renew,created_at)
    VALUES(?,'自动续费测试',1000,?,2,0,?)`, ledgerId, renewal, db.nowStr());
  check('已有订阅设提前两天，提前三天不提醒', subscriptions.checkReminders(rules.localClock(new Date(f.getTime() - 86400000), 'UTC').date), 0);
  check('不自动记账的订阅仍按设置生成续费通知', subscriptions.checkReminders(date), 1);
  check('同续费日仍只有一条原站内提前提醒', subscriptions.checkReminders(tomorrowDate), 0);

  const cardId = db.run(`INSERT INTO accounts(ledger_id,name,type,created_at) VALUES(?,'测试信用卡','credit',?)`, ledgerId, db.nowStr()).lastInsertRowid;
  const cards = require('../src/lib/finance/cards');
  const cardDay = Number(date.slice(-2));
  const inactiveDay = cardDay === 1 ? 2 : 1;
  cards.configure(ledgerId, cardId, { bill_day: inactiveDay, due_day: 1, due_month_offset: 1 });
  const card = { account_id: cardId, ledger_id: ledgerId, card_name: '测试信用卡', currency: 'CNY', remind_enabled: 1 };
  const cardRule = { timezone: 'UTC', send_time: '00:00', closing_days: 0, repayment_days: '[1]' };
  const statement = { id: 5, closing_date: date, due_date: tomorrowDate, remaining_cents: 0 };
  check('改账单日后不使用旧的未确认账期作出账提醒', rules.checkCard(card, [statement], cardRule, f), 0);
  cards.configure(ledgerId, cardId, { bill_day: cardDay });
  check('信用卡出账日期已知时可生成站内提醒', rules.checkCard(card, [statement], cardRule, f), 1);
  const closeNotice = db.get("SELECT * FROM notifications WHERE event_type='card_statement'");
  check('信用卡出账金额未知时省略金额', closeNotice.body.includes('账单金额'), false);
  check('设置了提前档位仍不会提醒已结清', db.get("SELECT COUNT(*) AS n FROM notifications WHERE event_type='card_repayment'").n, 0);
  check('信用卡待还达到提前档位才生成还款提醒', rules.checkCard(card, [{ ...statement, remaining_cents: 200 }], cardRule, f), 1);
  check('信用卡出账与还款档位分别去重', rules.checkCard(card, [{ ...statement, remaining_cents: 200 }], cardRule, f), 0);
  const lateCardId = db.run(`INSERT INTO accounts(ledger_id,name,type,created_at) VALUES(?,'深夜提醒测试信用卡','credit',?)`, ledgerId, db.nowStr()).lastInsertRowid;
  cards.configure(ledgerId, lateCardId, { bill_day: cardDay, due_day: 1, due_month_offset: 1 });
  rules.saveCard(ledgerId, lateCardId, { timezone:'UTC', send_time:'23:59', closing_days:'0' });
  await push.tick(Date.parse(date+'T23:58:45Z'));
  check('当天信用卡提醒未到设定时间', !!db.get("SELECT id FROM notifications WHERE title='信用卡出账提醒：深夜提醒测试信用卡'"), false);
  await push.tick(Date.parse(date+'T23:59:15Z'));
  check('短轮询能覆盖当天最后一分钟的信用卡提醒', !!db.get("SELECT id FROM notifications WHERE title='信用卡出账提醒：深夜提醒测试信用卡'"));
  const due = { ledgerId, eventType: 'debt', title: '借贷到期', body: '明天还款 |debt:3:' + tomorrowDate };
  auth.notify(1, due);
  auth.notify(1, due);
  check('站内同一账号与业务事件由数据库确保去重', db.get("SELECT COUNT(*) AS n FROM notifications WHERE event_type='debt'").n, 1);

  const local = Object.values(os.networkInterfaces()).flat()
    .find(i => i.family === 'IPv4' && !i.internal && adapters.allowedAddress(i.address, true) && !adapters.allowedAddress(i.address, false));
  if (!local) {
    console.log('  SKIP  当前无可绑定的私网网卡，通道 HTTP 验收未执行');
    console.log(`共 ${passed} 通过 / 0 失败`);
    return;
  }
  receiver.listen(0, local.address);
  await once(receiver, 'listening');
  const origin = 'http://' + local.address + ':' + receiver.address().port;
  process.env.HOMELEDGER_PUSH_LAN_TARGETS = origin;
  const webhook = push.saveChannel(1, null, options('webhook', origin + '/retry', {
    headers: JSON.stringify({ Authorization: 'Bearer secret-example' }),
    body: JSON.stringify({ title: '{{title}}', content: '{{content}}', amount: '{{amount}}' }),
  }));
  const second = push.saveChannel(1, null, options('bark', origin + '/bark', {
    key:'test-device-key', all_events:'0', event_types:'member_joined', hide_amount:'1',
  }));
  const third = push.saveChannel(1, null, options('serverchan', origin + '/serverchan', { key:'SCT_test123', enabled:'0' }));
  const oldMessages = requests.length;
  await push.tick();
  check('启用渠道不追发历史通知', requests.length, oldMessages);
  const result = await push.testChannel(1, third);
  check('测试可向停用渠道真实发送 Server 酱请求', result.status, 'sent');
  check('Server 酱自定义路径及表单正确', requests.at(-1).path, '/serverchan/SCT_test123.send');
  check('测试通知服务端实际收到标题', new URLSearchParams(requests.at(-1).body).get('title'), '家账簿测试通知');
  push.saveChannel(1, third, options('serverchan', origin + '/send/sctp123tExample.send', { enabled:'0' }));
  check('保存完整 Server 酱地址后真实请求成功', (await push.testChannel(1, third)).status, 'sent');
  check('真实请求路径直接使用完整 .send 地址', requests.at(-1).path, '/send/sctp123tExample.send');
  assert.throws(() => push.saveChannel(1, third, options('serverchan', '', { enabled:'0', key:'sctp321tNewKey' })), /另一个 SendKey/);
  check('完整地址含旧密钥时拒绝只改独立 SendKey，避免继续发往旧设备', true);
  const secret = db.get('SELECT config FROM push_channels WHERE id=?', webhook).config;
  check('凭据加密保存、设置数据只返回可见字段', secret.includes('secret-example') || JSON.stringify(push.settingsFor(1, ledgerId)).includes('secret-example'), false);
  assert.throws(() => push.changeChannelState(2, webhook, 'delete'), /不存在/);
  check('账号之间不共享渠道和日志', push.settingsFor(2, null).list.length, 0);
  auth.notify(1, { ledgerId, eventType: 'member_joined', title:'成员加入', body:'示例 123.45 |debt:5:2020-03-03', details:{ amountCents: 12345 } });
  await push.tick();
  const jobs = db.all("SELECT * FROM push_deliveries WHERE event_type='member_joined' ORDER BY channel_id");
  check('一个通知可同时投递两条已启用的渠道', jobs.map(x => x.status), ['pending','sent']);
  const privateMessage = requests.find(x => x.path === '/bark/push');
  check('Bark 已接收且隐私模式清除金额', JSON.parse(privateMessage.body).body, '成员加入');
  check('服务异常日志不保存原响应或敏感头', JSON.stringify(push.settingsFor(1, ledgerId).logs).includes('response-secret'), false);
  db.run('UPDATE push_deliveries SET next_ms=? WHERE id=?', Date.now()-1, jobs[0].id);
  await push.tick();
  await new Promise((resolve, reject) => execFile(process.execPath, ['-e', `require('./src/db').init();
    require('./src/lib/notification-push').tick().catch(e => { console.error(e.message); process.exitCode = 1; });`],
  { cwd: path.join(__dirname, '..') }, error => error ? reject(error) : resolve()));
  check('暂时失败有限重试，进程重启后不会再次投递成功记录', requests.filter(x => x.path === '/retry').length, 2);
  check('Webhook 正文没有内部去重码', JSON.parse(requests.filter(x => x.path === '/retry').at(-1).body).content, '示例 123.45');
  await adapters.send('webhook', {url:origin + '/get',method:'GET'}, { title:'带空格 标题' }, 1200);
  check('真实 Webhook GET 查询参数正确', new URL(origin + requests.at(-1).path).searchParams.get('title'), '带空格 标题');
  await adapters.send('webhook', {url:origin + '/form',method:'POST',bodyFormat:'form'}, { content:'表单内容' }, 1200);
  check('真实 Webhook POST 表单能解码', new URLSearchParams(requests.at(-1).body).get('content'), '表单内容');
  await adapters.send('webhook', {url:origin + '/fresh',method:'POST',body:{ amount:'{{amount}}' }},
    { amount:'100.00' }, 1200, () => ({ amount:'20.00' }));
  check('建连前更新金额，实际 HTTP 请求仍送出最新值', JSON.parse(requests.at(-1).body).amount, '20.00');
  const current = Date.now();
  const quietStart = rules.localClock(new Date(current - 3600000), 'UTC').time;
  const quietEnd = rules.localClock(new Date(current + 3600000), 'UTC').time;
  const quiet = push.saveChannel(1, null, options('webhook', origin + '/quiet', {
    all_events:'0', event_types:'goal_reached', quiet_start:quietStart, quiet_end:quietEnd,
  }));
  auth.notify(1, { ledgerId, eventType: 'goal_reached', title: '目标完成' });
  await push.tick();
  const delayed = db.get('SELECT * FROM push_deliveries WHERE channel_id=?', quiet);
  check('免打扰窗口内保持待发送，未调用渠道', [delayed.status, requests.some(x => x.path === '/quiet')], ['pending',false]);
  // 模拟达到次次轮询且已离开免打扰窗口。
  db.run('UPDATE push_channels SET quiet_start=NULL,quiet_end=NULL WHERE id=?', quiet);
  db.run('UPDATE push_deliveries SET next_ms=? WHERE id=?', Date.now()-1, delayed.id);
  await push.tick();
  check('免打扰结束后仍有效的消息完成投递', db.get('SELECT status FROM push_deliveries WHERE id=?', delayed.id).status, 'sent');
  const raceOrigin = 'http://push-race.example:' + receiver.address().port;
  process.env.HOMELEDGER_PUSH_LAN_TARGETS = origin + ',' + raceOrigin;
  const raceChannel = push.saveChannel(1, null, options('webhook', raceOrigin + '/dns-race', {
    all_events: '0', event_types: 'goal_reached',
  }));
  const dns = require('node:dns/promises');
  const lookup = dns.lookup;
  dns.lookup = async (host, lookupOptions) => {
    if (host !== 'push-race.example') return lookup(host, lookupOptions);
    push.changeChannelState(1, raceChannel, 'disable');
    return [{ address: local.address, family: 4 }];
  };
  try {
    auth.notify(1, { ledgerId, eventType:'goal_reached', title:'DNS 期间停用' });
    await push.tick();
    const raceResult = db.get('SELECT status FROM push_deliveries WHERE channel_id=?', raceChannel);
    check('DNS 解析期间停用渠道，连接前复核且无 HTTP 请求',
      [raceResult.status, requests.some(x => x.path === '/dns-race')], ['skipped',false]);
  } finally { dns.lookup = lookup; }
  check('HTTP 重定向不跟随', (await adapters.send('webhook', {url:origin + '/redirect',method:'GET'}, {}, 1200)).status, 'failed');
  check('发送后读超时记录未知而不无限重试', (await adapters.send('webhook', {url:origin + '/hang',method:'POST'}, {}, 550)).status, 'unknown');
  check('推送成功及失败均保留站内消息', db.get("SELECT COUNT(*) AS n FROM notifications WHERE event_type='member_joined'").n, 1);
  check('渠道异常后还可正常保存账目', add(100) > 0);
  console.log(`共 ${passed} 通过 / 0 失败`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (receiver.listening) {
    receiver.closeAllConnections();
    await new Promise(resolve => receiver.close(resolve));
  }
  db.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
