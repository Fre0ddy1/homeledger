"use strict";
const path=require('node:path'),crypto=require('node:crypto');
if(!process.env.DATA_DIR || path.resolve(process.env.DATA_DIR)===path.resolve('data'))throw Error('仅允许隔离DATA_DIR运行');
const db=require('../src/db'),txn=require('../src/lib/txn'),clock=require('../src/lib/transaction-time');db.init();
let pass=0,fail=0;function check(name,ok){console.log((ok?'  PASS  ':'  FAIL  ')+name);ok?pass++:fail++;}
function rejects(name,fn){try{fn();check(name,false);}catch{check(name,true);}}
const uid=db.get('SELECT id FROM users WHERE is_admin=1 ORDER BY id').id;
const lid=Number(db.run("INSERT INTO ledgers(name,kind,currency,icon,color,owner_id,created_at)VALUES('时间回归','personal','CNY','📒','#0071e3',?,?)",uid,db.nowStr()).lastInsertRowid);db.addLedgerMember(lid,uid,'owner');
function account(name,type){return Number(db.run("INSERT INTO accounts(ledger_id,name,type,icon,currency,created_at)VALUES(?,?,?,'🏦','CNY',?)",lid,name,type,db.nowStr()).lastInsertRowid);}
const debit=account('同名银行','debit'),card=account('同名银行信用','credit'),other=account('另一储蓄卡','debit');
const base={type:'expense',amount_cents:3500,account_id:debit,txn_date:'2026-11-12'};
check('分钟规范化',clock.normalizeTime('18:35')==='18:35:00');check('秒保留',clock.normalizeTime('18:35:42')==='18:35:42');
check('未知时刻为空',clock.normalizeTime(undefined)===null);check('局部缺省保留',clock.normalizeTime(undefined,'12:00:00')==='12:00:00');check('显式清空',clock.normalizeTime(null,'12:00:00')===null);
for(const value of ['24:00','23:60','00:00:60','8:3','now'])rejects('无效时刻拒绝 '+value,()=>clock.normalizeTime(value));
check('闰年有效',clock.normalizeDate('2024-02-29')==='2024-02-29');for(const value of ['2026-02-29','2026-04-31','2026-13-01','2026-11-12T18:35'])rejects('无效日期拒绝 '+value,()=>clock.normalizeDate(value));
check('明确钟点提取',clock.extractTime('昨天18:35午饭35元')==='18:35:00');check('中文明确钟点提取',clock.extractTime('昨天下午三点半咖啡20元')==='15:30:00');check('餐时不能猜时刻',clock.extractTime('昨天午饭35元')===null);
for(const text of ['买10点券35元','昨天下午三点多咖啡20元','咖啡18点35元','大约18:35午饭35元','123:45'])check('非明确时刻不提取 '+text,clock.extractTime(text)===null&&clock.extractTimes(text).length===0);
check('标准日期与分钟时刻可提取',clock.extractTime('2026-11-12 18:35 咖啡20元')==='18:35:00');
check('标准日期与秒时刻可提取',clock.extractTime('2026-11-12 18:35:42 咖啡20元')==='18:35:42');
check('跳过非时刻词后可识别真实钟点',clock.extractTime('买10点券35元，晚上20点看电影40元')==='20:00:00');
const early=txn.createTransaction(lid,uid,{...base,txn_time:'08:20'}),late=txn.createTransaction(lid,uid,{...base,account_id:card,txn_time:'18:35:42'}),unknown=txn.createTransaction(lid,uid,base);
const original=txn.getTransaction(late,lid);check('发生时间独立保存',original.txn_date==='2026-11-12'&&original.txn_time==='18:35:42');check('创建时间未作为交易时刻',txn.getTransaction(unknown,lid).txn_time===null);check('信用卡类型中文',original.account_type==='credit'&&original.account_type_label==='信用卡');
txn.updateTransaction(late,lid,uid,{...base,account_id:card,note:'仅改备注'});let saved=txn.getTransaction(late,lid);check('服务部分更新保留时刻',saved.txn_time==='18:35:42'&&saved.created_at===original.created_at);
const order=sort=>txn.listTransactions(lid,{sort,pageSize:30}).rows.map(t=>Number(t.id));check('实际时刻倒序且未知靠后',order('date_desc').join(',')===[late,early,unknown].join(','));check('实际时刻正序且未知靠后',order('date_asc').join(',')===[early,late,unknown].join(','));
rejects('核心日期无效拒绝',()=>txn.createTransaction(lid,uid,{...base,txn_date:'2026-02-30'}));rejects('核心时刻无效拒绝',()=>txn.createTransaction(lid,uid,{...base,txn_time:'24:00'}));
const tr=txn.getTransaction(txn.createTransaction(lid,uid,{...base,type:'transfer',to_account_id:other,txn_time:'09:00'}),lid);check('转账两端类型',tr.account_type_label==='储蓄卡'&&tr.to_account_type_label==='储蓄卡');
const ai=require('../src/lib/ai');const words=ai.parseTextByRules('昨天18:35咖啡20元')[0];check('规则保留交易时刻',words.txn_time==='18:35:00');const plain=ai.normalizeItem({type:'expense',amount:35,txn_date:'2026-11-12',txn_time:'12:00',merchant:'面馆'},lid,{sourceText:'昨天午饭35元'});check('模型文字无依据时刻不采用',plain.txn_time===null);
check('多笔共享语境不能补给未指定时刻',ai.normalizeItem({type:'expense',amount:35,merchant:'晚饭',txn_time:null},lid,{sourceText:'昨天18:35咖啡20元和晚饭35元'}).txn_time===null);
check('模型伪造engine不能绕过原文依据',ai.normalizeItem({type:'expense',amount:35,engine:'rule',note:'12:00午饭35元',txn_time:'12:00'},lid,{sourceText:'昨天午饭35元'}).txn_time===null);
const token='hl_time_'+crypto.randomBytes(8).toString('hex');db.run('INSERT INTO api_tokens(user_id,ledger_id,name,token_hash,token_tail,created_at)VALUES(?,?,?, ?,?,?)',uid,lid,'时间回归',crypto.createHash('sha256').update(token).digest('hex'),'test',db.nowStr());
async function api(url,body){const r=await fetch('http://127.0.0.1:8099/api/open'+url,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
(async()=>{
 let auto=await api('/ai/bill',{text:'昨天18:35咖啡20元',confirm:true});const autoId=auto.data.ids?.[0];check('开放AI规则入账时间',!!autoId&&txn.getTransaction(autoId,lid)?.txn_time==='18:35:00');
 auto=await api('/ai/bill',{text:'昨天午饭35元',confirm:true});check('开放AI仅日期不臆造时刻',!!auto.data.ids?.[0]&&txn.getTransaction(auto.data.ids[0],lid)?.txn_time===null);
 let r=await api('/transactions',{type:'expense',amount:12,account_id:card,date:'2026-11-11',time:'21:07'});check('API写入时刻并回执',r.status===200&&r.data.transaction?.txn_time==='21:07:00');const id=r.data.id,created=r.data.transaction?.created_at;
 r=await api('/transactions/'+id,{note:'部分更新'});check('API未传时刻保留',r.data.transaction?.txn_time==='21:07:00'&&r.data.transaction?.created_at===created);
 r=await api('/transactions/'+id,{time:null});check('API显式null清空',r.status===200&&r.data.transaction?.txn_time===null);
 r=await api('/transactions/'+id,{txn_time:'19:03:04'});check('API别名时刻',r.data.transaction?.txn_time==='19:03:04');
 for(const bad of [{time:'24:00'},{date:'2026-02-30'},{date:''},{date:null}]){r=await api('/transactions/'+id,bad);check('API无效时间拒绝 '+JSON.stringify(bad),r.status===400);}
 r=await api('/transactions?sort=date_desc');const row=r.data.transactions.find(t=>Number(t.id)===Number(id));check('列表API时刻与类型',row?.txn_time==='19:03:04'&&row.account_type_label==='信用卡'&&!!row.created_at);
 r=await api('/transactions/recent');const recent=r.data.transactions.find(t=>Number(t.id)===Number(id));check('recent API保留时刻及类型',recent?.txn_time==='19:03:04'&&recent.account_type_label==='信用卡');
 const reimbursable=txn.createTransaction(lid,uid,{...base,is_reimbursable:true,txn_time:'09:01'});r=await api('/transactions/bulk-reimburse',{ids:[reimbursable],account_id:debit,date:'2026-11-10',time:'16:30'});check('报销入账实际时刻',r.status===200&&txn.getTransaction(r.data.txn_id,lid)?.txn_time==='16:30:00'&&txn.getTransaction(r.data.txn_id,lid)?.txn_date==='2026-11-10');
 r=await api('/goals',{name:'实际时间目标',target_cents:10000,account_id:debit});const goalId=r.data.id;
 r=await api('/goals/'+goalId+'/deposit',{amount_cents:100,create_txn:true,account_id:debit,date:'2026-11-10',time:'10:11'});check('目标实际入账保留时刻',r.status===200&&txn.getTransaction(r.data.txn_id,lid)?.txn_time==='10:11:00');
 r=await api('/goals/'+goalId+'/deposit',{amount_cents:100,create_txn:true,account_id:debit,date:'2026-11-10',time:'24:00'});check('目标入账错误时刻返回400且进度回滚',r.status===400&&db.get('SELECT saved_cents FROM goals WHERE id=?',goalId).saved_cents===100);
 r=await api('/ping');check('ping实例时区与当前时间',!!r.data.timezone&&/^\d{4}-\d{2}-\d{2} /.test(r.data.server_time));
 console.log(`\n结果：${pass} 通过 / ${fail} 失败`);db.db.close();process.exit(fail?1:0);
})().catch(e=>{console.error(e);db.db.close();process.exit(1);});
