'use strict';
const {all,get,run,tx,nowStr,todayStr}=require('../db');
const TYPES=['lend','borrow','repay_receive','repay_pay'];
const direction=type=>['lend','repay_receive'].includes(type)?'receivable':'payable';
function detail(lid,id,deleted=false){
  const d=get('SELECT * FROM debts WHERE ledger_id=? AND id=?'+(deleted?'':' AND deleted_at IS NULL'),lid,Number(id));
  if(!d)throw Error('借钱条目不存在或不属于当前账本');
  d.transactions=all('SELECT * FROM transactions WHERE ledger_id=? AND debt_id=? ORDER BY txn_date,id',lid,d.id);
  return d;
}
function activate(d){
  if(!d.managed)run('UPDATE debts SET managed=1,opening_cents=?,initial_principal_cents=? WHERE id=?',d.balance_cents,d.principal_cents,d.id);
}
function validateAccount(lid,id,currency='CNY'){
  require('./account-policy').validate(lid,'lend',id,null);
  const a=get('SELECT * FROM accounts WHERE ledger_id=? AND id=? AND is_archived=0',lid,Number(id));
  if(!a)throw Error('请选择当前账本有效账户');
  if(a.currency!==currency)throw Error('借钱和付款账户必须使用相同币种');
  return a;
}
function create(lid,uid,body){return tx(()=>{
  const amount=Number(body.amount_cents),name=String(body.counterparty||body.name||'').trim().slice(0,40);
  if(!name||!Number.isSafeInteger(amount)||amount<=0)throw Error('请填写对方姓名和有效金额');
  const currency=require('./finance/common').baseCurrency(lid,body.currency),dir=['receivable','借出'].includes(body.direction)?'receivable':'payable',post=body.create_txn===true;
  if(post||body.account_id)validateAccount(lid,body.account_id,currency);
  if(body.date)require('./finance/common').date(body.date);if(body.due_date)require('./finance/common').date(body.due_date);
  const key=String(body.operation_key||'').slice(0,100),signature=JSON.stringify(['create',name,dir,amount,Number(body.account_id)||null,currency,post,body.date||null,body.due_date||null,body.note||null]);
  if(key){const old=get('SELECT * FROM borrowing_operations WHERE ledger_id=? AND operation_key=?',lid,key);if(old){if(old.signature!==signature)throw Error('重复请求参数不一致');return {...detail(lid,old.debt_id,true),txn_id:old.transaction_id||null,txn_created:!!old.transaction_id,synced_to_debts:!!old.transaction_id};}}
  const id=run(`INSERT INTO debts(ledger_id,direction,counterparty,principal_cents,balance_cents,currency,account_id,due_date,status,note,created_at,opening_cents,initial_principal_cents,managed)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,lid,dir,name,post?0:amount,post?0:amount,currency,body.account_id||null,body.due_date||null,'open',String(body.note||'').slice(0,200),nowStr(),post?0:amount,post?0:amount).lastInsertRowid;
  const tid=post?require('./txn').createTransaction(lid,uid,{type:dir==='receivable'?'lend':'borrow',amount_cents:amount,account_id:body.account_id,currency,txn_date:body.date||todayStr(),merchant:name,note:body.note,debt_id:id}):0;
  if(key)run('INSERT INTO borrowing_operations VALUES(?,?,?,?,?)',lid,key,id,tid,signature);
  return {...detail(lid,id),txn_id:tid||null,txn_created:post,synced_to_debts:post};
});}
function record(lid,txnId,debtId,isNew=false){
  const t=get('SELECT * FROM transactions WHERE ledger_id=? AND id=?',lid,txnId);
  if(!TYPES.includes(t.type)){run('UPDATE transactions SET debt_id=NULL WHERE id=?',txnId);return;}
  if(Number(t.rate)!==1||t.amount_base_cents!==t.amount_cents)throw Error('借钱仅支持本位币等额流水');require('./finance/common').baseCurrency(lid,t.currency);validateAccount(lid,t.account_id,t.currency);
  const target=Number(debtId)||t.debt_id;
  if(target){
    const same=Number(target)===Number(t.debt_id),d=detail(lid,target,same);if(d.deleted_at&&!same)throw Error('已归档借钱不能接收新关联');if(d.direction!==direction(t.type))throw Error('借钱方向与流水类型不符');
    if(d.currency!==t.currency)throw Error('借钱条目与流水币种不一致');
    if(!isNew&&!same)throw Error('请通过借钱条目的关联入口确认历史流水');
    activate(d,txnId);
    run('UPDATE transactions SET debt_id=? WHERE id=?',d.id,txnId);return;
  }
  if(isNew&&['lend','borrow'].includes(t.type)){
    const id=run(`INSERT INTO debts(ledger_id,direction,counterparty,principal_cents,balance_cents,currency,account_id,status,note,created_at,opening_cents,initial_principal_cents,managed,origin_key)
      VALUES(?,?,?,?,?,?,?,'open',?,?,0,0,1,?)`,lid,direction(t.type),t.merchant||'未指定',0,0,t.currency,t.account_id,'由借钱流水建立',nowStr(),'txn:'+txnId).lastInsertRowid;
    run('UPDATE transactions SET debt_id=? WHERE id=?',id,txnId);
  }
  // Unlinked repayments remain real cash movements, explicitly awaiting a
  // relationship; a counterparty name alone is never evidence of allocation.
}
function recalculate(lid){
  for(const d of all('SELECT * FROM debts WHERE ledger_id=? AND managed=1',lid)){
    const sums=get(`SELECT COALESCE(SUM(CASE WHEN type IN ('lend','borrow') THEN amount_cents ELSE 0 END),0) AS principal,
      COALESCE(SUM(CASE WHEN type IN ('repay_receive','repay_pay') THEN amount_cents ELSE 0 END),0) AS settled
      FROM transactions WHERE ledger_id=? AND debt_id=? AND deleted_at IS NULL`,lid,d.id);
    const balance=Number(d.opening_cents||0)+Number(sums.principal)-Number(sums.settled);
    if(balance<0)throw Error('核销金额超过借钱余额，请先撤销相关收还款');
    run('UPDATE debts SET principal_cents=?,balance_cents=?,status=? WHERE id=?',Number(d.initial_principal_cents||0)+Number(sums.principal),balance,balance===0?'closed':'open',d.id);
  }

}
function settle(lid,uid,id,body){return tx(()=>{
  const key=String(body.operation_key||'').slice(0,100),signature=JSON.stringify(['settle',Number(id),body.amount_cents??null,body.account_id?Number(body.account_id):null,body.date||null,body.note||null]);
  if(key){const old=get('SELECT * FROM borrowing_operations WHERE ledger_id=? AND operation_key=?',lid,key);if(old){if(old.signature!==signature)throw Error('重复请求参数不一致');const d=detail(lid,id,true);return {id:old.transaction_id,txn_id:old.transaction_id,transaction_id:old.transaction_id,debt_id:old.debt_id,balance_cents:d.balance_cents,remaining_cents:d.balance_cents,closed:d.status==='closed'};}}
  const d=detail(lid,id),amount=Number(body.amount_cents??d.balance_cents);
  if(!Number.isSafeInteger(amount)||amount<=0)throw Error('收还款金额必须大于0');
  const account=validateAccount(lid,body.account_id||d.account_id,d.currency);
  if(body.date)require('./finance/common').date(body.date);
  if(amount>Number(d.balance_cents))throw Error('核销金额超过借钱余额');activate(d);
  const tid=require('./txn').createTransaction(lid,uid,{type:d.direction==='receivable'?'repay_receive':'repay_pay',amount_cents:amount,account_id:account.id,currency:d.currency,merchant:d.counterparty,note:body.note||'借钱核销 · '+d.counterparty,txn_date:body.date||todayStr(),debt_id:d.id});
  if(key)run('INSERT INTO borrowing_operations VALUES(?,?,?,?,?)',lid,key,d.id,tid,signature);
  const after=detail(lid,id);return {id:tid,txn_id:tid,transaction_id:tid,debt_id:d.id,balance_cents:after.balance_cents,remaining_cents:after.balance_cents,closed:after.status==='closed'};
});}
function link(lid,id,tid,options={}){return tx(()=>{
  const d=detail(lid,id),t=get('SELECT * FROM transactions WHERE ledger_id=? AND id=? AND deleted_at IS NULL',lid,Number(tid));
  if(!t||!TYPES.includes(t.type)||direction(t.type)!==d.direction)throw Error('请选择当前账本同方向的借钱流水');
  if(t.debt_id&&Number(t.debt_id)!==d.id)throw Error('此流水已经关联其他借钱条目');
  if(t.currency!==d.currency)throw Error('不支持跨币种核销');
  validateAccount(lid,t.account_id,t.currency);
  if(Number(t.debt_id)===d.id)return detail(lid,id);
  activate(d);
  if(Number(get('SELECT debt_id FROM transactions WHERE id=?',t.id).debt_id)===d.id)return detail(lid,id);
  const included=options.opening_included===true;
  if(included){const principal=['lend','borrow'].includes(t.type);run('UPDATE debts SET opening_cents=opening_cents+?,initial_principal_cents=initial_principal_cents+? WHERE id=?',principal?-t.amount_cents:t.amount_cents,principal?-t.amount_cents:0,d.id);}
  run('UPDATE transactions SET debt_id=? WHERE id=?',d.id,t.id);recalculate(lid);return detail(lid,id);
});}
function archive(lid,id){detail(lid,id);run('UPDATE debts SET deleted_at=? WHERE id=? AND ledger_id=?',nowStr(),Number(id),lid);}
function restore(lid,id){detail(lid,id,true);run('UPDATE debts SET deleted_at=NULL WHERE id=? AND ledger_id=?',Number(id),lid);recalculate(lid);return detail(lid,id);}
function update(lid,id,body){return tx(()=>{const d=detail(lid,id),name=String(body.counterparty??body.name??d.counterparty).trim().slice(0,40);if(!name)throw Error('对方姓名不能为空');if(body.due_date)require('./finance/common').date(body.due_date);activate(d);run('UPDATE debts SET counterparty=?,due_date=?,note=?,remind_enabled=? WHERE id=? AND ledger_id=?',name,body.due_date===undefined?d.due_date:(body.due_date||null),String(body.note??d.note??'').slice(0,200),body.remind_enabled===undefined?d.remind_enabled:([true,1,'1'].includes(body.remind_enabled)?1:0),d.id,lid);recalculate(lid);return detail(lid,id);});}
function list(lid,deleted=false){return all('SELECT d.*,a.name AS account_name FROM debts d LEFT JOIN accounts a ON a.id=d.account_id AND a.ledger_id=d.ledger_id WHERE d.ledger_id=? AND d.deleted_at IS '+(deleted?'NOT ':'')+'NULL ORDER BY d.status DESC,d.id DESC',lid);}
module.exports={TYPES,create,record,recalculate,detail,settle,link,archive,restore,update,list,validateAccount};
