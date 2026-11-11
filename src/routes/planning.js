'use strict';
/** 预算 / 定期记账 / 借钱台账 / 储蓄目标 */
const express = require('express');
const { all, get, run, tx, nowStr, todayStr } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const sch = require('../lib/scheduler');
const forecast = require('../lib/forecast');

const router = express.Router();

/* ---------------------------------- 预算 ---------------------------------- */

/** 预算智能建议（P6）：表单选好口径后按近 6 个完整自然月的月均给建议区间。只读，纯统计。 */
router.get('/api/budgets/suggest', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.status(400).json({ ok: false, error: '没有账本' });
  const ledgerId = Number(ledger.id);
  const scope = ['overall', 'category', 'account'].includes(req.query.scope) ? req.query.scope : 'overall';
  const categoryId = validCategoryId(ledgerId, req.query.category_id);
  const accountId = validAccountId(ledgerId, req.query.account_id);
  // 分类/账户口径必须带有效 id：没选就不给建议（不冒充总口径），选了但非法（跨账本/垃圾值）直接 400
  if (scope === 'category') {
    if (!req.query.category_id) return res.json({ ok: true, suggestion: { enough: false, months_covered: 0 } });
    if (!categoryId) return res.status(400).json({ ok: false, error: '分类不存在或已归档' });
  }
  if (scope === 'account') {
    if (!req.query.account_id) return res.json({ ok: true, suggestion: { enough: false, months_covered: 0 } });
    if (!accountId) return res.status(400).json({ ok: false, error: '账户不存在或已归档' });
  }
  res.json({
    ok: true,
    suggestion: sch.budgetSuggestion({
      ledger_id: ledgerId,
      scope,
      category_id: categoryId,
      account_id: accountId,
      trigger_type: req.query.trigger_type === 'income' ? 'income' : 'expense',
    }),
  });
});

router.get('/budgets', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const budgets = all(
    `SELECT b.*, c.name AS category_name, c.icon AS category_icon, c.parent_id AS category_parent_id, a.name AS account_name
     FROM budgets b LEFT JOIN categories c ON c.id = b.category_id LEFT JOIN accounts a ON a.id = b.account_id
     WHERE b.ledger_id = ? ORDER BY b.is_active DESC, b.id`,
    ledgerId
  ).map((b) => {
    const range = sch.budgetPeriodRange(b, new Date());
    const used = sch.budgetUsedInRange(b, range.start, range.end);
    const amount = Number(b.amount_cents);
    // 大分类（parent_id 为空）预算统计该分类及其全部子分类，标注出来避免误解口径
    const catLabel = b.scope === 'category'
      ? `分类 · ${b.category_name || '未指定'}${b.category_parent_id === null ? '（整个大分类）' : ''}`
      : null;
    return {
      ...b, used, rangeLabel: range.label,
      ratio: amount > 0 ? (used / amount) * 100 : 0,
      remain: amount - used,
      dailyAllowance: Math.max(0, Math.round((amount - used) / Math.max(1, remainingDays(b, range)))),
      // P7 月末预测：仅启用中的月度支出口径预算（budgetForecast 内部还会按已超支等场景降级）
      forecast: b.is_active ? forecast.budgetForecast(b, new Date()) : null,
      scopeLabel: b.scope === 'overall' ? '总预算' : catLabel || `账户 · ${b.account_name || '未指定'}`,
      periodLabel: { monthly: '每月', yearly: '每年', weekly: '每周', custom: '自定义' }[b.period] || '每月',
    };
  });
  const month = todayStr().slice(0, 7);
  const overall = txn.summary(ledgerId, `${month}-01`, `${month}-31`);
  const totalBudget = budgets.filter((b) => b.is_active && b.scope === 'overall').reduce((s, b) => s + Number(b.amount_cents), 0);
  res.render('budgets', {
    title: '预算管理', activeNav: 'budgets', budgets, form: fd.txFormData(ledgerId, req.session.userId),
    overall, totalBudget, month,
  });
});

function remainingDays(b, range) {
  const today = todayStr();
  if (today < range.start) return 30;
  if (today > range.end) return 1;
  const d1 = new Date(`${today}T00:00:00`);
  const d2 = new Date(`${range.end}T00:00:00`);
  return Math.max(1, Math.round((d2 - d1) / 86400000) + 1);
}

/** 分类须为系统分类或本账本自建（防跨账本/已停用 id 混入预算） */
function validCategoryId(ledgerId, rawId) {
  if (!rawId) return null;
  const c = require('../lib/categories').find(ledgerId, rawId, true);
  return c ? Number(c.id) : null;
}
function validAccountId(ledgerId, rawId) {
  if (!rawId) return null;
  const a = get('SELECT id FROM accounts WHERE id = ? AND ledger_id = ? AND is_archived = 0', Number(rawId), ledgerId);
  return a ? Number(a.id) : null;
}

router.post('/budgets', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  const amount = u.parseAmountToCents(req.body.amount);
  if (!name || !amount) { res.flash('error', '请填写预算名称与金额'); return res.redirect('/budgets'); }
  const scope = ['overall', 'category', 'account'].includes(req.body.scope) ? req.body.scope : 'overall';
  const categoryId = scope === 'category' ? validCategoryId(ledgerId,req.body.category_id) : null;
  if(scope === 'category' && !categoryId){res.flash('error','请选择有效分类，已删除分类不能用于新预算');return res.redirect('/budgets');}
  run(
    `INSERT INTO budgets (ledger_id, name, scope, category_id, account_id, period, amount_cents, currency,
      trigger_type, rollover, alert_pct, start_date, end_date, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 30), scope,
    categoryId,
    scope === 'account' ? validAccountId(ledgerId, req.body.account_id) : null,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(req.body.period) ? req.body.period : 'monthly',
    amount, req.body.currency || 'CNY',
    req.body.trigger_type === 'income' ? 'income' : 'expense',
    req.body.rollover ? 1 : 0,
    Number(req.body.alert_pct) || 80,
    req.body.start_date || null, req.body.end_date || null, nowStr()
  );
  auth.audit(req, 'budget.create', { entity: 'budget', ledgerId, detail: name });
  res.flash('success', `预算「${name}」已创建`);
  res.redirect('/budgets');
});

router.post('/budgets/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const b = get('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', id, ledgerId);
  if (!b) { res.flash('error', '预算不存在'); return res.redirect('/budgets'); }
  const effScope = ['overall', 'category', 'account'].includes(req.body.scope) ? req.body.scope : b.scope;
  const categoryId = effScope === 'category' ? (require('../lib/categories').forUpdate(ledgerId,req.body.category_id === undefined ? b.category_id : req.body.category_id,b.scope==='category'?b.category_id:null)?.id || null) : null;
  if(effScope === 'category' && !categoryId){res.flash('error','请选择有效分类，预算未修改');return res.redirect('/budgets');}
  run(
    `UPDATE budgets SET name=?, scope=?, category_id=?, account_id=?, period=?, amount_cents=?, trigger_type=?,
      rollover=?, alert_pct=?, start_date=?, end_date=?, is_active=? WHERE id=?`,
    String(req.body.name || b.name).slice(0, 30),
    effScope,
    categoryId,
    effScope === 'account' ? validAccountId(ledgerId, req.body.account_id) : null,
    ['monthly', 'yearly', 'weekly', 'custom'].includes(req.body.period) ? req.body.period : b.period,
    req.body.amount ? u.parseAmountToCents(req.body.amount) : Number(b.amount_cents),
    req.body.trigger_type === 'income' ? 'income' : 'expense',
    req.body.rollover ? 1 : 0,
    Number(req.body.alert_pct) || Number(b.alert_pct),
    req.body.start_date || null, req.body.end_date || null,
    req.body.is_active ? 1 : 0, id
  );
  res.flash('success', '预算已更新');
  res.redirect('/budgets');
});

router.post('/budgets/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM budgets WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '预算已删除');
  res.redirect('/budgets');
});

router.post('/budgets/:id/toggle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const b = get('SELECT * FROM budgets WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (b) run('UPDATE budgets SET is_active = ? WHERE id = ?', b.is_active ? 0 : 1, b.id);
  res.redirect('/budgets');
});

/* -------------------------------- 定期记账 -------------------------------- */

router.get('/recurring', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const rules = all(
    `SELECT r.*, (SELECT COUNT(*) FROM recurring_runs rr WHERE rr.ledger_id=r.ledger_id AND rr.rule_id=r.id) AS posted
     FROM recurring_rules r WHERE r.ledger_id = ? ORDER BY r.is_active DESC, r.next_run_at`,
    ledgerId
  ).map((r) => {
    const items = sch.ruleItems(r.payload);
    const cats = fd.flatCategories(ledgerId);
    const accs = fd.accounts(ledgerId);
    const total = items.reduce((s, i) => s + Number(i.amount_cents || 0), 0);
    return {
      ...r, items, total,
      freqLabel: { daily: '每天', weekly: '每周', monthly: '每月', yearly: '每年' }[r.frequency] || '每月',
      itemLabels: items.map((i) => ({
        ...i,
        category_path: cats.find((c) => Number(c.id) === Number(i.category_id))?.path || '未分类',
        account_name: accs.find((a) => Number(a.id) === Number(i.account_id))?.name || '—',
        type_label: require('../db').TXN_TYPE_MAP[i.type]?.label || i.type,
      })),
    };
  });
  res.render('recurring', {
    title: '定期记账', activeNav: 'recurring', rules,
    form: fd.txFormData(ledgerId, req.session.userId), today: todayStr(), overlaps:require('../lib/recurring').overlaps(ledgerId),
  });
});

router.post('/recurring', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  if (!name) { res.flash('error', '请填写账单名称'); return res.redirect('/recurring'); }
  const types = [].concat(req.body.item_type || []);
  const amounts = [].concat(req.body.item_amount || []);
  const cats = [].concat(req.body.item_category_id || []);
  const accs = [].concat(req.body.item_account_id || []);
  const toAccs = [].concat(req.body.item_to_account_id || []);
  const notes = [].concat(req.body.item_note || []);
  const items = [];
  types.forEach((t, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (!amt) return;
    items.push({
      type: t || 'expense', amount_cents: amt,
      category_id: validCategoryId(ledgerId, cats[i]),
      account_id: accs[i] ? Number(accs[i]) : null,
      to_account_id: toAccs[i] ? Number(toAccs[i]) : null,
      note: notes[i] || name,
      currency: 'CNY',
    });
  });
  if (!items.length) { res.flash('error', '请至少填写一项金额'); return res.redirect('/recurring'); }

  const frequency = ['daily', 'weekly', 'monthly', 'yearly'].includes(req.body.frequency) ? req.body.frequency : 'monthly';
  let next;try { next=require('../lib/finance/common').date(req.body.next_run_at||todayStr());require('../lib/recurring').validateItems(ledgerId,items); } catch(e) {res.flash('error',e.message);return res.redirect('/recurring');}
  // 若首次执行日已过，自动推到下一个周期
  let guard = 0;
  while (next < todayStr() && guard++ < 400) next = sch.advanceDate(next, { frequency, interval_n: Number(req.body.interval_n) || 1, day_of_month: req.body.day_of_month });

  run(
    `INSERT INTO recurring_rules (ledger_id, name, payload, frequency, interval_n, day_of_month, next_run_at,
      auto_post, is_active, created_at) VALUES (?,?,?,?,?,?,?,?,1,?)`,
    ledgerId, name.slice(0, 40), JSON.stringify({ items, user_id: req.session.userId }),
    frequency, Math.max(1, Number(req.body.interval_n) || 1),
    req.body.day_of_month ? Number(req.body.day_of_month) : Number(next.slice(8, 10)),
    next, req.body.auto_post ? 1 : 0, nowStr()
  );
  auth.audit(req, 'recurring.create', { entity: 'recurring', ledgerId, detail: name });
  res.flash('success', `定期记账「${name}」已创建，下次执行 ${next}`);
  res.redirect('/recurring');
});

router.post('/recurring/:id/toggle', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const r = get('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (r) run('UPDATE recurring_rules SET is_active = ? WHERE id = ?', r.is_active ? 0 : 1, r.id);
  res.redirect('/recurring');
});

router.post('/recurring/:id/run', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const r = get('SELECT * FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!r) { res.flash('error', '规则不存在'); return res.redirect('/recurring'); }
  try { const result=require('../lib/recurring').execute(ledgerId,r.id,req.session.userId,req.body);auth.audit(req,'recurring.run',{ledgerId,entity:'recurring',entityId:r.id});res.flash('success','已确认本期，共 '+result.txn_ids.length+' 笔；重复提交不会再次记账'); }
  catch(e) { res.flash('error',e.message); }
  res.redirect('/recurring');
});

router.post('/recurring/:id/pause',auth.requireLogin,auth.requireLedgerWrite,(req,res)=>{try{require('../lib/recurring').pause(Number(res.locals.ledger.id),req.params.id,req.body.confirm);auth.audit(req,'recurring.pause',{ledgerId:Number(res.locals.ledger.id),entity:'recurring',entityId:Number(req.params.id)});res.flash('success','旧规则已暂停，历史流水保留');}catch(e){res.flash('error',e.message);}res.redirect('/recurring');});

router.post('/recurring/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM recurring_rules WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '定期记账已删除');
  res.redirect('/recurring');
});

/* -------------------------------- 储蓄目标 -------------------------------- */

router.get('/goals', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const goals = all(
    `SELECT g.*, a.name AS account_name FROM goals g LEFT JOIN accounts a ON a.id = g.account_id
     WHERE g.ledger_id = ? ORDER BY CASE g.status WHEN 'active' THEN 0 ELSE 1 END, g.id`,
    ledgerId
  ).map((g) => {
    const target = Number(g.target_cents);
    const saved = Number(g.saved_cents);
    let daysLeft = null;
    if (g.target_date) daysLeft = Math.round((new Date(`${g.target_date}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000);
    return {
      ...g, target, saved,
      pct: target > 0 ? Math.min(100, (saved / target) * 100) : 0,
      remain: Math.max(0, target - saved),
      daysLeft,
      needPerMonth: daysLeft && daysLeft > 0 ? Math.ceil((target - saved) / Math.max(1, daysLeft / 30)) : null,
    };
  });
  res.render('goals', { title: '储蓄目标', activeNav: 'goals', goals, form: fd.txFormData(ledgerId, req.session.userId) });
});

router.post('/goals', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const name = String(req.body.name || '').trim();
  const target = u.parseAmountToCents(req.body.target_amount);
  if (!name || !target) { res.flash('error', '请填写目标名称与目标金额'); return res.redirect('/goals'); }
  run(
    'INSERT INTO goals (ledger_id, name, icon, target_cents, saved_cents, account_id, target_date, status, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ledgerId, name.slice(0, 30), req.body.icon || '🎯', target, u.parseAmountToCents(req.body.saved_amount),
    req.body.account_id || null, req.body.target_date || null, 'active',
    req.body.note ? String(req.body.note).slice(0, 200) : null, nowStr()
  );
  res.flash('success', `储蓄目标「${name}」已创建`);
  res.redirect('/goals');
});

router.post('/goals/:id/deposit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const g = get('SELECT * FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), ledgerId);
  if (!g) { res.flash('error', '目标不存在'); return res.redirect('/goals'); }
  const delta = u.parseAmountToCents(req.body.amount);
  if (!delta) { res.flash('error', '请填写金额（取出请填负数）'); return res.redirect('/goals'); }
  if(req.body.create_txn) { try { require('../lib/account-policy').validate(ledgerId,delta>0?'expense':'income',req.body.account_id||g.account_id,null); } catch(e) { res.flash('error',e.message); return res.redirect('/goals'); } }
  const saved = Math.max(0, Number(g.saved_cents) + delta);
  const status = saved >= Number(g.target_cents) ? 'done' : 'active';
  run('UPDATE goals SET saved_cents = ?, status = ? WHERE id = ?', saved, status, g.id);
  if (req.body.create_txn) {
    txn.createTransaction(ledgerId, req.session.userId, {
      type: delta > 0 ? 'expense' : 'income',
      amount_cents: Math.abs(delta),
      account_id: req.body.account_id || g.account_id || null,
      txn_date: todayStr(),
      note: `储蓄目标「${g.name}」${delta > 0 ? '存入' : '取出'}`,
      source: 'manual',
    });
  }
  if (status === 'done') {
    for (const uid of auth.ledgerWriterIds(ledgerId)) {
      auth.notify(uid, { kind: 'success', ledgerId, title: `🎉 储蓄目标达成：${g.name}`, link: '/goals' });
    }
  }
  res.flash('success', status === 'done' ? '目标已达成 🎉' : '进度已更新');
  res.redirect('/goals');
});

router.post('/goals/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  run('DELETE FROM goals WHERE id = ? AND ledger_id = ?', Number(req.params.id), Number(res.locals.ledger.id));
  res.flash('success', '目标已删除');
  res.redirect('/goals');
});

module.exports = router;
