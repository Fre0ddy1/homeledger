'use strict';

const assert = require('node:assert/strict');
if (!process.env.DATA_DIR) throw Error('必须使用隔离 DATA_DIR');
const db = require('../src/db');
const fx = require('../src/lib/fx');
const txn = require('../src/lib/txn');
const cards = require('../src/lib/finance/cards');
const payments = require('../src/lib/finance/payments');

let passed = 0;
function check(label, run) {
  run();
  console.log('PASS ' + label);
  passed++;
}

async function feed(rate, date) {
  await fx.refreshRates(async (url, options) => {
    assert.equal(url, 'https://api.frankfurter.dev/v2/rates?base=CNY');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => [{ base: 'CNY', quote: 'USD', rate, date }] };
  });
}

async function main() {
  const uid = db.get("SELECT id FROM users WHERE username='admin'").id;
  const lid = db.createDefaultLedger(uid, '外币信用卡');
  const card = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='credit'", lid).id;
  const funding = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='debit'", lid).id;
  const expense = { type: 'expense', account_id: card, currency: 'USD', amount_cents: 1000, txn_date: '2001-01-05' };
  const row = id => db.get('SELECT * FROM transactions WHERE id=?', id);
  const balance = id => db.get('SELECT balance_cents FROM accounts WHERE id=?', id).balance_cents;

  await feed(0.125, '2026-11-20');
  await feed(0.2, '2026-11-19');
  check('最新服务汇率优先于内置反向价和更早的回包', () => assert.equal(fx.quote('USD', 'CNY').rate, 8));
  await assert.rejects(fx.refreshRates(async () => { throw Error('offline'); }));
  check('更新失败保留上次成功的缓存', () => assert.equal(fx.quote('USD', 'CNY').rate, 8));

  const charge = txn.createTransaction(lid, uid, expense);
  check('记账保存原始美元金额、人民币折算及来源日期', () => {
    assert.deepEqual([row(charge).amount_cents, row(charge).amount_base_cents, row(charge).rate_source, row(charge).rate_date],
      [1000, 8000, 'frankfurter', '2026-11-20']);
    assert.equal(balance(card), -8000);
  });
  const profile = cards.configure(lid, card, { bill_day: 20, due_day: 10, due_month_offset: 1 });
  const issued = profile.statements.find(bill => bill.closing_date === '2001-01-20');
  check('启用账单管理按人民币归集已有美元消费', () => {
    assert.equal(issued.total_cents, 8000);
    assert.match(cards.statementDetail(lid, issued.id).items[0].label, /USD.*参考汇率/);
  });

  await feed(0.1, '2026-11-21');
  txn.updateTransaction(charge, lid, uid, { ...expense, note: '补备注' });
  check('新报价和备注编辑不改变已存的折算', () => assert.equal(row(charge).amount_base_cents, 8000));
  const refund = txn.createTransaction(lid, uid, { ...expense, type: 'refund', amount_cents: 200, settlement_amount_cents: 1500 });
  check('外币退款用实际人民币金额冲减账单和余额', () => {
    assert.equal(row(refund).rate_source, 'settlement');
    assert.equal(cards.statementDetail(lid, issued.id).computed_cents, 6500);
    assert.equal(balance(card), -6500);
  });
  txn.updateTransaction(refund, lid, uid, { ...expense, type: 'refund', amount_cents: 210 });
  check('只更正原币金额仍保留已填银行入账金额', () => {
    assert.equal(row(refund).amount_cents, 210);
    assert.equal(row(refund).amount_base_cents, 1500);
  });
  txn.updateTransaction(charge, lid, uid, { ...expense, settlement_amount_cents: 8237 });
  check('手工更正实际人民币入账同步到账单和余额', () => {
    assert.equal(cards.statementDetail(lid, issued.id).computed_cents, 6737);
    assert.equal(balance(card), -6737);
  });
  cards.confirmStatement(lid, issued.id, { confirm: true });
  check('已确认账单保护实际入账金额', () => {
    assert.throws(() => txn.updateTransaction(charge, lid, uid, { ...expense, settlement_amount_cents: 8300 }), /确认账单/);
    assert.equal(row(charge).amount_base_cents, 8237);
  });
  payments.payCard(lid, uid, card, { account_id: funding, amount_cents: 6737, date: '2001-02-10', operation_key: 'fx-test-payment' });
  check('按人民币实还可自动核销外币消费组成的账单', () => {
    assert.equal(cards.statementDetail(lid, issued.id).remaining_cents, 0);
    assert.equal(balance(card), 0);
    assert.equal(balance(funding), -6737);
  });

  const next = txn.createTransaction(lid, uid, { ...expense, txn_date: '2001-02-05' });
  cards.installment(lid, next, { term_n: 3, first_closing: '2001-02-20' });
  check('外币消费分期使用人民币本金，分币不丢失', () => {
    const plans = cards.detail(lid, card).plans;
    assert.equal(plans.find(plan => plan.transaction_id === next).principal_cents, 10000);
    assert.equal(cards.statementForTransaction(lid, next).reduce((s, bill) => s + bill.allocated_amount_cents, 0), 10000);
  });

  const subscription = db.run(`INSERT INTO subscriptions(ledger_id,name,amount_cents,currency,account_id,next_charge_at,created_by_user_id,created_at)
    VALUES(?,'美元订阅',1000,'USD',?,?,?,?)`, lid, card, '2001-05-05', uid, db.nowStr()).lastInsertRowid;
  const beforeCharge = balance(card);
  const run = require('../src/lib/subscriptions').runDue('2001-05-05');
  check('外币订阅自动扣费原币留档，卡余额与账单按同一人民币折算更新', () => {
    const posting = db.get('SELECT * FROM transactions WHERE subscription_id=?', subscription);
    assert.equal(run.charged, 1);
    assert.deepEqual([posting.amount_cents, posting.amount_base_cents, posting.account_amount_cents, posting.rate_source], [1000, 10000, 10000, 'frankfurter']);
    assert.equal(balance(card), beforeCharge - 10000);
    assert.equal(cards.statementForTransaction(lid, posting.id)[0].allocated_amount_cents, 10000);
    assert.equal(require('../src/lib/subscriptions').runDue('2001-05-05').charged, 0);
  });

  const assets = db.createDefaultLedger(uid, '多币种资产');
  function account(name, currency, initial, included, archived) {
    return db.run(`INSERT INTO accounts(ledger_id,name,type,currency,initial_cents,balance_cents,include_in_net,is_archived,created_at)
      VALUES(?,?,'debit',?,?,?,?,?,?)`, assets, name, currency, initial, initial, included, archived, db.nowStr()).lastInsertRowid;
  }
  const usd = account('美元账户', 'USD', 10000, 1, 0);
  account('排除账户', 'CNY', 50000, 0, 0);
  account('停用账户', 'CNY', 60000, 1, 1);
  txn.createTransaction(assets, uid, { ...expense, account_id: usd, rate: 7 });
  check('美元账户扣美元，资产合计按参考价折算，走势遵循净资产账户范围', () => {
    const overview = txn.accountOverview(assets);
    assert.equal(balance(usd), 9000);
    assert.equal(overview.net, 90000);
    assert.equal(overview.assets, 140000);
    assert.equal(txn.netWorthTrend(assets).at(-1).value, overview.net);
  });
  const cash = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'", assets).id;
  txn.createTransaction(assets, uid, { ...expense, type: 'transfer', account_id: cash, to_account_id: usd, rate: 7 });
  check('跨币种转账分别按原生币种入账，随后的重算沿用已保存金额', () => {
    db.recalcBalances(assets);
    assert.equal(balance(cash), -7000);
    assert.equal(balance(usd), 10000);
  });
  const { importRecords } = require('../src/lib/importers');
  const statementImport = {
    ledgerId: assets, userId: uid, defaultAccountId: usd, source: 'generic', fileName: 'fx-bank.csv',
    records: [{ type: 'expense', amount_cents: 10000, txn_date: '2001-05-20', txn_time: null,
      merchant: '人民币导入样例', note: null, text: '人民币导入样例' }],
  };
  const imported = importRecords(statementImport);
  await feed(0.2, '2026-11-22');
  db.recalcBalances(assets);
  check('导入保存原币账户金额，汇率变化后重算与重复导入均保持余额', () => {
    const posting = db.get("SELECT account_amount_cents FROM transactions WHERE ledger_id=? AND source='import'", assets);
    assert.equal(imported.imported, 1, JSON.stringify(imported.errors));
    assert.equal(posting.account_amount_cents, 1000);
    assert.equal(balance(usd), 9000);
    assert.equal(importRecords(statementImport).skipped, 1);
  });
  const reimbursementLedger = db.createDefaultLedger(uid, '美元报销');
  db.run("UPDATE ledgers SET currency='USD' WHERE id=?", reimbursementLedger);
  const usdCash = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'", reimbursementLedger).id;
  db.run("UPDATE accounts SET currency='USD' WHERE id=?", usdCash);
  const reimbursable = txn.createTransaction(reimbursementLedger, uid, { ...expense, account_id: usdCash, is_reimbursable: true });
  const reimbursed = txn.markReimbursed([reimbursable], reimbursementLedger, uid, usdCash);
  check('报销合计使用账本本位币入账，美元账本全额冲销原支出', () => {
    assert.deepEqual([row(reimbursed.txnId).currency, row(reimbursed.txnId).amount_base_cents, balance(usdCash)], ['USD', 1000, 0]);
  });
  console.log(`\n结果：${passed} 通过 / 0 失败`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
