'use strict';
/** 交易：列表 / 记一笔 / 编辑 / 批量操作 / 报销 */
const express = require('express');
const { all, get, run, todayStr, TXN_TYPE_MAP } = require('../db');
const auth = require('../lib/auth');
const txn = require('../lib/txn');
const fd = require('../lib/formdata');
const u = require('../lib/util');
const att = require('../lib/attachments');
const dict = require('../lib/dict');
const advances = require('../lib/advances');

const router = express.Router();

/** 从表单解析出标准记账号 */
function readForm(body) {
  const splits = [];
  const names = [].concat(body.split_name || []);
  const amounts = [].concat(body.split_amount || []);
  names.forEach((n, i) => {
    const amt = u.parseAmountToCents(amounts[i]);
    if (n && amt) splits.push({ member_name: String(n).slice(0, 30), share_cents: amt });
  });
  return {
    // type 走白名单：透传任意值会在编辑失败回显时进入内嵌 <script> 的 JSON
    type: TXN_TYPE_MAP[body.type] ? body.type : 'expense',
    amount_cents: u.parseAmountToCents(body.amount),
    currency: body.currency || 'CNY',
    rate: body.rate === undefined ? undefined : String(body.rate).trim(),
    settlement_amount_cents: String(body.settlement_amount ?? '').trim() ? u.parseAmountToCents(body.settlement_amount) : undefined,
    account_id: body.account_id || null,
    to_account_id: body.to_account_id || null,
    category_id: body.category_id || null,
    debt_id: body.debt_id || null,
    txn_date: body.txn_date || todayStr(),
    txn_time: body.txn_time,
    txn_time_mode: body.txn_time_mode,
    note: body.note || '',
    merchant: body.merchant || '',
    owner_label: body.owner_label || null,
    // P7 修订：一次性大额人工标记（预测节奏外推必剔；未勾选=0 由统计层自动判）
    no_rhythm: body.no_rhythm ? 1 : 0,
    status: body.status || 'cleared',
    is_reimbursable: body.is_reimbursable ? 1 : 0,
    tags: body.tags || '',
    splits,
    group_id: body.group_id || null,
    source: body.source || 'manual',
  };
}

/** back 只接受站内相对路径，避免 POST 参数被构造成开放重定向 */
function safeBack(back) {
  const s = String(back || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/transactions';
}

/* ---------------------------------- 列表 ---------------------------------- */

/* 单笔详情（列表行点击弹窗用）：字段与列表同源，另带附件清单与退款可选账户 */
router.get('/:id/json', auth.requireLogin, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const t = txn.getTransaction(Number(req.params.id), ledgerId);
  if (!t) return res.status(404).json({ ok: false, error: '记录不存在' });
  const policy = require('../lib/account-policy');
  const refundAccounts = fd.accounts(ledgerId)
    .filter((a) => !a.is_archived && policy.allowed('refund', a.type))
    .map((a) => ({ id: a.id, name: a.name, icon: a.icon, type_label: a.type_label, currency: a.currency }));
  res.json({
    ok: true,
    txn: t,
    base_currency: res.locals.ledger.currency,
    today: todayStr(),
    can_write: auth.canWrite(res.locals.ledger.role),
    refund_accounts: refundAccounts,
    attachments: att.listByTxn(t.id),
  });
});

router.get('/', auth.requireLogin, (req, res) => {
  const ledger = res.locals.ledger;
  if (!ledger) return res.redirect('/');
  const ledgerId = Number(ledger.id);
  const f = {
    type: req.query.type || '',
    kind: req.query.kind || '',
    categoryId: req.query.category_id ? Number(req.query.category_id) : null,
    accountId: req.query.account_id ? Number(req.query.account_id) : null,
    memberId: req.query.member_id ? Number(req.query.member_id) : null,
    owner: req.query.owner ? String(req.query.owner).replace(/[\s\u3000]+/g, '').slice(0, 20) : '',
    tagId: req.query.tag_id ? Number(req.query.tag_id) : null,
    source: req.query.source || '',
    advanceRelated: req.query.advance_related === '1' ? '1' : '',
    month: req.query.month || '',
    from: req.query.from || '',
    to: req.query.to || '',
    keyword: req.query.q || '',
    reimbursable: req.query.reimbursable || '',
    sort: req.query.sort || 'date_desc',
    page: Number(req.query.page) || 1,
    pageSize: [20,40,80].includes(Number(req.query.page_size)) ? Number(req.query.page_size) : 20,
  };
  const result = txn.listTransactions(ledgerId, f);
  const form = fd.txFormData(ledgerId, req.session.userId);
  res.render('transactions', {
    title: '账单明细', activeNav: 'transactions',
    f, result, groups: txn.groupByDate(result.rows,f.sort), form,
    family: require('../lib/ai').familyMembers(ledgerId),
    totalPages: result.pages,
  });
});

/* --------------------------------- 记一笔 --------------------------------- */

router.get('/new', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const targets=require('../lib/finance/payments').repaymentOptions(ledgerId).targets;
  const selected=targets.find(target=>target.target_kind+':'+target.target_id===req.query.target)||targets[0]||null;
  const entryLoans=Object.fromEntries(targets.filter(target=>target.target_kind==='loan').map(target=>[target.target_id,require('../lib/finance/loans').detail(ledgerId,target.target_id)]));
  const type = TXN_TYPE_MAP[req.query.type] ? req.query.type : 'expense';
  const form = fd.txFormData(ledgerId, req.session.userId);
  const prefill = {
    type,
    advance_operation_key:require('node:crypto').randomUUID(),
    amount: req.query.amount || '',
    txn_date: req.query.date || todayStr(),
    txn_time: req.query.time || '',
    txn_time_mode: req.query.time ? 'explicit' : (req.query.from_ai || req.query.time === '' ? 'unknown' : 'auto'),
    category_id: req.query.category_id || '',
    account_id: req.query.account_id || (form.accounts[0] ? form.accounts[0].id : ''),
    to_account_id: '',
    note: req.query.note || '',
    merchant: '',
    tags: '',
    is_reimbursable: 0,
    currency: res.locals.ledger.currency || 'CNY',
    status: 'cleared',
  };
  if (req.query.from_ai) {
    prefill.note = req.query.note || prefill.note;
  }
  res.render('entry-workspace', {
    initialType:req.query.type==='repayment'?'repayment':type,targets,selected,entryLoans,today:todayStr(),operationKey:require('node:crypto').randomUUID(),sources:all("SELECT * FROM transactions WHERE ledger_id=? AND deleted_at IS NULL AND status='cleared' ORDER BY id DESC LIMIT 200",ledgerId),
    title: '记一笔', activeNav: 'new', mode: 'create', form, t: prefill,
    splitRows: [], splits: [], back: req.query.back || '/transactions',
    family: require('../lib/ai').familyMembers(ledgerId),
  });
});

router.post('/', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const data = readForm(req.body);
  const wantsJson = req.body._json === '1' || (req.headers.accept || '').includes('application/json');
  try {
    data.txn_time=require('../lib/transaction-time').manualTime(data,require('../db').nowStr());
    const previousAdvance=req.body.advance_operation_key?get('SELECT txn_time FROM advances WHERE ledger_id=? AND operation_key=?',ledgerId,String(req.body.advance_operation_key)):null;
    if(previousAdvance&&data.txn_time_mode==='auto')data.txn_time=previousAdvance.txn_time;
    const advanceAmount=u.parseAmountToCents(req.body.advance_amount);
    if((req.body.advance_person||req.body.advance_amount)&&!['expense','fee'].includes(data.type))throw Error('部分代垫仅用于支出');
    const advance=advanceAmount||req.body.advance_person ? require('../lib/advances').create(ledgerId,req.session.userId,{...data,personal_cents:data.amount_cents-advanceAmount,person:req.body.advance_person,operation_key:req.body.advance_operation_key}) : null;
    const id = advance?advance.primary_transaction_id:txn.createTransaction(ledgerId, req.session.userId, data);
    // P13：手动选的分类是用户有意识的判断，触发个人词表沉淀（≥3 次 80% 稳定才入表；失败不影响记账）
    dict.sediment(ledgerId, data.merchant);
    auth.audit(req, 'txn.create', { entity: 'transaction', entityId: id, ledgerId, detail: `${data.type} ${(data.amount_cents / 100).toFixed(2)}` });
    if (wantsJson) return res.json({ ok: true, id, redirect: '/transactions' });
    res.flash('success', '已记一笔 ✓');
    res.redirect(safeBack(req.body.back));
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
    const form = fd.txFormData(ledgerId, req.session.userId);
    res.status(400).render('txn-form', {
      title: '记一笔', activeNav: 'new', mode: 'create', form,
      t: { ...data, amount: (data.amount_cents / 100).toFixed(2), settlement_amount: req.body.settlement_amount, advance_person:req.body.advance_person,advance_amount:req.body.advance_amount,advance_operation_key:req.body.advance_operation_key },
      splitRows: data.splits, splits: [], back: safeBack(req.body.back), error: e.message,
      family: require('../lib/ai').familyMembers(ledgerId),
    });
  }
});

/* --------------------------------- 批量操作 -------------------------------- */
// 注意：必须注册在 POST /:id（编辑）之前，否则 /transactions/bulk 会被 /:id 匹配成
// id="bulk" 落进编辑分支报「记录不存在」（v1.0.0 起曾因此导致网页批量操作全部失效）

router.post('/bulk', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action || '';
  if (!ids.length) {
    res.flash('error', '请先勾选记录');
    return res.redirect(safeBack(req.body.back));
  }
  const placeholders = ids.map(() => '?').join(',');
  switch (action) {
    case 'delete': {
      const n = txn.bulkDelete(ids, ledgerId);
      res.flash('success', `已删除 ${n} 笔记录`);
      break;
    }
    case 'category': {
      const cid = require('../lib/categories').resolveId(ledgerId, req.body.category_id);
      const c = cid ? require('../lib/categories').find(ledgerId, cid, true) : null;
      if (!c) { res.flash('error', '请选择要改成的分类'); break; }
      try { for (const id of ids) require('../lib/advances').guardTransaction(ledgerId, id); }
      catch (e) { res.flash('error', e.message); break; }
      run(`UPDATE transactions SET category_id = ?, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders}) AND type NOT IN ('transfer','adjust','lend','borrow','repay_receive','repay_pay','invest_buy','invest_sell')`, cid, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已修改 ${ids.length} 笔的分类`);
      break;
    }
    case 'tag': {
      const tag = String(req.body.tag || '').trim();
      if (!tag) { res.flash('error', '请输入标签名'); break; }
      try { for (const id of ids) require('../lib/advances').guardTransaction(ledgerId, id); }
      catch (e) { res.flash('error', e.message); break; }
      for (const id of ids) txn.applyTags(id, ledgerId, tag, false);
      res.flash('success', `已为 ${ids.length} 笔添加标签「${tag}」`);
      break;
    }
    case 'reimburse': {
      try {
        // 未选入账账户时回落到账本第一个可用账户，避免报销收入悬空（与开放 API 行为一致）
        const reimburseAcc = req.body.account_id
          ? Number(req.body.account_id)
          : Number(get('SELECT id FROM accounts WHERE ledger_id = ? AND is_archived = 0 ORDER BY sort_order, id LIMIT 1', ledgerId)?.id) || null;
        const r = txn.markReimbursed(ids, ledgerId, req.session.userId, reimburseAcc,req.body);
        res.flash('success', `已标记 ${r.count} 笔为已报销，生成入账 ${(r.total / 100).toFixed(2)}`);
      } catch (e) {
        res.flash('error', e.message);
      }
      break;
    }
    case 'reimbursable': {
      try { for (const id of ids) require('../lib/advances').guardTransaction(ledgerId,id); }
      catch (e) { res.flash('error',e.message); break; }
      run(`UPDATE transactions SET is_reimbursable = 1, updated_at = ? WHERE ledger_id = ? AND id IN (${placeholders})`, require('../db').nowStr(), ledgerId, ...ids);
      res.flash('success', `已标记 ${ids.length} 笔为待报销`);
      break;
    }
    case 'restore': {
      try { txn.restoreMany(ids.map(Number),ledgerId); }
      catch(e){res.flash('error',e.message);break;}
      res.flash('success', '已恢复');
      break;
    }
    default:
      res.flash('error', '未知操作');
  }
  res.redirect(safeBack(req.body.back));
});

/* ---------------------------------- 编辑 ---------------------------------- */

router.post('/:id/advance',auth.requireLogin,auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id),t=get('SELECT * FROM transactions WHERE id=? AND ledger_id=?',id,lid);
  try{
    if(!t)throw Error('记录不存在');
    const item=require('../lib/advances').create(lid,req.session.userId,{amount_cents:t.amount_cents,personal_cents:t.amount_cents-u.parseAmountToCents(req.body.advance_amount),person:req.body.advance_person,account_id:t.account_id,category_id:t.category_id,currency:t.currency,source_transaction_id:id,confirm_source:req.body.confirm_source,operation_key:req.body.operation_key});
    auth.audit(req,'advance.convert',{ledgerId:lid,entity:'advance',entityId:item.id});
    return res.redirect('/advances/'+item.id);
  }catch(e){res.flash('error',e.message);res.redirect('/transactions/'+id+'/edit');}
});

router.get('/:id/edit', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const t = txn.getTransaction(Number(req.params.id), ledgerId);
  if (!t) return res.status(404).render('error', { title: '记录不存在', message: '该笔记录可能已被删除。' });
  if(t.advance_collection)return res.redirect('/advances/'+t.advance_collection.advance_id);
  if (t.advance && t.id !== t.advance.primary_transaction_id) {
    return res.redirect('/transactions/'+t.advance.primary_transaction_id+'/edit?back='+encodeURIComponent(safeBack(req.query.back)));
  }
  t.advance_operation_key=require('node:crypto').randomUUID();
  const form = fd.txFormData(ledgerId, req.session.userId);
  const back = t.advance ? require('../lib/navigation').forView('txn-form', {back:req.query.back}).href : safeBack(req.query.back);
  let advanceEdit;
  let images = att.listByTxn(t.id);
  if (t.advance) {
    const item = advances.detail(ledgerId, t.advance.id);
    const personal = item.transactions.find(row => row.role === 'personal');
    const original = item.transactions.find(row => row.role === 'original');
    const readDraft = key => {
      const draft = req.session[key];
      if (draft?.ledgerId !== ledgerId || draft.id !== item.id) return null;
      delete req.session[key];
      return draft.values;
    };
    const editDraft = readDraft('advanceEditDraft');
    const categoryId = editDraft?.category_id ?? personal?.category_id;
    const locked = item.received_cents > 0;
    const paymentLocked = locked || !!original;
    const timeLocked = locked || !!original?.txn_time;
    advanceEdit = {item, locked, paymentLocked, timeLocked, original,
      today:todayStr(), draft:readDraft('advanceDraft'), operationKey:require('node:crypto').randomUUID(),
      amendKey:editDraft?.operation_key || t.advance_operation_key,
      personal:(locked ? null : editDraft?.personal) ?? (item.personal_cents/100).toFixed(2),
      person:editDraft?.person ?? item.person};
    Object.assign(t, {
      amount:(paymentLocked ? null : editDraft?.amount) ?? (item.amount_cents/100).toFixed(2),
      type:(locked ? null : editDraft?.type) ?? personal?.type ?? 'expense',
      account_id:(paymentLocked ? null : editDraft?.account_id) ?? item.account_id,
      txn_date:(paymentLocked ? null : editDraft?.txn_date) ?? item.txn_date,
      txn_time:(timeLocked ? null : editDraft?.txn_time) ?? item.txn_time,
      category_id:categoryId,
      category_path:form.expenseCats.find(category=>category.id===Number(categoryId))?.path ??
        (categoryId && Number(t.category_id)===Number(categoryId) ? t.category_path : null),
      merchant:editDraft?.merchant ?? item.merchant,
      note:editDraft?.note ?? item.note,
      owner_label:editDraft?.owner_label ?? t.owner_label,
      tag_names:editDraft?.tags ?? t.tag_names,
      no_rhythm:editDraft?.no_rhythm === undefined ? t.no_rhythm : editDraft.no_rhythm === '1',
    });
    if (original) images = images.concat(att.listByTxn(original.id));
  }
  res.render('txn-form', {
    title: '编辑记录', activeNav: 'transactions', mode: 'edit', form, t, advanceEdit,
    splitRows: txn.splitsOf(t.id),
    splits: txn.splitsOf(t.id),
    images,
    back,
    family: require('../lib/ai').familyMembers(ledgerId),
  });
});

router.post('/:id', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const data = readForm(req.body);
  try {
    txn.updateTransaction(id, ledgerId, req.session.userId, data);
    auth.audit(req, 'txn.update', { entity: 'transaction', entityId: id, ledgerId });
    res.flash('success', '已保存修改');
    res.redirect(safeBack(req.body.back));
  } catch (e) {
    const form = fd.txFormData(ledgerId, req.session.userId);
    const t = txn.getTransaction(id, ledgerId);
    res.status(400).render('txn-form', {
      title: '编辑记录', activeNav: 'transactions', mode: 'edit', form,
      t: { ...t, ...data, amount: (data.amount_cents / 100).toFixed(2), settlement_amount: req.body.settlement_amount },
      splitRows: data.splits, splits: data.splits, back: safeBack(req.body.back), error: e.message,
      family: require('../lib/ai').familyMembers(ledgerId),
    });
  }
});

router.post('/:id/refund', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  const wantsJson = req.body._json === '1' || (req.headers.accept || '').includes('application/json');
  try {
    const rawAmount = req.body.amount !== undefined ? String(req.body.amount).trim() : '';
    const rawSettle = req.body.settlement_amount !== undefined ? String(req.body.settlement_amount).trim() : '';
    const txnDate = String(req.body.txn_date || req.body.date || todayStr()).trim();
    const payload = {
      amount_cents: rawAmount !== '' ? u.parseAmountToCents(rawAmount) : undefined,
      account_id: req.body.account_id ? Number(req.body.account_id) : undefined,
      txn_date: txnDate,
      note: req.body.note,
      settlement_amount_cents: rawSettle !== '' ? u.parseAmountToCents(rawSettle) : undefined,
    };
    if (req.body.txn_time !== undefined && String(req.body.txn_time).trim() !== '') {
      payload.txn_time = req.body.txn_time;
    } else if (req.body.txn_time_mode === 'unknown') {
      payload.txn_time = null;
    } else if (txnDate === todayStr()) {
      payload.txn_time_mode = 'auto';
    }
    const r = txn.refundTransaction(id, ledgerId, req.session.userId, payload);
    auth.audit(req, 'txn.refund', {
      entity: 'transaction',
      entityId: r.id,
      ledgerId,
      detail: `原支出 #${id} 退款 ${(r.amount_cents / 100).toFixed(2)} ${r.currency}`,
    });
    const baseCur = res.locals.ledger.currency || 'CNY';
    const amtText = r.currency === baseCur ? `¥${(r.amount_cents / 100).toFixed(2)}` : `${(r.amount_cents / 100).toFixed(2)} ${r.currency}`;
    const msg = r.fully_refunded ? `已全额退款 ${amtText}` : `已退款 ${amtText}`;
    res.flash('success', msg);
    if (wantsJson) return res.json({ ok: true, id: r.id, refund: r, message: msg });
    res.redirect(safeBack(req.body.back));
  } catch (e) {
    if (wantsJson) return res.status(400).json({ ok: false, error: e.message });
    res.flash('error', e.message);
    res.redirect(safeBack(req.body.back));
  }
});

router.post('/:id/delete', auth.requireLogin, auth.requireLedgerWrite, (req, res) => {
  const ledgerId = Number(res.locals.ledger.id);
  const id = Number(req.params.id);
  let ok;
  try {
    const advance = txn.getTransaction(id, ledgerId)?.advance;
    if (advance?.primary_transaction_id === id) {
      advances.reverse(ledgerId, advance.id);
      auth.audit(req, 'advance.reverse', {entity:'advance', entityId:advance.id, ledgerId});
      ok = true;
    } else {
      ok = txn.softDelete(id, ledgerId);
      auth.audit(req, 'txn.delete', {entity:'transaction', entityId:id, ledgerId});
    }
  } catch(e){if(req.body._json==='1')return res.status(400).json({ok:false,error:e.message});res.flash('error',e.message);return res.redirect(safeBack(req.body.back));}
  if (req.body._json === '1') return res.json({ ok });
  res.flash(ok ? 'success' : 'error', ok ? '已删除' : '记录不存在');
  res.redirect(safeBack(req.body.back));
});

module.exports = router;
