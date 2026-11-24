'use strict';
/**
 * 回归：账单明细商家/备注直显 + 点击行详情弹窗接口
 *
 * 覆盖：
 *   - 列表行同时渲染商家（.txn-merchant）与备注（.note），行带 data-txn-id
 *   - GET /transactions/:id/json 返回全字段（分类/账户/成员/标签/商家/备注/附件）
 *   - 转账带 to_account_name；删除后 404
 *
 * 运行：node test/verify-txn-detail.js（需 8099 实例，run-all 自动拉起）
 */
const BASE = 'http://127.0.0.1:8099';
let cookie = '';
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}  — ${detail}`); }
}
async function req(method, p, { form, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (form || raw) h['content-type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + p, {
    method, headers: h,
    body: raw ? raw : (form ? new URLSearchParams(form).toString() : undefined),
    redirect: 'manual',
  });
  const sc = res.headers.getSetCookie?.() || [];
  if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, text: buf.toString('utf8'), json: (() => { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } })() };
}
const csrfOf = (html) => (html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1];

(async () => {
  console.log('\n=== 明细详情（HTTP 端到端 8099）===\n');
  let up = true;
  try { await fetch(BASE + '/login'); } catch { up = false; }
  if (!up) {
    console.log('  SKIP  8099 未启动。请先：PORT=8099 HOST=127.0.0.1 DATA_DIR=<repo>/data-verify node server.js');
    console.log(`\n结果：${pass} 通过 / ${fail} 失败（未运行）\n`);
    process.exit(fail ? 1 : 0);
  }

  let r = await req('GET', '/login');
  const login = await req('POST', '/login', { form: { _csrf: csrfOf(r.text), username: 'admin', password: 'admin888' } });
  check('管理员登录', login.status === 302, `HTTP ${login.status}`);

  // 从记一笔页解析分类/账户 id
  r = await req('GET', '/transactions/new');
  const catId = (r.text.match(/name="category_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  const accId = (r.text.match(/name="account_id"[\s\S]*?<option value="(\d+)"/) || [])[1];
  check('解析到分类/账户', !!catId && !!accId, `cat=${catId} acc=${accId}`);
  const csrf = csrfOf(r.text);

  // 新库默认只有一个账户：建第二个账户供转账测试
  await req('POST', '/accounts', { form: { _csrf: csrf, name: '支付宝', type: 'virtual', icon: '📱', currency: 'CNY', include_in_net: '1' } });
  r = await req('GET', '/accounts');
  const toAccId = ([...r.text.matchAll(/\/accounts\/(\d+)"/g)].map((m) => m[1]).find((x) => x !== accId));
  check('已具备两个账户', !!toAccId, `acc=${accId} to=${toAccId}`);
  const today = new Date();
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // 支出：带商家+备注+标签
  const created = await req('POST', '/transactions', { form: {
    _csrf: csrf, type: 'expense', amount: '38.50', currency: 'CNY',
    category_id: catId, account_id: accId, txn_date: d,
    merchant: '沃尔玛', note: '周末采购', tags: '生活 采购', status: 'cleared',
  }, headers: { accept: 'application/json' } });
  check('创建支出记录', created.json && created.json.ok === true, JSON.stringify(created.json || {}).slice(0, 60));
  const id = created.json && created.json.id;

  // 列表直显商家与备注
  r = await req('GET', '/transactions');
  check('列表行带 data-txn-id', r.text.includes(`data-txn-id="${id}"`), '');
  check('商家直接显示（txn-merchant）', /class="txn-merchant"[^>]*>沃尔玛</.test(r.text), '');
  check('备注同时直接显示', /class="note"[^>]*>周末采购</.test(r.text), '');

  // 详情 JSON
  r = await req('GET', `/transactions/${id}/json`);
  check('详情接口 200', r.status === 200 && r.json && r.json.ok === true, `HTTP ${r.status}`);
  const t = r.json && r.json.txn;
  check('详情含商家/备注/标签', !!t && t.merchant === '沃尔玛' && t.note === '周末采购' && /生活/.test(t.tag_names || ''), `${t && t.merchant} / ${t && t.note} / ${t && t.tag_names}`);
  check('详情含分类/账户/类型', !!t && !!t.category_name && !!t.account_name && !!t.type_label, `${t && t.category_name} / ${t && t.account_name} / ${t && t.type_label}`);
  check('详情含创建时间/收支方向', !!t && !!t.created_at && (t.is_expense === 1 || t.is_expense === true), '');
  check('详情附件字段为数组', r.json && Array.isArray(r.json.attachments), `${r.json && r.json.attachments && r.json.attachments.length} 个`);
  check('支出详情返回可退款元数据与可选账户', r.json?.can_write === true && t?.can_refund === true && Number(t?.refundable_cents) === 3850 && Array.isArray(r.json?.refund_accounts) && r.json.refund_accounts.length >= 2);

  // 转账：to_account_name 且不可退款
  const tr = await req('POST', '/transactions', { form: {
    _csrf: csrf, type: 'transfer', amount: '500', currency: 'CNY',
    account_id: accId, to_account_id: toAccId, txn_date: d, status: 'cleared',
  }, headers: { accept: 'application/json' } });
  check('创建转账', tr.json && tr.json.ok === true, '');
  r = await req('GET', `/transactions/${tr.json.id}/json`);
  check('转账详情含双账户且不可退款', r.json && r.json.txn && !!r.json.txn.to_account_name && r.json.txn.can_refund === false, r.json && r.json.txn && `${r.json.txn.account_name} → ${r.json.txn.to_account_name}`);
  const trRefund = await req('POST', `/transactions/${tr.json.id}/refund`, { form: { _csrf: csrf, _json: '1' }, headers: { accept: 'application/json' } });
  check('非支出记录拒绝一键退款 400', trRefund.status === 400 && trRefund.json?.ok === false, `HTTP ${trRefund.status}`);

  // 支出部分退款（自定义金额/时刻/渠道/备注）+ 超额拒绝 + 一键退还余款 + 重复退款拒绝 + 删除退款恢复额度
  const partialRefund = await req('POST', `/transactions/${id}/refund`, {
    form: { _csrf: csrf, _json: '1', amount: '10.00', account_id: toAccId, txn_date: d, txn_time: '14:20:05', note: '部分退货' },
    headers: { accept: 'application/json' },
  });
  check('支出部分退款成功并计算剩余可退', partialRefund.status === 200 && partialRefund.json?.ok === true && partialRefund.json.refund?.amount_cents === 1000 && partialRefund.json.refund?.remaining_cents === 2850 && partialRefund.json.refund?.fully_refunded === false);
  const partialId = partialRefund.json?.id;
  const partialDetail = await req('GET', `/transactions/${partialId}/json`);
  check('退款流水关联原支出并继承商家/分类/指定账户与时刻', partialDetail.status === 200 && partialDetail.json?.txn?.type === 'refund' && Number(partialDetail.json.txn.refund_of_id) === Number(id) && Number(partialDetail.json.txn.refund_of?.id) === Number(id) && partialDetail.json.txn.merchant === '沃尔玛' && Number(partialDetail.json.txn.category_id) === Number(catId) && Number(partialDetail.json.txn.account_id) === Number(toAccId) && partialDetail.json.txn.txn_time === '14:20:05' && partialDetail.json.txn.can_refund === false);
  const overRefund = await req('POST', `/transactions/${id}/refund`, { form: { _csrf: csrf, _json: '1', amount: '30.00' }, headers: { accept: 'application/json' } });
  check('超过剩余可退金额的退款被拒绝 400', overRefund.status === 400 && overRefund.json?.ok === false, overRefund.json?.error);
  const fullRest = await req('POST', `/transactions/${id}/refund`, { form: { _csrf: csrf, _json: '1' }, headers: { accept: 'application/json' } });
  check('一键退还剩余全部金额成功', fullRest.status === 200 && fullRest.json?.ok === true && fullRest.json.refund?.amount_cents === 2850 && fullRest.json.refund?.remaining_cents === 0 && fullRest.json.refund?.fully_refunded === true);
  const afterFull = await req('GET', `/transactions/${id}/json`);
  check('全额退款后原支出展示已退总额并禁止重复退款', afterFull.json?.txn?.refunded_cents === 3850 && afterFull.json?.txn?.refundable_cents === 0 && afterFull.json?.txn?.can_refund === false && afterFull.json?.txn?.refunds?.length === 2);
  const dupRefund = await req('POST', `/transactions/${id}/refund`, { form: { _csrf: csrf, _json: '1' }, headers: { accept: 'application/json' } });
  check('已全额退款再次一键退款被拒绝 400', dupRefund.status === 400 && dupRefund.json?.ok === false);
  r = await req('GET', '/transactions');
  check('列表行展示已退款徽标', r.text.includes('已退款'));
  await req('POST', `/transactions/${partialId}/delete`, { form: { _csrf: csrf, _json: '1' } });
  const afterDelRefund = await req('GET', `/transactions/${id}/json`);
  check('删除一笔退款后原支出恢复可退额度', afterDelRefund.json?.txn?.refunded_cents === 2850 && afterDelRefund.json?.txn?.refundable_cents === 1000 && afterDelRefund.json?.txn?.can_refund === true);
  const pend = await req('POST', '/transactions', { form: { _csrf: csrf, type: 'expense', amount: '12.00', currency: 'CNY', account_id: accId, txn_date: d, merchant: '待确认消费', status: 'pending' }, headers: { accept: 'application/json' } });
  const pendRefund = await req('POST', `/transactions/${pend.json.id}/refund`, { form: { _csrf: csrf, _json: '1' }, headers: { accept: 'application/json' } });
  check('待确认支出拒绝一键退款 400', pendRefund.status === 400 && pendRefund.json?.ok === false);
  const amountInRow=(html,tid)=>{const row=html.split(`data-txn-id="${tid}"`)[1]||'';return (row.match(/class="txn-amt[^\"]*"[^>]*>([\s\S]*?)<\/div>/)||[])[1]?.replace(/<[^>]*>/g,'').trim();};
  for(const path of ['/transactions?type=transfer','/',`/accounts/${accId}`]){const list=await req('GET',path);check('转账金额在列表实际显示 '+path,amountInRow(list.text,tr.json.id)==='500.00');}
  for(const [type,amount] of [['invest_buy','51.23'],['invest_sell','67.89']]){const saved=await req('POST','/transactions',{form:{_csrf:csrf,type,amount,currency:'CNY',account_id:accId,to_account_id:toAccId,txn_date:d,status:'cleared'},headers:{accept:'application/json'}});const list=await req('GET','/transactions?type='+type);check('中性投资交易也显示金额 '+type,amountInRow(list.text,saved.json.id)===amount);}

  // 删除后 404
  await req('POST', `/transactions/${id}/delete`, { form: { _csrf: csrf, _json: '1' } });
  r = await req('GET', `/transactions/${id}/json`);
  check('删除后详情 404', r.status === 404, `HTTP ${r.status}`);

  // 越权：不存在/他人账本 id
  r = await req('GET', '/transactions/999999/json');
  check('不存在的记录 404', r.status === 404, `HTTP ${r.status}`);

  // 批量删除：POST /bulk 不得被 POST /:id 参数路由捕获（历史 bug：id=NaN → 记录不存在）
  const bulkIds = [];
  for (let i = 1; i <= 2; i++) {
    const c = await req('POST', '/transactions', { form: {
      _csrf: csrf, type: 'expense', amount: '1.00', currency: 'CNY', account_id: accId,
      txn_date: d, note: '批量回归-' + i, status: 'cleared',
    }, headers: { accept: 'application/json' } });
    if (c.json && c.json.ok) bulkIds.push(c.json.id);
  }
  // URLSearchParams 会把数组串成 "ids=1,2" 单值，需逐个 append 成重复参数（与浏览器表单一致）
  const bulkForm = new URLSearchParams({ _csrf: csrf, action: 'delete' });
  bulkIds.forEach((id) => bulkForm.append('ids', id));
  r = await req('POST', '/transactions/bulk', { raw: bulkForm.toString() });
  check('批量删除返回跳转（未被 /:id 捕获）', r.status === 302, `HTTP ${r.status}`);
  r = await req('GET', '/transactions');
  check('批量删除后记录消失', !r.text.includes('批量回归-1') && !r.text.includes('批量回归-2'), '');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
