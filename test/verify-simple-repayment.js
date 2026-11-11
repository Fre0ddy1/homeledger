'use strict';
if(!process.env.DATA_DIR)throw Error('需要隔离DATA_DIR');
const db=require('../src/db'),txn=require('../src/lib/txn'),cards=require('../src/lib/finance/cards'),payments=require('../src/lib/finance/payments'),loans=require('../src/lib/finance/loans');
let pass=0,fail=0;
function check(name,ok){console.log((ok?'PASS ':'FAIL ')+name);ok?pass++:fail++;}
const uid=db.get("SELECT id FROM users WHERE username='admin'").id,lid=db.createDefaultLedger(uid,'自动还款测试'),cash=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'",lid).id;
const originalToday=db.todayStr;let date='2020-01-10';db.todayStr=()=>date;
function newCard(name){const id=Number(db.run("INSERT INTO accounts(ledger_id,name,type,currency,created_at)VALUES(?,?,'credit','CNY',?)",lid,name,db.nowStr()).lastInsertRowid);cards.configure(lid,id,{bill_day:20,due_day:10,due_month_offset:1});return id;}
function add(card,type,amount,day){return txn.createTransaction(lid,uid,{type,amount_cents:amount,account_id:card,txn_date:day});}
function bill(card,close){return cards.statements(lid,card).find(row=>row.closing_date===close);}
try{
 const card=newCard('提前还款'),expense=add(card,'expense',10000,'2020-01-11');
 const request={account_id:cash,amount_cents:15000,date:'2020-01-12',operation_key:'prepay'};
 const payment=payments.payCard(lid,uid,card,request),cashAfter=db.get('SELECT balance_cents FROM accounts WHERE id=?',cash).balance_cents;
 check('未出账时自动保留预还款',payment.allocations.length===0&&cards.detail(lid,card).unallocated_cents===15000);
 date='2020-01-20';cards.refresh(lid,card);
 check('出账后无需手动分配自动抵扣',bill(card,'2020-01-20').paid_cents===10000&&cards.detail(lid,card).unallocated_cents===5000);
 check('自动抵扣不重复扣资金',db.get('SELECT balance_cents FROM accounts WHERE id=?',cash).balance_cents===cashAfter);
 add(card,'expense',8000,'2020-02-01');date='2020-02-20';cards.detail(lid,card);
 check('余款按下一期出账自动抵扣',bill(card,'2020-02-20').paid_cents===5000&&bill(card,'2020-02-20').remaining_cents===3000);
 add(card,'refund',5000,'2020-01-15');
 check('退款自动重排关联而不改还款事实',bill(card,'2020-01-20').paid_cents===5000&&bill(card,'2020-02-20').paid_cents===8000&&cards.detail(lid,card).unallocated_cents===2000&&db.get('SELECT balance_cents FROM accounts WHERE id=?',cash).balance_cents===cashAfter);
 check('同key重试不随期次推进重复付款',payments.payCard(lid,uid,card,request).id===payment.id);
 payments.reverse(lid,payment.id);check('撤销自动付款恢复全部资金和待还',bill(card,'2020-01-20').paid_cents===0&&bill(card,'2020-02-20').paid_cents===0);
 payments.restore(lid,payment.id);check('恢复自动付款按当前账单重新抵扣',bill(card,'2020-02-20').remaining_cents===0&&cards.detail(lid,card).unallocated_cents===2000);
 const zero=newCard('零额账单');const last=add(zero,'expense',1000,'2020-01-01');const zeroBill=bill(zero,'2020-01-20');payments.payCard(lid,uid,zero,{account_id:cash,amount_cents:1000,operation_key:'zero'});txn.softDelete(last,lid);
 check('删除最后消费后原账单详情仍可读取',cards.statementDetail(lid,zeroBill.id).total_cents===0);
 const manual=newCard('手动例外');add(manual,'expense',10000,'2020-01-01');add(manual,'expense',10000,'2020-02-01');
 const later=bill(manual,'2020-02-20'),specified=payments.payCard(lid,uid,manual,{account_id:cash,amount_cents:5000,operation_key:'manual',allocations:[{statement_id:later.id,amount_cents:5000}]});
 const amended=payments.amend(lid,uid,specified.id,{date:'2020-02-21',operation_key:'manual-amend'});
 check('仅改日期不覆盖手工指定账单',amended.allocation_mode==='manual'&&amended.allocations[0].target_id===later.id);
 const competing=payments.payCard(lid,uid,manual,{account_id:cash,amount_cents:10000,operation_key:'competing-auto'});
 const moved=payments.amend(lid,uid,amended.id,{date:'2020-02-22',operation_key:'manual-again'});
 check('自动付款占位不阻止手工日期更正',moved.allocations[0].target_id===later.id&&bill(manual,'2020-01-20').remaining_cents===0);
 payments.reverse(lid,moved.id);payments.restore(lid,moved.id);
 check('自动付款重排后手工安排仍可恢复',payments.detail(lid,moved.id).allocations[0].target_id===later.id);
 payments.reverse(lid,competing.id);
 const first=payments.payCard(lid,uid,manual,{account_id:cash,amount_cents:10000,operation_key:'first-auto'}),second=payments.payCard(lid,uid,manual,{account_id:cash,amount_cents:5000,operation_key:'second-auto'});
 payments.allocate(lid,first.id,{allocations:[]});
 check('手工释放后其余自动付款立即补最早账单',payments.detail(lid,second.id).allocations[0].target_id===bill(manual,'2020-01-20').id);
 const refund=newCard('跨期退款');add(refund,'expense',10000,'2020-01-01');payments.payCard(lid,uid,refund,{account_id:cash,amount_cents:10000,operation_key:'refund-credit'});add(refund,'refund',10000,'2020-02-01');add(refund,'expense',10000,'2020-03-01');date='2020-03-20';cards.refresh(lid,refund);
 check('负账单退款余额自动向后抵扣',bill(refund,'2020-03-20').remaining_cents===0&&db.get('SELECT balance_cents FROM accounts WHERE id=?',refund).balance_cents===0);
 const reminder=newCard('提醒前自动抵扣');add(reminder,'expense',1000,'2020-04-01');const reminderPay=payments.payCard(lid,uid,reminder,{account_id:cash,amount_cents:1000,operation_key:'reminder-prepay'});date='2020-04-20';require('../src/lib/scheduler').checkFinance(date);
 check('调度提醒前自动推进出账抵扣',payments.detail(lid,reminderPay.id).allocations.length===1&&bill(reminder,'2020-04-20').remaining_cents===0);
 const loan=loans.create(lid,uid,{name:'默认贷款还款',remaining_principal_cents:20000,term_n:2,annual_rate:0,method:'equal_principal',start_date:'2020-01-01',due_day:20});
 const loanBody={account_id:cash,amount_cents:10000,operation_key:'normal-loan'};const paid=payments.payLoan(lid,uid,loan.id,loanBody);
 check('贷款只传总额即可带出最近未还期',paid.principal_cents===10000&&paid.allocations.length===1);
 let partialRejected=false;try{payments.payLoan(lid,uid,loan.id,{account_id:cash,amount_cents:10000,interest_cents:500,operation_key:'partial-fee'});}catch(e){partialRejected=e.message.includes('分项');}check('不能静默覆盖调用方提供的实际利息',partialRejected);
 check('默认贷款还款重试不会记到下一期',payments.payLoan(lid,uid,loan.id,loanBody).id===paid.id);
 let rejected=false;try{payments.payLoan(lid,uid,loan.id,{...loanBody,amount_cents:9999,operation_key:'mismatch'});}catch(e){rejected=e.message.includes('分项');}check('异常实付要求明确分项不擅自猜利息',rejected);
}finally{db.todayStr=originalToday;}
async function apiChecks(){
 const crypto=require('node:crypto'),token='hl_simple_repayment';db.run("INSERT INTO api_tokens(user_id,ledger_id,name,token_hash,token_tail,created_at)VALUES(?,?,'自动还款回归',?,'test',?)",uid,lid,crypto.createHash('sha256').update(token).digest('hex'),db.nowStr());
 async function api(path,body){const response=await fetch('http://127.0.0.1:8099/api/open'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
 const contract=loans.create(lid,uid,{name:'API默认还款',remaining_principal_cents:20000,term_n:2,annual_rate:0,method:'equal_principal',start_date:'2020-01-01',due_day:20});
 let response=await api('/finance/repayment-options');const target=response.data.targets.find(t=>t.target_kind==='loan'&&t.target_id===contract.id);
 check('API提供最近未还期及建议实付',response.status===200&&target.next_installment.amount_cents===10000&&target.suggested_amount_cents===10000);
 check('信用卡API说明自动抵扣与预还金额',response.data.targets.filter(t=>t.target_kind==='card').every(t=>Number.isInteger(t.due_cents)&&Number.isInteger(t.prepaid_cents)));
 const request={target_kind:'loan',target_id:contract.id,account_id:cash,amount_cents:10000,operation_key:'api-normal-loan'};response=await api('/finance/repayments',request);
 check('统一还款API支持只传本期总额',response.status===200&&response.data.principal_cents===10000);
 const retry=await api('/finance/repayments',request);check('API重试不产生下一期还款',retry.status===200&&retry.data.id===response.data.id);
 const html=await require('ejs').renderFile(require('node:path').join(__dirname,'../src/views/partials/finance-payment-form.ejs'),{kind:'card',targetId:1,csrf:'test',operationKey:'test',today:'2020-01-01',sources:[],ledger:{currency:'CNY'},baseCurrency:'USD',form:{accounts:[{id:101,name:'账本本币账户',type:'cash',currency:'CNY'},{id:102,name:'其他币种账户',type:'cash',currency:'USD'}]},helpers:{money:value=>String(value)}});
 check('付款账户按账本币种筛选不受全站币种干扰',html.includes('账本本币账户')&&!html.includes('其他币种账户')&&html.includes('（CNY）'));
 console.log(`\n${pass} 通过 / ${fail} 失败`);process.exitCode=fail?1:0;
}
apiChecks().catch(error=>{console.error(error);process.exitCode=1;});
