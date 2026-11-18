'use strict';

// A purchase remains one user operation. Its postings separate personal
// consumption from money owed to the household; collections are transfers.
const db = require('../db');
const money = require('./finance/common');
const clock = require('./transaction-time');
const FUND_TYPES = ['cash', 'debit', 'virtual', 'prepaid'];

function row(lid, id) {
  const result = db.get('SELECT * FROM advances WHERE ledger_id=? AND id=?', lid, Number(id));
  if (!result) throw Error('代垫记录不存在或不属于当前账本');
  return result;
}

function collectionRow(lid, id) {
  const result = db.get('SELECT * FROM advance_collections WHERE ledger_id=? AND id=?', lid, Number(id));
  if (!result) throw Error('回款记录不存在或不属于当前账本');
  return result;
}

function detail(lid, id) {
  const result = row(lid, id);
  const collections = db.all(`SELECT c.*,a.name AS account_name,a.type AS account_type
    FROM advance_collections c JOIN accounts a ON a.id=c.account_id
    WHERE c.ledger_id=? AND c.advance_id=? ORDER BY c.txn_date DESC,c.id DESC`, lid, result.id);
  const received = collections.filter(c => !c.deleted_at).reduce((sum, c) => sum + c.principal_cents, 0);
  const actualReceived = collections.filter(c => !c.deleted_at).reduce((sum, c) => sum + c.amount_cents, 0);
  const excessReceived = collections.filter(c => !c.deleted_at).reduce((sum, c) => sum + c.excess_cents, 0);
  const account = db.get('SELECT name,type FROM accounts WHERE ledger_id=? AND id=?', lid, result.account_id);
  const transactions = db.all(`SELECT t.*,l.role FROM advance_txns l
    JOIN transactions t ON t.id=l.transaction_id WHERE l.advance_id=? AND t.ledger_id=? ORDER BY t.id`, result.id, lid);
  return {...result, account_name: account?.name, account_type: account?.type,
    account_type_label: db.ACCOUNT_TYPE_MAP[account?.type]?.label || null,
    received_cents: received, actual_received_cents: actualReceived, excess_received_cents: excessReceived, remaining_cents: result.advance_cents - received,
    txn_time_display: clock.formatTime(result.txn_time), transactions, collections};
}

function list(lid, {includeDeleted = false} = {}) {
  return db.all('SELECT id FROM advances WHERE ledger_id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL') +
    ' ORDER BY txn_date DESC,id DESC', lid).map(result => detail(lid, result.id));
}

function keyOf(d) {
  const key = String(d.operation_key || '').trim();
  if (!key || key.length > 100) throw Error('请提供不超过100字的operation_key，重试时复用同一标识');
  return key;
}

function moment(d) {
  return {date: clock.normalizeDate(d.txn_date ?? d.date, db.todayStr()),
    time: clock.normalizeTime(d.txn_time !== undefined ? d.txn_time : d.time)};
}

function requestedMoment(d) {
  if ((d.txn_date !== undefined || d.date !== undefined) && !(d.txn_date ?? d.date)) throw Error('交易日期不能为空');
  return {date: d.txn_date !== undefined || d.date !== undefined ? clock.normalizeDate(d.txn_date ?? d.date, null) : null,
    time: clock.normalizeTime(d.txn_time !== undefined ? d.txn_time : d.time)};
}

function createSignature(d) {
  return JSON.stringify({type:d.type||null,amount_cents: Number(d.amount_cents), personal_cents: Number(d.personal_cents),
    type: d.type || null, status: d.status || null, is_reimbursable: !!d.is_reimbursable,
    person: String(d.person || '').trim(), account_id: Number(d.account_id), category_id: Number(d.category_id) || null,
    currency: d.currency || null, source_transaction_id: Number(d.source_transaction_id) || null,
    confirm_source: d.confirm_source === true || d.confirm_source === '1',
    ...requestedMoment(d), note: d.note || null, merchant: d.merchant || null, tags: d.tags || null,
    owner_label: d.owner_label || null, no_rhythm: !!d.no_rhythm});
}

function managedAccount(lid, currency) {
  let mapped = db.get('SELECT account_id FROM advance_accounts WHERE ledger_id=? AND currency=?', lid, currency);
  if (!mapped) {
    const id = Number(db.run(`INSERT INTO accounts(ledger_id,name,type,icon,currency,initial_cents,balance_cents,include_in_net,created_at)
      VALUES(?,?,'receivable','🤝',?,0,0,1,?)`, lid, '代垫待收款', currency, db.nowStr()).lastInsertRowid);
    db.run('INSERT INTO advance_accounts(ledger_id,currency,account_id)VALUES(?,?,?)', lid, currency, id);
    mapped = {account_id: id};
  }
  return money.account(lid, mapped.account_id, {type: 'receivable', currency});
}

function guardTransaction(lid, id) {
  const link = db.get(`SELECT a.id FROM advance_txns l JOIN advances a ON a.id=l.advance_id
    WHERE a.ledger_id=? AND l.transaction_id=? AND (l.role<>'original' OR a.deleted_at IS NULL) LIMIT 1`, lid, Number(id));
  const collection = db.get('SELECT id FROM advance_collections WHERE ledger_id=? AND (transaction_id=? OR excess_transaction_id=?)', lid, Number(id), Number(id));
  if (link || collection) throw Error('此流水属于代垫或回款，请在代垫详情整体更正、撤销或恢复');
}

function sourceFor(lid, d, funding, amount) {
  if (!d.source_transaction_id) return null;
  const id = Number(d.source_transaction_id);
  guardTransaction(lid, id);
  require('./finance/payments').guardTransaction(lid, id);
  require('./finance/cards').guardTransaction(lid, id);
  const source = db.get('SELECT * FROM transactions WHERE ledger_id=? AND id=? AND deleted_at IS NULL', lid, id);
  if (!source || !['expense', 'fee'].includes(source.type) || source.account_id !== funding.id ||
      source.amount_cents !== amount || source.currency !== funding.currency || source.rate !== 1 ||
      source.amount_base_cents !== amount || source.status !== 'cleared' || source.debt_id ||
      source.reimbursed_at || source.related_id || source.recurring_run_id || source.subscription_id ||
      db.get('SELECT id FROM splits WHERE ledger_id=? AND transaction_id=?', lid, id) ||
      db.get('SELECT id FROM transactions WHERE ledger_id=? AND refund_of_id=? AND deleted_at IS NULL', lid, id) ||
      db.get('SELECT id FROM transactions WHERE ledger_id=? AND related_id=? AND deleted_at IS NULL', lid, id)) {
    throw Error('来源须为同账户、同币种、同金额的已确认普通支出，且未报销、分账或关联其他业务');
  }
  if (d.confirm_source !== true && d.confirm_source !== '1') throw Error('请确认将原整笔支出替换为个人消费和代垫，原记录将保留');
  const requested = requestedMoment(d);
  if (requested.date && requested.date !== source.txn_date) throw Error('交易日期须与已有来源一致');
  if (source.txn_time && (d.txn_time !== undefined || d.time !== undefined) && requested.time !== source.txn_time) {
    throw Error('交易时刻须与已有来源一致');
  }
  return source;
}

function create(lid, uid, d, {previousCategoryId, replacing = false} = {}) {
  return db.tx(() => {
    const key = keyOf(d), signature = createSignature(d);
    const existing = db.get('SELECT * FROM advances WHERE ledger_id=? AND operation_key=?', lid, key);
    if (existing) {
      if (existing.signature !== signature) throw Error('同一操作标识的请求内容不同');
      return detail(lid, existing.id);
    }
    if (d.status && d.status !== 'cleared') throw Error('代垫只登记已确认的实际付款，请确认扣款后再登记');
    if (d.is_reimbursable || d.splits?.length) throw Error('代垫已有独立回款核销，不能同时启用整笔报销或AA分账');
    if (d.type && !['expense', 'fee'].includes(d.type)) throw Error('代垫只支持普通支出或手续费付款');
    const amount = money.cents(d.amount_cents), personal = money.cents(d.personal_cents, {zero: true});
    if (personal >= amount) throw Error('个人消费必须小于付款总额；没有代垫请直接记普通支出');
    const person = String(d.person || '').trim();
    if (!person || person.length > 60) throw Error('请填写不超过60字的代垫对象');
    const currency = money.baseCurrency(lid, d.currency);
    const funding = money.account(lid, d.account_id, {currency});
    if (![...FUND_TYPES, 'credit'].includes(funding.type)) throw Error('代垫付款请选择现金、储蓄卡、支付账户或信用卡');
    const source = sourceFor(lid, d, funding, amount);
    const personalType = d.type || source?.type || 'expense';
    let actual = moment(d);
    if (source) actual = {date: source.txn_date, time: d.txn_time !== undefined || d.time !== undefined ? actual.time : source.txn_time || null};
    const categoryId = replacing && d.category_id !== undefined ? d.category_id || null : d.category_id || source?.category_id || null;
    if (personal && categoryId) {
      const category = require('./categories').forUpdate(lid, categoryId, previousCategoryId);
      if (!category || category.kind !== 'expense') throw Error('个人消费请选择有效支出分类');
    }
    const receivable = managedAccount(lid, currency);
    const note = d.note === undefined ? source?.note || null : String(d.note || '').slice(0, 300);
    const merchant = d.merchant === undefined ? source?.merchant || null : String(d.merchant || '').slice(0, 60);
    const id = Number(db.run(`INSERT INTO advances(ledger_id,user_id,person,amount_cents,personal_cents,advance_cents,currency,
      account_id,receivable_account_id,source_transaction_id,source_snapshot,operation_key,signature,txn_date,txn_time,note,merchant,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, lid, uid, person, amount, personal, amount - personal, currency,
      funding.id, receivable.id, source?.id || null, source ? JSON.stringify(source) : null, key, signature,
      actual.date, actual.time, note, merchant, db.nowStr()).lastInsertRowid);
    if (source) {
      db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?', db.nowStr(), db.nowStr(), source.id);
      db.run("INSERT INTO advance_txns VALUES(?,?,'original')", id, source.id);
    }
    const shared = {currency, account_id: funding.id, txn_date: actual.date, txn_time: actual.time, note, merchant,
      source: 'advance', group_id: 'advance_' + id, owner_label: d.owner_label ?? source?.owner_label,
      no_rhythm: d.no_rhythm ?? source?.no_rhythm, tags: d.tags};
    let primary;
    if (personal) {
      primary = Number(require('./txn').createTransaction(lid, uid, {...shared, type: personalType, amount_cents: personal,
        category_id: categoryId, category_snapshot: previousCategoryId != null && Number(categoryId) === Number(previousCategoryId)}, {channel: 'finance', deferCardRefresh: true}));
      db.run("INSERT INTO advance_txns VALUES(?,?,'personal')", id, primary);
    }
    const advanceTxn = Number(require('./txn').createTransaction(lid, uid, {...shared, type: 'transfer',
      amount_cents: amount - personal, to_account_id: receivable.id}, {channel: 'finance', deferCardRefresh: true}));
    db.run("INSERT INTO advance_txns VALUES(?,?,'advance')", id, advanceTxn);
    primary = primary || advanceTxn;
    db.run('UPDATE advances SET primary_transaction_id=? WHERE id=?', primary, id);
    if (source) {
      if (!replacing || d.tags === undefined) db.run('INSERT OR IGNORE INTO transaction_tags(transaction_id,tag_id) SELECT ?,tag_id FROM transaction_tags WHERE transaction_id=?', primary, source.id);
      db.run('UPDATE transactions SET posted_date=? WHERE id IN (?,?)', source.posted_date || null, primary, advanceTxn);
    }
    refresh(lid, [primary, advanceTxn, source?.id].filter(Boolean));
    return detail(lid, id);
  });
}

function collect(lid, uid, id, d) {
  return db.tx(() => {
    let categoryId = null;
    if (d.excess_category_id !== undefined && d.excess_category_id !== null && d.excess_category_id !== '') {
      if (typeof d.excess_category_id !== 'number' && typeof d.excess_category_id !== 'string') throw Error('收入分类无效');
      categoryId = Number(d.excess_category_id);
      if (!Number.isSafeInteger(categoryId) || categoryId <= 0) throw Error('收入分类无效');
    }
    const key = keyOf(d), signature = JSON.stringify({id: Number(id), amount_cents: Number(d.amount_cents),
      account_id: Number(d.account_id), ...requestedMoment(d),
      ...(d.excess_handling !== undefined || d.excess_category_id !== undefined ? {excess_handling: d.excess_handling || null, excess_category_id: categoryId} : {})});
    const existing = db.get('SELECT * FROM advance_collections WHERE ledger_id=? AND operation_key=?', lid, key);
    if (existing) {
      if (existing.signature !== signature) throw Error('同一回款操作标识的请求内容不同');
      return {...existing, advance: detail(lid, existing.advance_id)};
    }
    const advance = detail(lid, id);
    if (advance.deleted_at) throw Error('请先恢复代垫记录再登记回款');
    const amount = money.cents(d.amount_cents);
    if (advance.remaining_cents <= 0) throw Error('代垫已结清，不能继续登记回款');
    const principal = Math.min(amount, advance.remaining_cents), excess = amount - principal;
    if (excess && d.excess_handling !== 'income') throw Error('超额回款请确认多出金额计入收入');
    if (d.excess_handling && d.excess_handling !== 'income') throw Error('差额处理方式无效');
    let resolvedCategoryId = null;
    if (excess) {
      const categories = require('./categories');
      if (categoryId) {
        const category = categories.find(lid, categoryId, true);
        if (!category || category.kind !== 'income') throw Error('请选择有效收入分类');
        resolvedCategoryId = category.id;
      } else resolvedCategoryId = categories.list(lid, 'income').find(c => c.name === '其他收入')?.id || null;
    }
    const destination = money.account(lid, d.account_id, {currency: advance.currency});
    if (!FUND_TYPES.includes(destination.type)) throw Error('回款请选择现金、储蓄卡或支付账户');
    const actual = moment(d);
    if (actual.date < advance.txn_date) throw Error('回款日期不能早于代垫日期');
    const txnId = Number(require('./txn').createTransaction(lid, uid, {type: 'transfer', amount_cents: principal,
      currency: advance.currency, account_id: advance.receivable_account_id, to_account_id: destination.id,
      txn_date: actual.date, txn_time: actual.time, source: 'advance_collection', note: '代垫回款 · ' + advance.person}, {channel: 'finance'}));
    const excessTxnId = excess ? Number(require('./txn').createTransaction(lid, uid, {type: 'income', amount_cents: excess,
      currency: advance.currency, account_id: destination.id, category_id: resolvedCategoryId,
      txn_date: actual.date, txn_time: actual.time, source: 'advance_collection', note: '代垫凑整差额 · ' + advance.person}, {channel: 'finance'})) : null;
    const collectionId = Number(db.run(`INSERT INTO advance_collections(ledger_id,advance_id,transaction_id,amount_cents,
      principal_cents,excess_cents,excess_transaction_id,account_id,operation_key,signature,txn_date,txn_time,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, lid, advance.id,
      txnId, amount, principal, excess, excessTxnId, destination.id, key, signature, actual.date, actual.time, db.nowStr()).lastInsertRowid);
    return {...collectionRow(lid, collectionId), advance: detail(lid, advance.id)};
  });
}

function refresh(lid, ids) {
  db.recalcBalances(lid);
  require('./finance/cards').afterTransactions(lid, ids);
}

function reverse(lid, id, options = {}) {
  return db.tx(() => {
    const advance = detail(lid, id);
    if (advance.deleted_at) return advance;
    if (advance.received_cents) throw Error('请先撤销该笔代垫的所有回款，再撤销付款');
    for (const t of advance.transactions) require('./finance/cards').guardTransaction(lid, t.id);
    for (const t of advance.transactions) db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?',
      t.role === 'original' ? null : db.nowStr(), db.nowStr(), t.id);
    db.run('UPDATE advances SET deleted_at=? WHERE id=?', db.nowStr(), advance.id);
    if(options.deferCardRefresh===true)db.recalcBalances(lid);
    else refresh(lid, advance.transactions.map(t => t.id));
    return detail(lid, id);
  });
}

function restore(lid, id) {
  return db.tx(() => {
    const advance = detail(lid, id);
    if (!advance.deleted_at) return advance;
    if (advance.replaced_by) throw Error('该记录已有更正版本，请查看更正记录');
    money.account(lid, advance.account_id, {currency: advance.currency});
    money.account(lid, advance.receivable_account_id, {currency: advance.currency});
    if (advance.source_transaction_id) {
      const original = JSON.parse(advance.source_snapshot);
      sourceFor(lid, {source_transaction_id: original.id, confirm_source: true},
        {id: advance.account_id, currency: advance.currency}, advance.amount_cents);
      const current = db.get('SELECT * FROM transactions WHERE ledger_id=? AND id=?', lid, original.id);
      for (const key of ['type','amount_cents','amount_base_cents','currency','rate','account_id','to_account_id','txn_date','txn_time','status','posted_date','refund_of_id']) {
        if ((current[key] ?? null) !== (original[key] ?? null)) throw Error('原支出资金信息已变化，不能恢复旧代垫，请重新拆分');
      }
    }
    for (const t of advance.transactions) {
      require('./finance/cards').guardTransaction(lid, t.id);
      db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?', t.role === 'original' ? db.nowStr() : null, db.nowStr(), t.id);
    }
    db.run('UPDATE advances SET deleted_at=NULL WHERE id=?', advance.id);
    refresh(lid, advance.transactions.map(t => t.id));
    return detail(lid, id);
  });
}

function reverseCollection(lid, id) {
  return db.tx(() => {
    const collection = collectionRow(lid, id);
    if (!collection.deleted_at) {
      db.run('UPDATE advance_collections SET deleted_at=? WHERE id=?', db.nowStr(), collection.id);
      db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?', db.nowStr(), db.nowStr(), collection.transaction_id);
      if (collection.excess_transaction_id) db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?', db.nowStr(), db.nowStr(), collection.excess_transaction_id);
      refresh(lid, [collection.transaction_id, collection.excess_transaction_id].filter(Boolean));
    }
    return {...collectionRow(lid, id), advance: detail(lid, collection.advance_id)};
  });
}

function restoreCollection(lid, id) {
  return db.tx(() => {
    const collection = collectionRow(lid, id), advance = detail(lid, collection.advance_id);
    if (collection.deleted_at) {
      if (advance.deleted_at) throw Error('请先恢复代垫付款，再恢复回款');
      if (collection.principal_cents > advance.remaining_cents) throw Error('恢复后回款会超过尚未收回金额');
      money.account(lid, collection.account_id, {currency: advance.currency});
      db.run('UPDATE advance_collections SET deleted_at=NULL WHERE id=?', collection.id);
      db.run('UPDATE transactions SET deleted_at=NULL,updated_at=? WHERE id=?', db.nowStr(), collection.transaction_id);
      if (collection.excess_transaction_id) db.run('UPDATE transactions SET deleted_at=NULL,updated_at=? WHERE id=?', db.nowStr(), collection.excess_transaction_id);
      refresh(lid, [collection.transaction_id, collection.excess_transaction_id].filter(Boolean));
    }
    return {...collectionRow(lid, id), advance: detail(lid, collection.advance_id)};
  });
}

function detailsForEdit(lid, old, payment, personal, fields, personalCents) {
  const {person, merchant, note, category_id, owner_label, tags, no_rhythm} = fields;
  for (const [value, limit, label] of [[person, 60, '代垫对象'], [merchant, 60, '商家'], [note, 300, '备注'], [owner_label, 20, '归属人'], [tags, 500, '标签']]) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length > limit)) {
      throw Error(label + '长度不能超过' + limit + '字');
    }
  }
  const nextPerson = person === undefined ? old.person : person.trim();
  const nextMerchant = merchant === undefined ? old.merchant : merchant.trim() || null;
  const nextNote = note === undefined ? old.note : note.trim() || null;
  if (!nextPerson) throw Error('请填写代垫对象');
  let categoryId = personalCents > 0 ? personal?.category_id ?? null : null;
  if (personalCents > 0 && category_id !== undefined) {
    if (category_id === '' || category_id === null) categoryId = null;
    else {
      const category = require('./categories').forUpdate(lid, category_id, personal?.category_id);
      if (!category || category.kind !== 'expense') throw Error('自用消费请选择当前账本有效支出分类');
      categoryId = Number(category.id);
    }
  }
  if (no_rhythm !== undefined && ![true, false, 1, 0, '1', '0'].includes(no_rhythm)) throw Error('一次性大额须为有效布尔值');
  return {person: nextPerson, merchant: nextMerchant, note: nextNote, category_id: categoryId,
    owner_label: owner_label === undefined ? payment.owner_label || '' : owner_label.replace(/[\s\u3000]+/g, ''),
    no_rhythm: no_rhythm === undefined ? !!payment.no_rhythm : [true, 1, '1'].includes(no_rhythm), tags};
}

function edit(lid, uid, id, fields) {
  return db.tx(() => {
    const old = detail(lid, id);
    const payment = old.transactions.find(t => t.id === old.primary_transaction_id);
    if (!payment) throw Error('代垫付款流水不存在');
    const personal = old.transactions.find(t => t.role === 'personal');
    const posted = requestedMoment(fields);
    for (const value of [fields.amount_cents, fields.personal_cents]) {
      if (value !== undefined && !Number.isSafeInteger(value)) throw Error('金额必须为有效整数分');
    }
    const amount = fields.amount_cents === undefined ? old.amount_cents : money.cents(fields.amount_cents);
    const personalCents = fields.personal_cents === undefined ? old.personal_cents : money.cents(fields.personal_cents, {zero: true});
    const account = fields.account_id === undefined ? old.account_id : Number(fields.account_id);
    const date = posted.date ?? old.txn_date;
    const time = fields.txn_time === undefined && fields.time === undefined ? old.txn_time : posted.time;
    const oldType = personal?.type || 'expense';
    const type = personalCents > 0 ? fields.type ?? oldType : oldType;
    if (!['expense', 'fee'].includes(type)) throw Error('代垫付款类型须为支出或手续费');
    const info = detailsForEdit(lid, old, payment, personal, fields, personalCents);
    const fundingChanged = amount !== old.amount_cents || personalCents !== old.personal_cents || account !== old.account_id ||
      date !== old.txn_date || time !== old.txn_time || type !== oldType;
    if (fundingChanged) {
      const tags = info.tags ?? db.all(`SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id=tt.tag_id
        WHERE tt.transaction_id=? AND t.ledger_id=? ORDER BY t.id`, payment.id, lid).map(t => t.name).join(' ');
      return amend(lid, uid, id, {...info, tags, type, txn_date: date, txn_time: time, account_id: account,
        amount_cents: amount, personal_cents: personalCents, currency: old.currency, operation_key: fields.operation_key});
    }
    if (old.deleted_at || old.replaced_by) throw Error('只能编辑有效代垫记录');
    const {person: nextPerson, merchant: nextMerchant, note: nextNote} = info;

    if (nextPerson !== old.person || nextMerchant !== old.merchant || nextNote !== old.note) {
      db.run('UPDATE advances SET person=?,merchant=?,note=? WHERE ledger_id=? AND id=?', nextPerson, nextMerchant, nextNote, lid, id);
    }
    for (const t of old.transactions.filter(t => t.role !== 'original')) {
      const categoryId = t.role === 'personal' ? info.category_id : null;
      const owner = info.owner_label || null;
      if (nextMerchant !== t.merchant || nextNote !== t.note || categoryId !== t.category_id || owner !== t.owner_label || Number(info.no_rhythm) !== t.no_rhythm) {
        db.run('UPDATE transactions SET merchant=?,note=?,category_id=?,owner_label=?,no_rhythm=?,updated_at=? WHERE ledger_id=? AND id=? AND deleted_at IS NULL',
          nextMerchant, nextNote, categoryId, owner, Number(info.no_rhythm), db.nowStr(), lid, t.id);
      }
      if (info.tags !== undefined) require('./txn').applyTags(t.id, lid, info.tags, true);
    }
    if (nextPerson !== old.person) {
      for (const [column, prefix] of [['transaction_id', '代垫回款 · '], ['excess_transaction_id', '代垫凑整差额 · ']]) {
        db.run(`UPDATE transactions SET note=?,updated_at=? WHERE ledger_id=? AND note=?
          AND id IN (SELECT ${column} FROM advance_collections WHERE ledger_id=? AND advance_id=?)`,
        prefix + nextPerson, db.nowStr(), lid, prefix + old.person, lid, id);
      }
    }
    return detail(lid, id);
  });
}

function amend(lid, uid, id, d) {
  return db.tx(() => {
    const old = detail(lid, id);
    const previousCategoryId = old.transactions.find(t => t.role === 'personal')?.category_id;
    const body = {...d, source_transaction_id: old.source_transaction_id || undefined,
      confirm_source: old.source_transaction_id ? true : undefined};
    const existing = db.get('SELECT id FROM advances WHERE ledger_id=? AND operation_key=?', lid, keyOf(body));
    if (existing) {
      if (old.replaced_by !== existing.id) throw Error('更正操作标识已被其他记录使用');
      return create(lid, uid, body);
    }
    if (old.deleted_at || old.replaced_by) throw Error('只能更正有效代垫记录');
    const oldTransactionIds = old.transactions.map(t => t.id);
    reverse(lid, id, {deferCardRefresh: true});
    const next = create(lid, uid, body, {previousCategoryId, replacing: true});
    db.run('UPDATE attachments SET txn_id=? WHERE ledger_id=? AND txn_id=?', next.primary_transaction_id, lid, old.primary_transaction_id);
    refresh(lid,[...oldTransactionIds,...next.transactions.map(t=>t.id)]);
    db.run('UPDATE advances SET replaced_by=? WHERE id=?', next.id, old.id);
    return next;
  });
}

module.exports = {create, detail, list, collect, reverse, restore, reverseCollection, restoreCollection, edit, amend, guardTransaction};
