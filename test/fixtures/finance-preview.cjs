'use strict';
if(!process.env.DATA_DIR||!/data-ui-(preview|browser)/.test(process.env.DATA_DIR))throw Error('金融演示只允许隔离UI目录');
const db=require('../../src/db'),txn=require('../../src/lib/txn'),loans=require('../../src/lib/finance/loans'),cards=require('../../src/lib/finance/cards'),payments=require('../../src/lib/finance/payments'),borrow=require('../../src/lib/borrowing');
const uid=db.get("SELECT id FROM users WHERE username='admin'").id,lid=db.get('SELECT ledger_id FROM ledger_members WHERE user_id=? ORDER BY ledger_id',uid).ledger_id,cash=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'",lid).id,card=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='credit'",lid).id;
if(!db.get("SELECT id FROM finance_contracts WHERE ledger_id=? AND name='家用车贷'",lid)){
 const loan=loans.create(lid,uid,{name:'家用车贷',kind:'car',institution:'示例银行',remaining_principal_cents:12000000,term_n:36,annual_rate:3.6,method:'equal_principal',start_date:'2026-09-01',due_day:20});payments.payLoan(lid,uid,loan.id,{account_id:cash,principal_cents:100000,interest_cents:36000,operation_key:'demo-loan-paid',date:'2026-10-20'});
 cards.configure(lid,card,{bill_day:20,due_day:10,due_month_offset:1});txn.createTransaction(lid,uid,{type:'expense',amount_cents:360000,account_id:card,txn_date:'2026-10-15',note:'家电消费 · 账单示例'});cards.refresh(lid,card);const bill=cards.statements(lid,card).find(s=>s.closing_date==='2026-10-20');if(bill)cards.confirmStatement(lid,bill.id,{confirm:true,note:'示例银行账单'});payments.payCard(lid,uid,card,{account_id:cash,amount_cents:100000,operation_key:'demo-card-paid',date:'2026-11-05'});
 borrow.create(lid,uid,{counterparty:'亲友周转示例',direction:'receivable',amount_cents:500000,account_id:cash,create_txn:true,operation_key:'demo-borrowing'});
}
console.log('金融演示数据已就绪');
