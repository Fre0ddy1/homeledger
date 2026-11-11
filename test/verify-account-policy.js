'use strict';
if(!process.env.DATA_DIR)throw Error('需要隔离DATA_DIR');
const db=require('../src/db'),txn=require('../src/lib/txn'),crypto=require('node:crypto');
let pass=0,fail=0;const check=(name,ok)=>{console.log((ok?'PASS ':'FAIL ')+name);ok?pass++:fail++;};
const uid=db.get("SELECT id FROM users WHERE username='admin'").id,lid=1;
const account=type=>db.get('SELECT id FROM accounts WHERE ledger_id=? AND type=?',lid,type).id;
const cash=account('cash'),bank=account('debit'),card=account('credit');
require('../src/lib/finance/cards').configure(lid,card,{bill_day:20,due_day:10,due_month_offset:1});
const loan=require('../src/lib/finance/loans').create(lid,uid,{name:'资格测试贷款',remaining_principal_cents:50000,term_n:2,annual_rate:0,method:'equal_principal',start_date:db.todayStr(),due_day:20});
const liabilities=[loan.account_id,...['receivable','payable'].map(type=>Number(db.run('INSERT INTO accounts(ledger_id,name,type,currency,created_at)VALUES(?,?,?,\'CNY\',?)',lid,'资格'+type,type,db.nowStr()).lastInsertRowid))];
const token='hl_policy_verify';db.run('INSERT INTO api_tokens(user_id,ledger_id,name,token_hash,token_tail,created_at)VALUES(?,?,\'资格测试\',?,\'test\',?)',uid,lid,crypto.createHash('sha256').update(token).digest('hex'),db.nowStr());
async function api(path,body){const r=await fetch('http://127.0.0.1:8099/api/open'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
let cookie='';async function page(path,form){const r=await fetch('http://127.0.0.1:8099'+path,{method:form?'POST':'GET',redirect:'manual',headers:{cookie,...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},body:form?new URLSearchParams(form):undefined});if(r.headers.getSetCookie().length)cookie=r.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');return {status:r.status,html:await r.text()};}
(async()=>{
 const body={type:'expense',amount_cents:1000,account_id:card,txn_date:db.todayStr()};let r=await api('/transactions',body);check('信用卡消费API可用',r.status===200);const valid=txn.createTransaction(lid,uid,{...body,account_id:cash});
 for(const id of liabilities)for(const type of ['expense','income','refund','fee']){r=await api('/transactions',{...body,type,account_id:id,source:'finance',channel:'finance'});check('普通'+type+'拒绝负债账户及伪造来源 #'+id,r.status===400);}
 for(const id of [card,...liabilities])for(const reverse of [false,true]){r=await api('/transactions',{...body,type:'transfer',account_id:reverse?id:cash,to_account_id:reverse?cash:id});check('普通转账两端排除负债 '+id+'/'+reverse,r.status===400);}
 r=await api('/transactions',{...body,type:'transfer',account_id:cash,to_account_id:bank});check('自有账户转账仍可用',r.status===200);
 r=await api('/transactions/'+valid,{account_id:loan.account_id});check('编辑不能绕过账户规则',r.status===400&&txn.getTransaction(valid,lid).account_id===cash);
 r=await api('/accounts');const rows=r.data.accounts;check('账户API给出记账资格',rows.find(a=>a.id===card).transaction_types.includes('expense')&&!rows.find(a=>a.id===card).transaction_types.includes('transfer')&&rows.find(a=>a.id===loan.account_id).transaction_types.length===0);
 r=await api('/finance/repayments',{target_kind:'loan',target_id:loan.id,principal_cents:1000,account_id:cash,operation_key:'policy-loan'});check('受控还款仍可减少贷款本金',r.status===200&&r.data.principal_cents===1000);
 r=await api('/finance/repayments',{target_kind:'card',target_id:card,amount_cents:500,account_id:cash,operation_key:'policy-card'});check('信用卡还款走统一入口',r.status===200);
 for(const id of liabilities){r=await api('/subscriptions',{name:'错误扣费',amount_cents:100,account_id:id,cycle:'monthly'});check('订阅保存拒绝负债账户 #'+id,r.status===400);}
 r=await api('/subscriptions',{name:'刷卡订阅',amount_cents:100,account_id:card,cycle:'monthly'});check('订阅可使用信用卡',r.status===200);
 const rule={name:'资格周期',items:[{type:'transfer',amount_cents:100,account_id:cash,to_account_id:card}],frequency:'monthly',next_run_at:'2099-01-01'};
 r=await api('/recurring',rule);check('定期转账不能替代信用卡还款',r.status===400);
 r=await api('/recurring',{...rule,items:[{type:'expense',amount_cents:100,account_id:card}]});check('定期消费仍可刷卡',r.status===200);
 const imported=require('../src/lib/importers').importRecords({ledgerId:lid,userId:uid,records:[{type:'transfer',amount_cents:300,txn_date:db.todayStr(),to_account_hint:db.get('SELECT name FROM accounts WHERE id=?',loan.account_id).name,merchant:'银行还款',note:'银行实际还款待核对',text:'银行实际还款待核对'}],autoCreateAccount:false,defaultAccountId:cash,source:'generic',fileName:'bank.csv'});check('银行导入保留已发生还款供后续核销',imported.imported===1);
 const debt=require('../src/lib/borrowing').create(lid,uid,{counterparty:'账户筛选借钱',direction:'receivable',amount_cents:1000,account_id:cash,create_txn:true});
 const login=await page('/login'),csrf=login.html.match(/name="_csrf"\s+value="([^"]+)"/)[1];await page('/login',{_csrf:csrf,username:'admin',password:'admin888'});
 r=await page('/transactions/new');const select=r.html.match(/<select name="account_id"[^>]*>([\s\S]*?)<\/select>/)[1];check('无JS支出下拉保留信用卡且排除贷款',select.includes('value="'+card+'"')&&!select.includes('value="'+loan.account_id+'"'));
 r=await page('/transactions/new?type=transfer');const transfers=[...r.html.matchAll(/<select name="(?:account_id|to_account_id)"[^>]*>([\s\S]*?)<\/select>/g)].map(m=>m[1]);check('无JS普通转账两端不展示信用卡或贷款',transfers.length>=2&&transfers.slice(0,2).every(s=>![card,...liabilities].some(id=>s.includes('value="'+id+'"'))));
 for(const path of ['/debts','/debts/'+debt.id]){r=await page(path);const accountOptions=r.html.match(/<select name="account_id"[^>]*>([\s\S]*?)<\/select>/)[1];check('借钱登记和核销下拉排除负债 '+path,![card,...liabilities].some(id=>accountOptions.includes('value="'+id+'"')));}
 const from='2020-02-02',to='2020-02-20';for(const basis of ['cashflow','consumption']){r=await page('/reports?basis='+basis+'&preset=custom&from='+from+'&to='+to+'&kind=income');check(basis+'使用同一完整工具栏',r.status===200&&r.html.includes('class="card report-toolbar"')&&r.html.includes('id="report-month"')&&r.html.includes('id="report-from"')&&r.html.includes('aria-label="收支方向"'));check(basis+'切换保留日期和方向',r.html.includes('from='+from+'&amp;to='+to)&&r.html.includes('kind=income'));}
 console.log(`\n${pass} 通过 / ${fail} 失败`);process.exitCode=fail?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
