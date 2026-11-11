'use strict';
// HTTP 回归：仪表盘真实统计、目标边界、权限与账本隔离。
if (!process.env.DATA_DIR) throw new Error('请使用隔离 DATA_DIR');
const db = require('../src/db');
const auth = require('../src/lib/auth');
const txn = require('../src/lib/txn');
let pass = 0, fail = 0, cookie = '';
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); ok ? pass++ : fail++; };
async function request(path, form) {
  const res = await fetch('http://127.0.0.1:8099' + path, { method: form ? 'POST' : 'GET', headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form) : undefined, redirect: 'manual' });
  if (res.headers.getSetCookie().length) cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  return { status: res.status, html: await res.text() };
}
async function login(username, password) {
  cookie = '';
  const { html } = await request('/login');
  const csrf = html.match(/name="_csrf"\s+value="([^"]+)"/)[1];
  return request('/login', { _csrf: csrf, username, password });
}
(async () => {
  check('未登录总览受保护', (await request('/')).status === 302);
  check('管理员登录', (await login('admin', 'admin888')).status === 302);
  let r = await request('/');
  check('总览可渲染', r.status === 200);
  check('资金流与消费同屏且无切换链接',r.html.includes('data-summary-basis="cashflow"')&&r.html.includes('data-summary-basis="consumption"')&&!r.html.includes('&basis=consumption">消费收支'));
  check('收入空状态', r.html.includes('本月还没有收入记录'));
  check('储蓄空状态', r.html.includes('为下一件期待的事存钱'));
  check('无前月基数不显示虚假环比', r.html.includes('暂无可比数据'));
  const uid = db.get("SELECT id FROM users WHERE username='admin'").id;
  const acc = db.get('SELECT id FROM accounts WHERE ledger_id=1').id;
  const salary = db.get("SELECT id FROM categories WHERE name='工资' AND kind='income'").id;
  txn.createTransaction(1, uid, { type: 'income', amount_cents: 123456, account_id: acc, category_id: salary, txn_date: db.todayStr() });
  for (const [name, target, saved] of [['边界零目标', 0, 0], ['超额目标<script>', 10000, 15000]]) {
    db.run("INSERT INTO goals (ledger_id,name,icon,target_cents,saved_cents,status,created_at) VALUES (1,?,'🎯',?,?,'active',?)", name, target, saved, db.nowStr());
  }
  r = await request('/');
  check('收入构成模块', r.html.includes('id="income-composition"'));
  check('收入金额来自统计', r.html.includes('1,234.56'));
  check('收入分类可下钻', r.html.includes('/reports?basis=consumption&amp;kind=income&amp;'));
  check('目标名转义', r.html.includes('超额目标&lt;script&gt;') && !r.html.includes('超额目标<script>'));
  check('零分母受保护', !/NaN|Infinity/.test(r.html));
  check('超额目标进度封顶', r.html.includes('100.0%'));
  check('目标显示真实已存金额', r.html.includes('150.00'));
  check('目标显示剩余金额', r.html.includes('还差'));
  for (let i = 0; i < 9; i++) {
    const cat = db.run("INSERT INTO categories(ledger_id,name,kind,icon,color,sort_order) VALUES(1,?,'income','🏷️','#0066cc',?)", '其他收入' + i, i).lastInsertRowid;
    txn.createTransaction(1, uid, { type:'income', amount_cents:1, account_id:acc, category_id:cat, txn_date:db.todayStr() });
  }
  r = await request('/');
  check('收入分类不被前六项截断', r.html.includes('其他收入8'));
  check('微小占比无负数 SVG dasharray', !/stroke-dasharray="-/.test(r.html));
  check('历史月份构成链接保留月份', (await request('/?month=2026-01')).html.includes('本月还没有收入记录'));
  const historical=await request('/?month=2020-02');
  check('两套趋势共同截至所选历史月',historical.html.split('>9月</text>').length===3&&historical.html.split('>2月</text>').length===3);
  const outsider = db.run("INSERT INTO users(username,password_hash,display_name,created_at) VALUES ('outsider',?,'其他用户',?)", auth.hashPassword('testpass123'), db.nowStr()).lastInsertRowid;
  const otherLedger = db.createDefaultLedger(outsider, '隔离');
  db.run("INSERT INTO goals(ledger_id,name,icon,target_cents,saved_cents,status,created_at) VALUES (?,'不应泄漏的目标','🎯',100,0,'active',?)", otherLedger, db.nowStr());
  check('其他账本目标不泄漏', !(await request('/')).html.includes('不应泄漏的目标'));
  const reader = db.run("INSERT INTO users(username,password_hash,display_name,created_at) VALUES ('ui_reader',?,'只读用户',?)", auth.hashPassword('testpass123'), db.nowStr()).lastInsertRowid;
  db.run("INSERT INTO ledger_members(ledger_id,user_id,role,joined_at) VALUES (1,?,'viewer',?)", reader, db.nowStr());
  await login('ui_reader', 'testpass123');
  r = await request('/');
  check('只读成员可看统计', r.status === 200 && r.html.includes('1,234.56'));
  check('只读成员无记账入口', !r.html.includes('href="/transactions/new"'));
  check('只读成员无 AI 记账入口', !r.html.includes('href="/ai"'));
  check('只读成员无流水编辑删除控件', !r.html.includes('data-del-txn='));
  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
