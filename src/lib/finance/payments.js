'use strict';
const db=require('../../db'),c=require('./common');
function detail(lid,id,deleted=true){const p=c.row('finance_payments',lid,id,deleted);return {...p,transactions:db.all('SELECT t.*,l.role FROM finance_payment_txns l JOIN transactions t ON t.id=l.transaction_id WHERE l.payment_id=? AND t.ledger_id=? ORDER BY t.id',p.id,lid),allocations:db.all('SELECT * FROM finance_allocations WHERE ledger_id=? AND payment_id=?',lid,p.id),sources:JSON.parse(p.sources_json||'[]')};}
function guardTransaction(lid,id){if(db.get('SELECT id FROM finance_contracts WHERE ledger_id=? AND disbursement_txn_id=?',lid,Number(id)))throw Error('此流水是贷款合同的放款记录，请保留完整合同及资金依据');const link=db.get("SELECT p.deleted_at,l.role FROM finance_payment_txns l JOIN finance_payments p ON p.id=l.payment_id WHERE p.ledger_id=? AND l.transaction_id=? AND (p.deleted_at IS NULL OR l.role NOT IN ('original','linked')) LIMIT 1",lid,Number(id));if(link)throw Error('此流水属于关联付款，请在贷款与信用卡的付款详情中整体修改、撤销或恢复');}
function signature(kind,id,body){const values={kind,id:Number(id),account_id:Number(body.account_id),principal:body.principal_cents??null,amount:body.amount_cents??null,interest:body.interest_cents||0,fee:body.fee_cents||0,interest_category_id:body.interest_category_id||null,fee_category_id:body.fee_category_id||null,date:body.date||null,installment_id:body.installment_id||null,adjust_installment:body.adjust_installment||false,allocations:body.allocations||null,sourceIds:sourceIds(body)};return JSON.stringify(values);}
function sourceIds(body){const ids=body.existing_transaction_ids|| (body.existing_transaction_id?[body.existing_transaction_id]:[]);return [].concat(ids).filter(Boolean).map(Number).sort((a,b)=>a-b);}
function begin(lid,kind,id,body){const key=String(body.operation_key||'').trim().slice(0,100);if(!key)throw Error('请提供operation_key，重复提交时复用同一操作标识');const sig=signature(kind,id,body),old=db.get('SELECT * FROM finance_payments WHERE ledger_id=? AND operation_key=?',lid,key);if(old){if(old.signature!==sig)throw Error('同一操作标识的请求内容不同');return {existing:detail(lid,old.id)};}return {key,sig};}
function expenseCategory(lid,id,name){const cats=require('../categories');if(id){const r=cats.find(lid,id,true);if(!r||r.kind!=='expense')throw Error('费用须选择有效支出分类');return r.id;}const found=cats.list(lid,'expense').find(x=>x.name===name);return found?.id||cats.create(lid,{name,kind:'expense',icon:'🏦',color:'#7c73d1'});}
function prepareSources(lid,body,funding,target,amount,principal,kind){
 const ids=sourceIds(body);if(!ids.length)return {rows:[],mode:null};if(ids.length>2||new Set(ids).size!==ids.length)throw Error('一次最多关联两条独立的付款来源');
 const rows=ids.map(id=>{guardTransaction(lid,id);require('./cards').guardTransaction(lid,id);const t=db.get('SELECT * FROM transactions WHERE ledger_id=? AND id=? AND deleted_at IS NULL',lid,id);if(!t||t.debt_id||t.currency!==funding.currency||t.status!=='cleared'||Number(t.rate)!==1||t.amount_base_cents!==t.amount_cents)throw Error('来源流水无效、已有关联或币种汇率不符');return t;});
 if(rows.length===1&&rows[0].type==='transfer'){
   const t=rows[0];if(t.account_id!==funding.id||t.to_account_id!==target.id||t.amount_cents!==amount||kind==='loan'&&principal!==amount)throw Error('已有转账的账户和金额须与还款一致；本金利息合并扣款请先用来源替换预览');return {rows,mode:'link'};
 }
 const debit=rows.find(t=>t.account_id===funding.id&&['expense','fee','repay_pay'].includes(t.type)&&Number(t.amount_cents)===amount);
 const credit=rows.find(t=>t.account_id===target.id&&['income','refund','repay_receive'].includes(t.type)&&Number(t.amount_cents)===amount);
 if(!debit||rows.length===2&&!credit)throw Error('来源须为等额付款账户扣款，可再选择一条目标账户的对应入账');
 if(body.confirm_sources!==true&&body.confirm_sources!=='1')throw Error('请先预览并确认替换来源流水，原记录会保留为已替换来源');
 return {rows,mode:'replace'};
}
function sourcePreview(lid,kind,targetId,body){if(!sourceIds(body).length)throw Error('请先选择已有来源流水；尚未记账时直接记录实际付款');const funding=c.account(lid,body.account_id,{funding:true}),target=kind==='loan'?require('./loans').detail(lid,targetId).account:c.account(lid,targetId,{type:'credit',currency:funding.currency});const amount=kind==='loan'?Number(body.principal_cents||0)+Number(body.interest_cents||0)+Number(body.fee_cents||0):Number(body.amount_cents);const sources=prepareSources(lid,{...body,confirm_sources:true},funding,target,c.cents(amount),Number(body.principal_cents||0),kind);return {mode:sources.mode,source_ids:sources.rows.map(t=>t.id),original_outflow_cents:amount,new_outflow_cents:amount,new_expense_cents:kind==='loan'?Number(body.interest_cents||0)+Number(body.fee_cents||0):0,requires_confirmation:sources.mode==='replace'};}
function createRow(lid,kind,targetId,funding,p,i,f,date,request,sources){const id=db.run('INSERT INTO finance_payments(ledger_id,target_kind,target_id,account_id,principal_cents,interest_cents,fee_cents,amount_cents,txn_date,operation_key,signature,external_txn_id,created_at,sources_json,external_mode)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',lid,kind,Number(targetId),funding.id,p,i,f,p+i+f,date,request.key,request.sig,sources.rows[0]?.id||null,db.nowStr(),JSON.stringify(sources.rows),sources.mode).lastInsertRowid;return id;}
function linkTxn(id,tid,role){db.run('INSERT INTO finance_payment_txns VALUES(?,?,?)',id,tid,role);}
function cashRows(lid,uid,paymentId,funding,target,p,i,f,date,body,sources,label){
 const txn=require('../txn');
 if(sources.mode==='link'){linkTxn(paymentId,sources.rows[0].id,'linked');return;}
 for(const t of sources.rows){db.run('UPDATE transactions SET deleted_at=? WHERE id=?',db.nowStr(),t.id);linkTxn(paymentId,t.id,'original');}
 if(p){const tid=txn.createTransaction(lid,uid,{type:'transfer',amount_cents:p,account_id:funding.id,to_account_id:target.id,currency:funding.currency,txn_date:date,note:label+' · 本金',source:'finance'});linkTxn(paymentId,tid,'principal');}
 for(const [role,value,categoryName] of [['interest',i,'贷款利息'],['fee',f,'金融手续费']])if(value){const tid=txn.createTransaction(lid,uid,{type:role==='fee'?'fee':'expense',amount_cents:value,account_id:funding.id,currency:funding.currency,category_id:expenseCategory(lid,body[role+'_category_id'],categoryName),txn_date:date,note:label+' · '+(role==='fee'?'手续费':'利息'),source:'finance'});linkTxn(paymentId,tid,role);}
}
function putAllocation(lid,paymentId,kind,id,p,i=0,f=0){db.run('INSERT INTO finance_allocations(ledger_id,payment_id,target_kind,target_id,principal_cents,interest_cents,fee_cents)VALUES(?,?,?,?,?,?,?)',lid,paymentId,kind,id,p,i,f);}
function allocateLoan(lid,paymentId,loan,body,p,i,f){
 let rows=require('./loans').installments(lid,loan.id);if(body.installment_id)rows=rows.filter(x=>x.id===Number(body.installment_id));if(!rows.length)throw Error('找不到当前贷款的有效还款期次');
 if(body.adjust_installment===true||body.adjust_installment==='1'){
   if(!body.installment_id)throw Error('校正实付费用须明确选择本期');const first=rows[0];db.run('UPDATE finance_installments SET interest_cents=?,fee_cents=? WHERE id=?',first.paid_interest+i,first.paid_fee+f,first.id);rows=require('./loans').installments(lid,loan.id).filter(x=>x.id===first.id);
 }
 const explicit=body.allocations?(typeof body.allocations==='string'?JSON.parse(body.allocations):body.allocations):null;
 if(explicit){let pp=0,ii=0,ff=0;const used=new Set();for(const a of explicit){const row=rows.find(x=>x.id===Number(a.installment_id));if(!row||used.has(row.id))throw Error('期次分配无效或重复');used.add(row.id);const ap=c.cents(a.principal_cents||0,{zero:true}),ai=c.cents(a.interest_cents||0,{zero:true}),af=c.cents(a.fee_cents||0,{zero:true});if(ap>row.remaining_principal||ai>row.remaining_interest||af>row.remaining_fee)throw Error('核销分配超过该期剩余金额');putAllocation(lid,paymentId,'loan',row.id,ap,ai,af);pp+=ap;ii+=ai;ff+=af;}if(pp!==p||ii!==i||ff!==f)throw Error('各期分配之和必须等于本次本金、利息和费用');return;}
 let pp=p,ii=i,ff=f;for(const row of rows){const ap=Math.min(pp,row.remaining_principal),ai=Math.min(ii,row.remaining_interest),af=Math.min(ff,row.remaining_fee);if(ap+ai+af)putAllocation(lid,paymentId,'loan',row.id,ap,ai,af);pp-=ap;ii-=ai;ff-=af;}
 if(pp||ii||ff)throw Error('实付分项超过计划剩余金额，请先校正本期费用或调整后续计划');
}
function payLoan(lid,uid,id,body){return db.tx(()=>{
 const request=begin(lid,'loan',id,body);if(request.existing)return request.existing;
 const loan=require('./loans').detail(lid,id),funding=c.account(lid,body.account_id,{currency:loan.account.currency,funding:true}),p=c.cents(body.principal_cents||0,{zero:true}),i=c.cents(body.interest_cents||0,{zero:true}),f=c.cents(body.fee_cents||0,{zero:true}),amount=c.cents(p+i+f),date=c.date(body.date||db.todayStr());
 if(body.amount_cents!==undefined&&Number(body.amount_cents)!==amount)throw Error('本金、利息和费用之和不等于付款总额');
 const sources=prepareSources(lid,body,funding,loan.account,amount,p,'loan');const sourceDelta=sources.rows.reduce((s,t)=>s+db.txnEffects(t).filter(e=>e.accountId===loan.account.id).reduce((v,e)=>v+e.delta,0),0);if(p>Math.max(0,-(Number(loan.account.balance_cents)-sourceDelta)))throw Error('还款本金超过剩余负债');
 const paymentId=createRow(lid,'loan',id,funding,p,i,f,date,request,sources);
 allocateLoan(lid,paymentId,loan,body,p,i,f);cashRows(lid,uid,paymentId,funding,loan.account,p,i,f,date,body,sources,'贷款还款 · '+loan.name);db.recalcBalances(lid);return detail(lid,paymentId);
});}
function allocateCard(lid,paymentId,cardId,body,amount){
 const cards=require('./cards'),statements=cards.statements(lid,cardId).sort((a,b)=>a.due_date.localeCompare(b.due_date));
 const allocations=body.allocations?(typeof body.allocations==='string'?JSON.parse(body.allocations):body.allocations):null;
 if(allocations){let total=0;const used=new Set();for(const a of allocations){const s=statements.find(x=>x.id===Number(a.statement_id));if(!s||used.has(s.id)||s.dirty)throw Error('账单不属于当前信用卡、待核对或分配重复');used.add(s.id);const v=c.cents(a.amount_cents,{zero:true});if(v>s.remaining_cents)throw Error('分配超过该账单待还金额');if(v)putAllocation(lid,paymentId,'card',s.id,v);total+=v;}if(total>amount)throw Error('账单分配超过付款金额');return;}
 let remaining=amount;for(const s of statements.filter(s=>!s.dirty&&s.closing_date<=db.todayStr())){const value=Math.min(remaining,s.remaining_cents);if(value>0)putAllocation(lid,paymentId,'card',s.id,value);remaining-=value;if(!remaining)break;}
}
function payCard(lid,uid,id,body){return db.tx(()=>{
 const request=begin(lid,'card',id,body);if(request.existing)return request.existing;
 const card=c.account(lid,id,{type:'credit'});c.baseCurrency(lid,card.currency);require('./cards').profile(lid,id);const funding=c.account(lid,body.account_id,{currency:card.currency,funding:true}),amount=c.cents(body.amount_cents),date=c.date(body.date||db.todayStr());
 require('./cards').refresh(lid,id);const sources=prepareSources(lid,body,funding,card,amount,amount,'card'),paymentId=createRow(lid,'card',id,funding,amount,0,0,date,request,sources);
 cashRows(lid,uid,paymentId,funding,card,amount,0,0,date,body,sources,'信用卡还款 · '+card.name);allocateCard(lid,paymentId,id,body,amount);db.recalcBalances(lid);return detail(lid,paymentId);
});}
function reverse(lid,id){return db.tx(()=>{
 const p=c.row('finance_payments',lid,id,true);if(p.deleted_at)return detail(lid,id);const rows=detail(lid,id).transactions;
 for(const t of rows){if(t.role==='linked')continue;db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?',t.role==='original'?null:db.nowStr(),db.nowStr(),t.id);}
 db.run('UPDATE finance_payments SET deleted_at=? WHERE id=?',db.nowStr(),p.id);db.recalcBalances(lid);require('../borrowing').recalculate(lid);if(p.target_kind==='card')require('./cards').refresh(lid,p.target_id);return detail(lid,id);
});}
function restore(lid,id){return db.tx(()=>{
 const p=c.row('finance_payments',lid,id,true);if(!p.deleted_at)return detail(lid,id);if(p.replaced_by)throw Error('此付款已经更正，请查看更正记录');const allocations=detail(lid,id).allocations;
 if(p.target_kind==='loan'){const loan=require('./loans').detail(lid,p.target_id),sourceDelta=JSON.parse(p.sources_json||'[]').reduce((s,t)=>s+db.txnEffects(t).filter(e=>e.accountId===loan.account.id).reduce((v,e)=>v+e.delta,0),0);if(p.principal_cents>Math.max(0,-(Number(loan.account.balance_cents)-sourceDelta)))throw Error('恢复后会超过贷款剩余本金');for(const a of allocations){const row=loan.installments.find(i=>i.id===a.target_id);if(!row||a.principal_cents>row.remaining_principal||a.interest_cents>row.remaining_interest||a.fee_cents>row.remaining_fee)throw Error('原期次已调整或已被其他付款核销，不能自动恢复');}}
 else{const statements=require('./cards').statements(lid,p.target_id);for(const a of allocations){const s=statements.find(s=>s.id===a.target_id);if(!s||s.dirty||a.principal_cents>s.remaining_cents)throw Error('账单待核对或待还金额已变化，请重新分配');}}
 const snapshot=JSON.parse(p.sources_json||'[]');for(const old of snapshot){guardTransaction(lid,old.id);require('./cards').guardTransaction(lid,old.id);const t=db.get('SELECT * FROM transactions WHERE ledger_id=? AND id=? AND deleted_at IS NULL',lid,old.id);if(!t||t.type!==old.type||t.account_id!==old.account_id||t.to_account_id!==old.to_account_id||t.amount_cents!==old.amount_cents||t.currency!==old.currency||t.rate!==old.rate||t.amount_base_cents!==old.amount_base_cents||t.status!==old.status||t.txn_date!==old.txn_date||t.debt_id)throw Error('来源流水已变化，不能自动恢复');}
 for(const t of detail(lid,id).transactions){if(t.role==='linked')continue;db.run('UPDATE transactions SET deleted_at=?,updated_at=? WHERE id=?',t.role==='original'?db.nowStr():null,db.nowStr(),t.id);}
 db.run('UPDATE finance_payments SET deleted_at=NULL WHERE id=?',p.id);db.recalcBalances(lid);require('../borrowing').recalculate(lid);if(p.target_kind==='card')require('./cards').refresh(lid,p.target_id);return detail(lid,id);
});}
function allocate(lid,id,body){return db.tx(()=>{const p=c.row('finance_payments',lid,id);if(p.target_kind!=='card')throw Error('贷款期次须通过整体付款修改');db.run('DELETE FROM finance_allocations WHERE ledger_id=? AND payment_id=?',lid,p.id);allocateCard(lid,p.id,p.target_id,body,p.amount_cents);return detail(lid,id);});}
function amend(lid,uid,id,body){return db.tx(()=>{
 const old=c.row('finance_payments',lid,id,true);
 const params={...body,account_id:body.account_id??old.account_id,principal_cents:body.principal_cents??old.principal_cents,interest_cents:body.interest_cents??old.interest_cents,fee_cents:body.fee_cents??old.fee_cents,amount_cents:body.amount_cents??(old.target_kind==='card'?old.amount_cents:undefined),date:body.date||old.txn_date,existing_transaction_ids:JSON.parse(old.sources_json||'[]').map(t=>t.id),confirm_sources:true};
 if(old.replaced_by){const next=detail(lid,old.replaced_by);if(next.operation_key===body.operation_key&&next.signature===signature(old.target_kind,old.target_id,params))return next;throw Error('此付款已更正，请从最新更正记录继续操作');}
 if(old.deleted_at)throw Error('请先恢复付款再修改');
 reverse(lid,id);
 const next=old.target_kind==='loan'?payLoan(lid,uid,old.target_id,params):payCard(lid,uid,old.target_id,params);
 if(next.id===old.id)throw Error('更正须使用新的操作标识');db.run('UPDATE finance_payments SET replaced_by=? WHERE id=?',next.id,old.id);return next;
});}

function repaymentOptions(lid){return {targets:[...require('./cards').list(lid).filter(a=>a.due_month_offset!==null).map(a=>({target_kind:'card',target_id:a.id,name:a.name,remaining_principal_cents:Math.max(0,-a.balance_cents)})),...require('./loans').list(lid).map(l=>({target_kind:'loan',target_id:l.id,name:l.name,remaining_principal_cents:Math.max(0,-l.balance_cents)}))]};}
function repay(lid,uid,body){if(!['loan','card'].includes(body.target_kind))throw Error('请选择贷款或信用卡还款对象');return body.target_kind==='loan'?payLoan(lid,uid,body.target_id,body):payCard(lid,uid,body.target_id,body);}
module.exports={detail,guardTransaction,payLoan,payCard,repaymentOptions,repay,reverse,restore,allocate,amend,sourcePreview,expenseCategory};
