'use strict';
if(!process.env.DATA_DIR)throw Error('需要隔离DATA_DIR');
const db=require('../src/db'),crypto=require('node:crypto'),txn=require('../src/lib/txn');let pass=0,fail=0;
const check=(n,v)=>{console.log((v?'PASS ':'FAIL ')+n);v?pass++:fail++;};
const uid=db.get("SELECT id FROM users WHERE username='admin'").id,lid=db.createDefaultLedger(uid,'金融API测试'),cash=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='cash'",lid).id,card=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='credit'",lid).id,token='hl_finance_api_verify';
db.run("INSERT INTO api_tokens(user_id,ledger_id,name,token_hash,token_tail,created_at)VALUES(?,?,'金融验证',?,'test',?)",uid,lid,crypto.createHash('sha256').update(token).digest('hex'),db.nowStr());
async function api(path,body){const r=await fetch('http://127.0.0.1:8099/api/open'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
(async()=>{
 const body={name:'API车贷',kind:'car',original_principal_cents:100000,remaining_principal_cents:100000,term_n:2,annual_rate:0,method:'equal_principal',start_date:'2020-01-01',due_day:31,operation_key:'create-api-loan'};
 let r=await api('/finance/loans',body);const loan=r.data;check('API创建合同及计划',r.status===200&&loan.installments.length===2);check('贷款创建幂等',(await api('/finance/loans',body)).data.id===loan.id);check('同key变更创建内容拒绝',(await api('/finance/loans',{...body,name:'变更'})).status===400);
 r=await api('/finance/loans/'+loan.id+'/payments',{principal_cents:30000,account_id:cash,operation_key:'pay-loan',date:'2026-11-12',time:'18:35'});const payment=r.data;check('API实际贷款还款',r.status===200&&payment.amount_cents===30000);check('API付款返回独立交易时刻及账户类型',payment.txn_date==='2026-11-12'&&payment.txn_time==='18:35:00'&&payment.transactions.every(t=>t.txn_time==='18:35:00')&&payment.to_account_type==='loan');check('API非法付款时刻拒绝',(await api('/finance/loans/'+loan.id+'/payments',{principal_cents:1,account_id:cash,operation_key:'invalid-payment-time',time:'25:00'})).status===400);check('明细API返回付款关联',(await api('/transactions/'+payment.transactions[0].id)).data.transaction.finance_payments[0].id===payment.id);
 check('账户API拒绝删除引用的期初负债',(await api('/accounts/'+loan.account_id+'/delete',{})).status===400);check('账户API拒绝改变金融类型',(await api('/accounts/'+loan.account_id,{type:'cash'})).status===400);
 r=await api('/finance/loans/'+loan.id+'/plan/preview',{term_n:3});check('重排先预览',r.data.schedule.length===3&&!!r.data.basis);check('无确认不能重排',(await api('/finance/loans/'+loan.id+'/plan',{term_n:3,basis:r.data.basis})).status===400);check('预览确认可重排',(await api('/finance/loans/'+loan.id+'/plan',{term_n:3,basis:r.data.basis,confirm:true})).status===200);
 check('贷款归档与恢复API',(await api('/finance/loans/'+loan.id+'/delete',{})).data.archived&&(await api('/finance/loans/'+loan.id+'/restore',{})).data.id===loan.id);
 check('信用卡配置API',(await api('/finance/cards/'+card+'/configure',{bill_day:31,due_day:15,due_month_offset:1})).status===200);
 const expense=txn.createTransaction(lid,uid,{type:'expense',amount_cents:10000,account_id:card,txn_date:'2020-01-01'});r=await api('/finance/cards/'+card+'/statements');const bill=r.data.statements.find(s=>s.closing_date==='2020-01-31');check('信用卡自动账单API',bill.computed_cents===10000);
 check('账单确认API',(await api('/finance/statements/'+bill.id+'/confirm',{confirm:true,confirmed_cents:10000})).status===200);r=await api('/finance/cards/'+card+'/payments',{amount_cents:6000,account_id:cash,operation_key:'pay-card',txn_time:'08:30:05'});const cp=r.data;check('信用卡部分还款API',cp.allocations[0].target_id===bill.id);check('信用卡付款API接受txn_time别名',cp.txn_time==='08:30:05'&&cp.transactions[0].txn_time==='08:30:05');
 check('付款重新分配API',(await api('/finance/payments/'+cp.id+'/allocate',{allocations:[{statement_id:bill.id,amount_cents:5000}]})).data.allocations[0].principal_cents===5000);
 check('付款撤销与恢复API',(await api('/finance/payments/'+cp.id+'/reverse',{confirm:true})).data.deleted_at&&(await api('/finance/payments/'+cp.id+'/restore',{})).data.deleted_at===null);
 check('撤销确认API',(await api('/finance/statements/'+bill.id+'/unconfirm',{confirm:true})).status===200);check('已还草稿移走消费需先释放分配',(await api('/finance/transactions/'+expense+'/posting',{posted_date:'2020-02-01'})).status===400);await api('/finance/payments/'+cp.id+'/allocate',{allocations:[]});check('入账日校正API',(await api('/finance/transactions/'+expense+'/posting',{posted_date:'2020-02-01'})).status===200);
 check('消费分期API',(await api('/finance/transactions/'+expense+'/installment',{term_n:2,first_closing:'2020-02-29'})).status===200);const plan=db.get('SELECT id FROM credit_plans WHERE transaction_id=?',expense);check('取消分期API',(await api('/finance/plans/'+plan.id+'/cancel',{})).status===200);
 const ruleBody={name:'每月工资',items:[{type:'income',amount_cents:100000,account_id:cash}],next_run_at:'2099-01-31',frequency:'monthly',auto_post:false};r=await api('/recurring',ruleBody);const rule=r.data.id;check('定期记账日期不再错误退回今天',r.data.next_run_at==='2099-01-31');const scheduled={scheduled_date:'2099-01-31'};r=await api('/recurring/'+rule+'/run',scheduled);const run=r.data;check('定期执行有稳定运行编号',run.run_id>0&&run.txn_ids.length===1&&run.next_run_at==='2099-02-28');check('同一期API重试不重复记账',(await api('/recurring/'+rule+'/run',scheduled)).data.run_id===run.run_id);check('执行历史API',(await api('/recurring/'+rule+'/runs')).data.runs.length===1);check('确认暂停保留历史流水',(await api('/recurring/'+rule+'/pause',{confirm:true})).data.is_active===false&&db.get('SELECT deleted_at FROM transactions WHERE id=?',run.txn_ids[0]).deleted_at===null);
 check('错误日期拒绝创建',(await api('/recurring',{...ruleBody,next_run_at:'2026-02-31'})).status===400);
 const bank=db.get("SELECT id FROM accounts WHERE ledger_id=? AND type='debit'",lid).id;const transferRule=await api('/recurring',{name:'定期转存',items:[{type:'transfer',amount_cents:1000,account_id:cash,to_account_id:bank}],frequency:'monthly',next_run_at:'2099-01-01',auto_post:false});check('API定期转账保留转入账户',transferRule.status===200);const transferRun=await api('/recurring/'+transferRule.data.id+'/run',{scheduled_date:'2099-01-01'});check('定期转账执行双边账户完整',transferRun.status===200&&db.get('SELECT to_account_id FROM transactions WHERE id=?',transferRun.data.txn_ids[0]).to_account_id===bank);
 check('跨账本金融详情拒绝',(await api('/finance/loans/999999')).status===404);

 // Native POST redirects must keep only the failed form's timing context.
 let sessionCookie='';
 async function web(method,path,form){
  const response=await fetch('http://127.0.0.1:8099'+path,{method,headers:{...(sessionCookie?{cookie:sessionCookie}:{}),...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},body:form?new URLSearchParams(form).toString():undefined,redirect:'manual'});
  const cookies=response.headers.getSetCookie();if(cookies.length)sessionCookie=cookies.map(c=>c.split(';')[0]).join('; ');
  return {status:response.status,text:await response.text(),location:response.headers.get('location')};
 }
 const csrfOf=html=>(html.match(/name="_csrf"\s+value="([^"]+)"/)||[])[1];
 function formOf(html,action){return [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m=>m[0]).find(f=>f.match(/\baction="([^"]+)"/)?.[1]===action)||'';}
 let page=await web('GET','/login');let posted=await web('POST','/login',{_csrf:csrfOf(page.text),username:'admin',password:'admin888'});
 check('原生错误回显测试会话登录',posted.status===302);
 page=await web('GET','/finance');let sessionCsrf=csrfOf(page.text);
 await web('POST','/ledgers/switch',{_csrf:sessionCsrf,ledger_id:String(lid)});
 const failedPaymentAction='/finance/loans/'+loan.id+'/payments',paymentDraftKey='native-payment-draft';
 posted=await web('POST',failedPaymentAction,{_csrf:sessionCsrf,principal:'1',account_id:String(cash),operation_key:paymentDraftKey,date:'2026-02-30',time:'19:20:21'});
 check('付款校验失败返回原对象',posted.status===302&&posted.location==='/finance/loans/'+loan.id);
 page=await web('GET','/finance');check('付款错误时间不灌入其他金融表单',!page.text.includes(paymentDraftKey));
 page=await web('GET','/finance/loans/'+loan.id);let failedForm=formOf(page.text,failedPaymentAction);
 check('原生付款失败保留日期时刻及操作标识',failedForm.includes('2026-02-30')&&failedForm.includes('19:20:21')&&failedForm.includes(paymentDraftKey)&&failedForm.includes('已保留上次提交的时间'));
 page=await web('GET','/finance/loans/'+loan.id);check('付款时间错误回显只消费一次',!formOf(page.text,failedPaymentAction).includes(paymentDraftKey));
 const otherDraftLedger=db.createDefaultLedger(uid,'原生时间草稿隔离');
 posted=await web('POST','/finance/loans',{_csrf:sessionCsrf,name:'不应创建',original_principal:'1',remaining_principal:'1',term_n:'1',annual_rate:'0',method:'equal_principal',start_date:'2026-02-30',due_day:'20',opening_mode:'disbursement',funding_account_id:String(cash),operation_key:'finance-cross-ledger-draft',time:'05:06:07'});
 await web('POST','/ledgers/switch',{_csrf:sessionCsrf,ledger_id:String(otherDraftLedger)});
 page=await web('GET','/finance');check('金融时间草稿不泄露到其他账本',!page.text.includes('finance-cross-ledger-draft')&&!page.text.includes('05:06:07'));
 await web('POST','/ledgers/switch',{_csrf:sessionCsrf,ledger_id:String(lid)});
 page=await web('GET','/finance');failedForm=formOf(page.text,'/finance/loans');
 check('原账本贷款失败恢复起始日期时刻及登记模式',failedForm.includes('2026-02-30')&&failedForm.includes('05:06:07')&&failedForm.includes('finance-cross-ledger-draft')&&/value="disbursement"\s+selected/.test(failedForm));
 const draftDebt=require('../src/lib/borrowing').create(lid,uid,{counterparty:'草稿核销',direction:'receivable',amount_cents:1000,create_txn:false});
 const debtAction='/debts/'+draftDebt.id+'/settle';
 posted=await web('POST',debtAction,{_csrf:sessionCsrf,amount:'1',account_id:String(cash),operation_key:'borrow-settle-draft',date:'2026-02-30',time:'20:21:22'});
 page=await web('GET','/debts/'+draftDebt.id);failedForm=formOf(page.text,debtAction);
 check('原生借钱核销失败保留日期时刻和操作标识',posted.location==='/debts/'+draftDebt.id&&failedForm.includes('2026-02-30')&&failedForm.includes('20:21:22')&&failedForm.includes('borrow-settle-draft'));
 check('核销草稿不灌入同页关联流水表单',!formOf(page.text,'/debts/'+draftDebt.id+'/link').includes('20:21:22'));
 await web('POST','/debts',{_csrf:sessionCsrf,direction:'payable',counterparty:'失败条目',amount:'1',operation_key:'borrow-create-draft',date:'2026-02-30',time:'06:07:08',create_txn:'0'});
 await web('POST','/ledgers/switch',{_csrf:sessionCsrf,ledger_id:String(otherDraftLedger)});
 page=await web('GET','/debts');check('借钱时间草稿不泄露到其他账本',!page.text.includes('borrow-create-draft')&&!page.text.includes('06:07:08'));
 await web('POST','/ledgers/switch',{_csrf:sessionCsrf,ledger_id:String(lid)});
 page=await web('GET','/debts');failedForm=formOf(page.text,'/debts');
 check('借钱创建失败保留时刻和原期初登记含义',failedForm.includes('2026-02-30')&&failedForm.includes('06:07:08')&&failedForm.includes('borrow-create-draft')&&/value="payable"\s+selected/.test(failedForm)&&!/name="create_txn"[^>]*\bchecked/.test(failedForm));
 page=await web('GET','/debts');check('借钱时间错误回显只消费一次',!formOf(page.text,'/debts').includes('borrow-create-draft'));
 db.run("UPDATE ledger_members SET role='viewer' WHERE ledger_id=? AND user_id=?",lid,uid);check('只读可查金融总览',(await api('/finance')).status===200);check('只读禁止贷款还款',(await api('/finance/loans/'+loan.id+'/payments',{principal_cents:1,account_id:cash,operation_key:'viewer'})).status===403);check('只读禁止账单修订',(await api('/finance/statements/'+bill.id+'/confirm',{confirm:true})).status===403);check('只读禁止定期执行',(await api('/recurring/'+rule+'/run',{scheduled_date:'2099-02-28'})).status===403);
 console.log(`\n${pass} 通过 / ${fail} 失败`);process.exitCode=fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
