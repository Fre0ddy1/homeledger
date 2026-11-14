'use strict';
if (!process.env.DATA_DIR) throw Error('必须使用隔离DATA_DIR');
const db = require('../src/db');
const txn = require('../src/lib/txn');
const advances = require('../src/lib/advances');
const cashflow = require('../src/lib/cashflow');
const cards = require('../src/lib/finance/cards');
const guard = require('../src/lib/finance/account-guard');
let pass = 0, fail = 0;
const check = (name, result) => { console.log((result ? 'PASS ' : 'FAIL ') + name); result ? pass++ : fail++; };
const rejects = fn => { try { fn(); return false; } catch { return true; } };
const uid = db.get("SELECT id FROM users WHERE username='admin'").id;
const lid = db.createDefaultLedger(uid, '部分代垫测试');
const cash = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'", lid).id;
const card = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='credit'", lid).id;
const bank = db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='debit'", lid).id;
const balance = id => db.get('SELECT balance_cents FROM accounts WHERE id=?', id).balance_cents;
const consumption = (from='2000-01-01', to='2099-12-31') => txn.summary(lid, from, to);
const body = {amount_cents: 10000, personal_cents: 4000, person: '同事甲', account_id: cash,
  txn_date: '2026-01-20', txn_time: '18:35', operation_key: 'purchase-1'};
const mixed = advances.create(lid, uid, body);
check('付款拆成个人消费与代垫两分项', mixed.transactions.length === 2 && mixed.amount_cents === 10000 && mixed.advance_cents === 6000);
check('从付款当天只计个人消费', consumption().expense === 4000 && consumption().income === 0);
check('现金整笔扣款且新增应收，净资产仅减少个人消费', balance(cash) === -10000 && balance(mixed.receivable_account_id) === 6000);
check('现金流记录整笔流出', cashflow.summary(lid, '2026-01-01', '2026-01-31').outflow === 10000);
check('拆分分项仍只计一笔现金流出', cashflow.summary(lid, '2026-01-01', '2026-01-31').outflow_count === 1 && cashflow.daily(lid, '2026-01-01', '2026-01-31')[0].count === 1 && cashflow.analysis(lid, '2026-01-01', '2026-01-31').avg_outflow === 10000);
check('资金分项共享实际发生时刻', mixed.txn_time === '18:35:00' && mixed.transactions.every(t => t.txn_time === mixed.txn_time));
check('未回款余额为代垫本金', mixed.remaining_cents === 6000 && mixed.received_cents === 0);
check('合并付款按显示总额排序筛选而账户明细保留分项',txn.listTransactions(lid,{minCents:9000}).rows.some(t=>t.id===mixed.primary_transaction_id)&&txn.listTransactions(lid,{accountId:mixed.receivable_account_id}).rows.every(t=>t.component_view&&t.amount_cents===6000));
check('重试复用同一付款不重复扣款', advances.create(lid, uid, {...body, txn_time: '18:35:00'}).id === mixed.id && balance(cash) === -10000);
check('同操作更改金额拒绝', rejects(() => advances.create(lid, uid, {...body, personal_cents: 3000})));
check('全部自用走普通支出', rejects(() => advances.create(lid, uid, {...body, personal_cents: 10000, operation_key: 'no-advance'})));
check('负数及小数分不入账', rejects(() => advances.create(lid, uid, {...body, personal_cents: -1, operation_key: 'negative'})) && rejects(() => advances.create(lid, uid, {...body, amount_cents: 1.5, operation_key: 'fraction'})));
check('缺少对象和操作标识拒绝', rejects(() => advances.create(lid, uid, {...body, person: '', operation_key: 'empty-person'})) && rejects(() => advances.create(lid, uid, {...body, operation_key: ''})));
check('跨账本不能读取或收款', rejects(() => advances.detail(999999, mixed.id)) && rejects(() => advances.collect(999999, uid, mixed.id, {amount_cents: 1, account_id: cash, operation_key: 'bad-ledger'})));
check('代垫仅支持本位币', rejects(() => advances.create(lid, uid, {...body, currency: 'USD', operation_key: 'foreign'})));
check('不能静默把待确认付款或整笔报销转为代垫', rejects(() => advances.create(lid, uid, {...body, status: 'pending', operation_key: 'pending'})) && rejects(() => advances.create(lid, uid, {...body, is_reimbursable: true, operation_key: 'reimbursable'})));
check('拒绝同时AA分账以及不支持的付款类型', rejects(() => advances.create(lid, uid, {...body, splits: [{member_name: '甲', share_cents: 1}], operation_key: 'aa-conflict'})) && rejects(() => advances.create(lid, uid, {...body, type: 'income', operation_key: 'income-conflict'})));
check('未知时刻保持空，不伪造为创建时刻', advances.create(lid, uid, {...body, personal_cents: 0, amount_cents: 100,
  txn_time: null, operation_key: 'unknown', person: '测试全额'}).txn_time === null);
const allAdvance = advances.list(lid).find(a => a.operation_key === 'unknown');
check('全额代垫只生成转账，不造零额消费', allAdvance.transactions.length === 1 && allAdvance.transactions[0].type === 'transfer' && consumption().expense === 4000);
advances.reverse(lid, allAdvance.id);
check('撤销全额代垫恢复资金与应收', balance(cash) === -10000 && balance(mixed.receivable_account_id) === 6000);
check('代垫分项不能直接删除或修改', mixed.transactions.every(t => rejects(() => txn.softDelete(t.id, lid)) && rejects(() => txn.updateTransaction(t.id, lid, uid, {type: t.type, amount_cents: t.amount_cents, account_id: t.account_id, to_account_id: t.to_account_id, currency: t.currency, txn_date: t.txn_date}))));
db.run('UPDATE transactions SET is_reimbursable=1 WHERE id=?', mixed.primary_transaction_id);
check('即使被旧批量标记也不能将代垫消费伪造为报销收入', rejects(() => txn.markReimbursed([mixed.primary_transaction_id], lid, uid, cash)) && consumption().income === 0);
db.run('UPDATE transactions SET is_reimbursable=0 WHERE id=?', mixed.primary_transaction_id);
check('系统待收款账户不能删除或停用', rejects(() => guard.remove(lid, mixed.receivable_account_id)) && rejects(() => guard.archive(lid, mixed.receivable_account_id)));
const receivable = db.get('SELECT * FROM accounts WHERE id=?', mixed.receivable_account_id);
check('系统待收款账户不能改期初币种或净资产口径', rejects(() => guard.update(lid, receivable, {initial_cents: 1})) && rejects(() => guard.update(lid, receivable, {currency: 'USD'})) && rejects(() => guard.update(lid, receivable, {include_in_net: false})));
check('系统待收款账户允许改名称备注且未改期初不误拦', !rejects(() => guard.update(lid, receivable, {name: '新名称', note: '备注', initial_balance: '0.00', include_in_net: 1})));
check('回款拒绝信用卡账户及超额', rejects(() => advances.collect(lid, uid, mixed.id, {amount_cents: 1, account_id: card, operation_key: 'collect-credit'})) && rejects(() => advances.collect(lid, uid, mixed.id, {amount_cents: 6001, account_id: bank, operation_key: 'collect-over'})));
check('回款日期不能早于付款', rejects(() => advances.collect(lid, uid, mixed.id, {amount_cents: 1, account_id: bank, txn_date: '2026-01-19', operation_key: 'collect-early'})));
const recovery = {amount_cents: 2000, account_id: bank, txn_date: '2026-02-01', txn_time: '09:10', operation_key: 'recover-1'};
const part = advances.collect(lid, uid, mixed.id, recovery);
check('部分回款减少应收并增加到账账户', balance(bank) === 2000 && balance(mixed.receivable_account_id) === 4000 && part.advance.remaining_cents === 4000);
check('跨月回款不形成消费收入', consumption('2026-02-01', '2026-02-28').income === 0 && consumption().expense === 4000);
check('跨月回款进入资金流入', cashflow.summary(lid, '2026-02-01', '2026-02-28').inflow === 2000);
check('回款时刻及幂等请求有效', part.txn_time === '09:10:00' && advances.collect(lid, uid, mixed.id, {...recovery, txn_time: '09:10:00'}).id === part.id && balance(bank) === 2000);
check('回款同标识变参拒绝', rejects(() => advances.collect(lid, uid, mixed.id, {...recovery, amount_cents: 2001})));
check('回款流水不能直接删改', rejects(() => txn.softDelete(part.transaction_id, lid)) && rejects(() => txn.restore(part.transaction_id, lid)));
check('有有效回款不能撤销整笔付款', rejects(() => advances.reverse(lid, mixed.id)));
advances.reverseCollection(lid, part.id);
check('撤销回款恢复应收且不改消费', balance(bank) === 0 && balance(mixed.receivable_account_id) === 6000 && consumption().expense === 4000);
advances.restoreCollection(lid, part.id);
check('恢复回款重新核销且只到账一次', balance(bank) === 2000 && advances.detail(lid, mixed.id).remaining_cents === 4000);
const rest = advances.collect(lid, uid, mixed.id, {...recovery, amount_cents: 4000, operation_key: 'recover-rest'});
check('多次回款可收齐本金且不形成收入', rest.advance.remaining_cents === 0 && rest.advance.received_cents === 6000 && consumption().income === 0);
advances.reverseCollection(lid, part.id);
advances.collect(lid, uid, mixed.id, {...recovery, operation_key: 'recover-replacement'});
check('撤销后的旧回款不能超额恢复', rejects(() => advances.restoreCollection(lid, part.id)));
for (const c of advances.detail(lid, mixed.id).collections.filter(c => !c.deleted_at)) advances.reverseCollection(lid, c.id);
advances.reverse(lid, mixed.id);
check('撤销付款所有分项原子恢复', balance(cash) === 0 && balance(bank) === 0 && balance(mixed.receivable_account_id) === 0 && consumption().expense === 0);
check('付款撤销后不能恢复回款', rejects(() => advances.restoreCollection(lid, rest.id)));
check('已撤销分项不能独立恢复', mixed.transactions.every(t => rejects(() => txn.restore(t.id, lid))));
advances.restore(lid, mixed.id);
check('整体恢复付款重新生成同等资金影响', balance(cash) === -10000 && balance(mixed.receivable_account_id) === 6000 && consumption().expense === 4000);
const source = txn.createTransaction(lid, uid, {type: 'expense', amount_cents: 10000, account_id: cash,
  txn_date: '2026-03-01', txn_time: '12:11:10', merchant: '旧采购', note: '原记录'});
const sourceBody = {...body, txn_date: '2026-03-01', txn_time: '12:11:10', source_transaction_id: source,
  operation_key: 'source-split', confirm_source: true};
check('已有支出拆分须明确确认', rejects(() => advances.create(lid, uid, {...sourceBody, confirm_source: false})));
const sourceMixed = advances.create(lid, uid, sourceBody);
check('拆分已有支出不重复扣款', balance(cash) === -20000 && consumption().expense === 8000 && db.get('SELECT deleted_at FROM transactions WHERE id=?', source).deleted_at !== null);
check('保留原始流水快照与实际时刻', sourceMixed.transactions.some(t => t.id === source && t.role === 'original') && sourceMixed.txn_time === '12:11:10');
check('同一有效来源不能重复拆分', rejects(() => advances.create(lid, uid, {...sourceBody, operation_key: 'source-again'})));
advances.reverse(lid, sourceMixed.id);
check('撤销拆分还原原整笔支出而非取消原始扣款', balance(cash) === -20000 && consumption().expense === 14000 && !db.get('SELECT deleted_at FROM transactions WHERE id=?', source).deleted_at);
advances.restore(lid, sourceMixed.id);
check('恢复拆分再次替换原支出且不重复扣款', balance(cash) === -20000 && consumption().expense === 8000);
advances.reverse(lid, sourceMixed.id);
txn.updateTransaction(source, lid, uid, {type: 'expense', amount_cents: 11000, account_id: cash, txn_date: '2026-03-01', txn_time: '12:11:10'});
check('原支出已变化不能恢复旧拆分', rejects(() => advances.restore(lid, sourceMixed.id)));
const occupied = advances.create(lid, uid, {...sourceBody, amount_cents: 11000, personal_cents: 5000,
  operation_key: 'source-occupied'});
check('原支出被新的有效代垫占用后旧拆分不可恢复', rejects(() => advances.restore(lid, sourceMixed.id)) && occupied.remaining_cents === 6000);
advances.reverse(lid, occupied.id);
const swipe = advances.create(lid, uid, {...body, account_id: card, txn_date: '2020-01-05', txn_time: null, operation_key: 'card-advance'});
cards.configure(lid, card, {bill_day: 31, due_day: 15, due_month_offset: 1});
const bill = cards.statements(lid, card).find(s => s.closing_date === '2020-01-31');
check('信用卡账单保留整笔刷卡金额', bill.computed_cents === 10000 && balance(card) === -10000);
check('信用卡代垫不产生现金资金流出', cashflow.summary(lid, '2020-01-01', '2020-01-31').outflow === 0 && consumption('2020-01-01', '2020-01-31').expense === 4000);
check('代垫分项不允许单独创建信用卡分期', rejects(() => cards.installment(lid, swipe.primary_transaction_id, {term_n: 2, first_closing: '2020-01-31'})));
const cardRefund=Number(txn.createTransaction(lid,uid,{type:'refund',amount_cents:1,account_id:card,txn_date:'2020-01-06'}));
check('普通退款不能单独关联代垫个人分项破坏整体生命周期',rejects(()=>cards.correctPosting(lid,cardRefund,{refund_of_id:swipe.primary_transaction_id})));
txn.softDelete(cardRefund,lid);
cards.confirmStatement(lid, bill.id, {confirm: true});
check('确认账单后不能绕过信用卡保护撤销代垫', rejects(() => advances.reverse(lid, swipe.id)));
check('代垫分项不能单独校正银行入账日', rejects(() => cards.correctPosting(lid, swipe.primary_transaction_id, {posted_date: '2020-02-01'})));
cards.unconfirmStatement(lid, bill.id, {confirm: true});
advances.reverse(lid, swipe.id);
check('撤销信用卡代垫同时恢复负债与消费', balance(card) === 0 && consumption('2020-01-01', '2020-01-31').expense === 0);
const corrected = advances.amend(lid, uid, mixed.id, {...body, personal_cents: 3000, operation_key: 'purchase-corrected'});
check('整体更正只留一份扣款并修改应收', balance(cash) === -21000 && corrected.personal_cents === 3000 && corrected.remaining_cents === 7000);
check('整体更正重试幂等', advances.amend(lid, uid, mixed.id, {...body, personal_cents: 3000, operation_key: 'purchase-corrected'}).id === corrected.id);
check('已更正旧记录不可恢复', rejects(() => advances.restore(lid, mixed.id)));
const beforeFailedAmend = balance(cash);
check('更正校验失败原子回滚原付款', rejects(() => advances.amend(lid, uid, corrected.id,
  {...body, account_id: 999999, personal_cents: 2000, operation_key: 'invalid-correction'})) &&
  balance(cash) === beforeFailedAmend && !advances.detail(lid, corrected.id).deleted_at);
check('清单包含有效记录且可选择查看撤销历史', advances.list(lid).every(a => !a.deleted_at) && advances.list(lid, {includeDeleted: true}).some(a => a.deleted_at));
const subscriptionId = Number(db.run(`INSERT INTO subscriptions(ledger_id,name,amount_cents,next_charge_at,created_at)
  VALUES(?,'自动续费测试',1000,'2027-01-01',?)`, lid, db.nowStr()).lastInsertRowid);
const subscriptionTxn = Number(txn.createTransaction(lid, uid, {type:'expense',amount_cents:1000,account_id:cash,txn_date:'2026-11-01'}));
db.run('UPDATE transactions SET subscription_id=? WHERE id=?', subscriptionId, subscriptionTxn);
const beforeSubscriptionSplit = balance(cash);
check('订阅扣费不能绕过原业务直接拆成代垫', rejects(() => advances.create(lid, uid, {
  amount_cents:1000,personal_cents:400,person:'同事',account_id:cash,source_transaction_id:subscriptionTxn,
  confirm_source:true,operation_key:'subscription-split'})) && balance(cash)===beforeSubscriptionSplit &&
  !db.get('SELECT deleted_at FROM transactions WHERE id=?',subscriptionTxn).deleted_at);
function manualCard(name) {
  const id=Number(db.run("INSERT INTO accounts(ledger_id,name,type,currency,created_at)VALUES(?,?,'credit','CNY',?)",lid,name,db.nowStr()).lastInsertRowid);
  cards.configure(lid,id,{bill_day:31,due_day:15,due_month_offset:1});
  return id;
}
const paidSourceCard=manualCard('来源已手工核销卡');
const paidSource=Number(txn.createTransaction(lid,uid,{type:'expense',amount_cents:10000,account_id:paidSourceCard,txn_date:'2021-01-01'}));
const paidSourceBill=cards.statements(lid,paidSourceCard).find(s=>s.closing_date==='2021-01-31');
require('../src/lib/finance/payments').payCard(lid,uid,paidSourceCard,{amount_cents:8000,account_id:cash,date:'2021-02-01',
  operation_key:'manual-source-pay',allocations:[{statement_id:paidSourceBill.id,amount_cents:8000}]});
const paidSourceSplitBody={amount_cents:10000,personal_cents:4000,person:'同事',account_id:paidSourceCard,
  source_transaction_id:paidSource,confirm_source:true,operation_key:'manual-source-convert'};
const paidSourceSplit=advances.create(lid,uid,paidSourceSplitBody);
check('已手工核销80元的100元卡消费拆分40加60不会按临时40误拒',cards.statementDetail(lid,paidSourceBill.id).computed_cents===10000&&cards.statementDetail(lid,paidSourceBill.id).manual_paid_cents===8000);
const paidSourceAmend=advances.amend(lid,uid,paidSourceSplit.id,{...paidSourceSplitBody,personal_cents:3000,operation_key:'manual-source-amend'});
check('带来源代垫同额更正保留整笔账单及手工核销',paidSourceAmend.personal_cents===3000&&cards.statementDetail(lid,paidSourceBill.id).computed_cents===10000&&cards.statementDetail(lid,paidSourceBill.id).manual_paid_cents===8000);
const paidAdvanceCard=manualCard('新代垫已手工核销卡');
const paidAdvanceBody={amount_cents:10000,personal_cents:4000,person:'同事',account_id:paidAdvanceCard,
  txn_date:'2021-03-01',operation_key:'manual-new-advance'};
const paidAdvance=advances.create(lid,uid,paidAdvanceBody);
const paidAdvanceBill=cards.statements(lid,paidAdvanceCard).find(s=>s.closing_date==='2021-03-31');
require('../src/lib/finance/payments').payCard(lid,uid,paidAdvanceCard,{amount_cents:8000,account_id:cash,date:'2021-04-01',
  operation_key:'manual-advance-pay',allocations:[{statement_id:paidAdvanceBill.id,amount_cents:8000}]});
const paidAdvanceAmend=advances.amend(lid,uid,paidAdvance.id,{...paidAdvanceBody,personal_cents:3000,operation_key:'manual-new-amend'});
check('无来源代垫同额更正不会因暂时零额误拒',paidAdvanceAmend.personal_cents===3000&&cards.statementDetail(lid,paidAdvanceBill.id).computed_cents===10000&&cards.statementDetail(lid,paidAdvanceBill.id).manual_paid_cents===8000);
const beforeUnderpaidAmend=balance(paidAdvanceCard);
check('更正总额小于80元已手工核销容量仍拒绝并完整回滚',rejects(()=>advances.amend(lid,uid,paidAdvanceAmend.id,
  {...paidAdvanceBody,amount_cents:7000,personal_cents:3000,operation_key:'manual-under-capacity'}))&&balance(paidAdvanceCard)===beforeUnderpaidAmend&&
  !advances.detail(lid,paidAdvanceAmend.id).deleted_at&&cards.statementDetail(lid,paidAdvanceBill.id).computed_cents===10000&&
  !db.get('SELECT id FROM advances WHERE ledger_id=? AND operation_key=?',lid,'manual-under-capacity'));
check('更正转走旧卡付款仍校验旧账单容量并回滚',rejects(()=>advances.amend(lid,uid,paidAdvanceAmend.id,
  {...paidAdvanceBody,account_id:cash,operation_key:'manual-change-funding'}))&&balance(paidAdvanceCard)===beforeUnderpaidAmend&&
  cards.statementDetail(lid,paidAdvanceBill.id).computed_cents===10000);
check('普通整体撤销仍保护手工核销容量',rejects(()=>advances.reverse(lid,paidAdvanceAmend.id))&&!advances.detail(lid,paidAdvanceAmend.id).deleted_at);
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
