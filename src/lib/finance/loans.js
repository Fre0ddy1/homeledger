'use strict';
const db=require('../../db'),c=require('./common');
const METHODS=['equal_payment','equal_principal','interest_only','manual'];
function plan(body,principal){
  principal=c.cents(principal);const term=Number(body.term_n),rate=Number(body.annual_rate||0),method=body.method||'equal_payment',start=c.date(body.start_date),day=Number(body.due_day);
  if(!Number.isInteger(term)||term<1||term>600||!Number.isFinite(rate)||rate<0||rate>100||!METHODS.includes(method)||!Number.isInteger(day)||day<1||day>31)throw Error('请核对期数、名义年利率、还款方式和还款日');
  let first=c.monthDate(start,0,day);if(first<=start)first=c.monthDate(start,1,day);
  if(method==='manual'){
    const input=typeof body.schedule==='string'?JSON.parse(body.schedule):body.schedule;if(!Array.isArray(input)||!input.length||input.length>600)throw Error('手工计划需提供1至600期明细');
    const rows=input.map((r,i)=>({seq:i+1,due_date:c.date(r.due_date),principal_cents:c.cents(r.principal_cents,{zero:true}),interest_cents:c.cents(r.interest_cents||0,{zero:true}),fee_cents:c.cents(r.fee_cents||0,{zero:true})}));
    if(rows.reduce((s,r)=>s+r.principal_cents,0)!==principal||rows.some((r,i)=>r.due_date<start||i>0&&r.due_date<rows[i-1].due_date))throw Error('计划本金之和须等于剩余本金，日期须按顺序填写');return rows;
  }
  const r=rate/1200,payment=r===0?Math.round(principal/term):Math.round(principal*r/(1-Math.pow(1+r,-term)));let remaining=principal;
  return Array.from({length:term},(_,i)=>{
    const interest=Math.round(remaining*r);let p=method==='interest_only'?(i===term-1?remaining:0):method==='equal_principal'?Math.floor(principal/term):Math.max(0,payment-interest);
    p=i===term-1?remaining:Math.min(remaining,p);remaining-=p;
    return {seq:i+1,due_date:c.monthDate(first,i,day),principal_cents:p,interest_cents:interest,fee_cents:0};
  });
}
function installments(lid,id){return db.all(`SELECT i.*,COALESCE(SUM(CASE WHEN p.deleted_at IS NULL THEN a.principal_cents ELSE 0 END),0) AS paid_principal,
  COALESCE(SUM(CASE WHEN p.deleted_at IS NULL THEN a.interest_cents ELSE 0 END),0) AS paid_interest,COALESCE(SUM(CASE WHEN p.deleted_at IS NULL THEN a.fee_cents ELSE 0 END),0) AS paid_fee
  FROM finance_installments i LEFT JOIN finance_allocations a ON a.target_kind='loan' AND a.target_id=i.id AND a.ledger_id=i.ledger_id
  LEFT JOIN finance_payments p ON p.id=a.payment_id AND p.ledger_id=i.ledger_id
  WHERE i.ledger_id=? AND i.contract_id=? AND i.deleted_at IS NULL GROUP BY i.id ORDER BY i.due_date,i.revision,i.seq`,lid,Number(id)).map(i=>({...i,remaining_principal:i.principal_cents-i.paid_principal,remaining_interest:i.interest_cents-i.paid_interest,remaining_fee:i.fee_cents-i.paid_fee}));}
function detail(lid,id,includeDeleted=false){const loan=c.row('finance_contracts',lid,id,includeDeleted),account=c.account(lid,loan.account_id,{type:'loan'});return {...loan,account,remaining_principal_cents:Math.max(0,-Number(account.balance_cents)),installments:installments(lid,id),payments:db.all("SELECT * FROM finance_payments WHERE ledger_id=? AND target_kind='loan' AND target_id=? ORDER BY id DESC",lid,Number(id))};}
function list(lid,deleted=false){return db.all('SELECT f.*,a.balance_cents FROM finance_contracts f JOIN accounts a ON a.id=f.account_id AND a.ledger_id=f.ledger_id WHERE f.ledger_id=? AND f.deleted_at IS '+(deleted?'NOT ':'')+'NULL ORDER BY f.id DESC',lid);}
function insertPlan(lid,id,rows,revision){for(const p of rows)db.run('INSERT INTO finance_installments(ledger_id,contract_id,seq,due_date,principal_cents,interest_cents,fee_cents,revision)VALUES(?,?,?,?,?,?,?,?)',lid,id,p.seq,p.due_date,p.principal_cents,p.interest_cents,p.fee_cents,revision);}
function create(lid,uid,body){return db.tx(()=>{
  const key=String(body.operation_key||'').trim().slice(0,100),signature=JSON.stringify(Object.keys(body).filter(k=>k!=='_csrf').sort().map(k=>[k,body[k]]));
  if(key){const old=db.get('SELECT * FROM finance_create_operations WHERE ledger_id=? AND operation_key=?',lid,key);if(old){if(old.signature!==signature)throw Error('同一操作标识的贷款参数不同');return detail(lid,old.contract_id,true);}}
  const name=String(body.name||'').trim().slice(0,60);if(!name)throw Error('请填写贷款名称');const remaining=c.cents(body.remaining_principal_cents??body.original_principal_cents),original=c.cents(body.original_principal_cents??remaining);if(original<remaining)throw Error('原始本金不能小于剩余本金');
  const currency=c.baseCurrency(lid,body.currency),schedule=plan(body,remaining);let account;
  if(body.account_id){account=c.account(lid,body.account_id,{type:'loan',currency});if(Number(account.balance_cents)!==-remaining)throw Error('已有贷款账户余额与剩余本金不一致，请先核对账户，不会自动改写余额');}
  else{const snapshot=body.opening_mode!=='disbursement',initial=snapshot?-remaining:0;const accountId=db.run("INSERT INTO accounts(ledger_id,name,type,icon,currency,initial_cents,balance_cents,created_at)VALUES(?,?,'loan','🏦',?,?,?,?)",lid,name,currency,initial,initial,db.nowStr()).lastInsertRowid;account=c.account(lid,accountId);}
  const id=db.run('INSERT INTO finance_contracts(ledger_id,account_id,name,kind,institution,original_principal_cents,annual_rate,term_n,method,start_date,due_day,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',lid,account.id,name,['car','mortgage','loan'].includes(body.kind)?body.kind:'loan',String(body.institution||'').slice(0,60),original,Number(body.annual_rate||0),schedule.length,body.method||'equal_payment',c.date(body.start_date),Number(body.due_day),db.nowStr()).lastInsertRowid;
  insertPlan(lid,id,schedule,1);
  if(body.opening_mode==='disbursement'){
    if(body.account_id)throw Error('已有账户请使用余额接管模式，不能重复放款');
    const funding=c.account(lid,body.funding_account_id,{currency,funding:true});const tid=require('../txn').createTransaction(lid,uid,{type:'transfer',amount_cents:remaining,account_id:account.id,to_account_id:funding.id,currency,txn_date:c.date(body.start_date),note:'贷款放款 · '+name,source:'loan'},{channel:'finance'});db.run('UPDATE finance_contracts SET disbursement_txn_id=? WHERE id=?',tid,id);
  }
  if(key)db.run('INSERT INTO finance_create_operations VALUES(?,?,?,?)',lid,key,id,signature);
  return detail(lid,id);
});}
function update(lid,id,body){const old=c.row('finance_contracts',lid,id);const name=String(body.name??old.name).trim().slice(0,60);if(!name)throw Error('贷款名称不能为空');db.run('UPDATE finance_contracts SET name=?,institution=?,remind_enabled=? WHERE ledger_id=? AND id=?',name,String(body.institution??old.institution??'').slice(0,60),body.remind_enabled===undefined?old.remind_enabled:([1,'1',true].includes(body.remind_enabled)?1:0),lid,old.id);return detail(lid,id);}
function previewReplan(lid,id,body){const loan=detail(lid,id);if(!loan.remaining_principal_cents)throw Error('本金已结清');const params={...loan,...body};return {loan_id:loan.id,remaining_principal_cents:loan.remaining_principal_cents,schedule:plan(params,loan.remaining_principal_cents),basis:require('node:crypto').createHash('sha256').update(JSON.stringify([loan.account.balance_cents,loan.installments])).digest('hex')};}
function replan(lid,id,body){return db.tx(()=>{
  const loan=detail(lid,id),preview=previewReplan(lid,id,body);if(body.confirm!==true&&body.confirm!=='1')throw Error('请先预览并确认后续还款计划');if(!body.basis||body.basis!==preview.basis)throw Error('贷款余额或计划已变化，请重新预览');
  const revision=Math.max(0,...loan.installments.map(i=>i.revision))+1;
  db.run('INSERT INTO finance_plan_revisions(ledger_id,contract_id,snapshot_json,created_at)VALUES(?,?,?,?)',lid,loan.id,JSON.stringify(loan.installments),db.nowStr());
  for(const i of loan.installments){if(i.paid_principal+i.paid_interest+i.paid_fee>0)db.run('UPDATE finance_installments SET principal_cents=?,interest_cents=?,fee_cents=? WHERE id=?',i.paid_principal,i.paid_interest,i.paid_fee,i.id);else db.run('UPDATE finance_installments SET deleted_at=? WHERE id=?',db.nowStr(),i.id);}
  insertPlan(lid,id,preview.schedule,revision);db.run('UPDATE finance_contracts SET term_n=?,method=?,annual_rate=?,start_date=?,due_day=? WHERE id=?',preview.schedule.length,body.method||loan.method,Number(body.annual_rate??loan.annual_rate),body.start_date||loan.start_date,Number(body.due_day??loan.due_day),loan.id);return detail(lid,id);
});}
function archive(lid,id){c.row('finance_contracts',lid,id);db.run('UPDATE finance_contracts SET deleted_at=? WHERE ledger_id=? AND id=?',db.nowStr(),lid,Number(id));return {archived:true};}
function restore(lid,id){c.row('finance_contracts',lid,id,true);db.run('UPDATE finance_contracts SET deleted_at=NULL WHERE ledger_id=? AND id=?',lid,Number(id));return detail(lid,id);}
module.exports={plan,create,detail,list,installments,update,previewReplan,replan,archive,restore};
