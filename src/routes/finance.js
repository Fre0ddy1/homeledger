'use strict';
const express=require('express'),db=require('../db'),auth=require('../lib/auth'),fd=require('../lib/formdata');
const loans=require('../lib/finance/loans'),cards=require('../lib/finance/cards'),payments=require('../lib/finance/payments'),common=require('../lib/finance/common');
function input(raw){const b=common.fields(raw);if(raw.confirmed_amount!==undefined&&raw.confirmed_amount!=='')b.confirmed_cents=require('../lib/util').parseAmountToCents(raw.confirmed_amount);for(const k of ['allocations','existing_transaction_ids','schedule'])if(typeof b[k]==='string'&&b[k].trim())b[k]=JSON.parse(b[k]);else if(b[k]==='')delete b[k];if(raw.other_transaction_id)b.existing_transaction_ids=[raw.existing_transaction_id,raw.other_transaction_id].filter(Boolean).map(Number);if(raw.manual_schedule?.trim())b.schedule=raw.manual_schedule.trim().split(/\r?\n/).map(line=>{const [date,p,i='0',f='0']=line.split(/[,，]/).map(s=>s.trim());return {due_date:date,principal_cents:require('../lib/util').parseAmountToCents(p),interest_cents:require('../lib/util').parseAmountToCents(i),fee_cents:require('../lib/util').parseAmountToCents(f)};});if(raw.bill_id){const ids=[].concat(raw.bill_id),values=[].concat(raw.bill_amount||[]);b.allocations=ids.map((id,i)=>({statement_id:Number(id),amount_cents:require('../lib/util').parseAmountToCents(values[i]||'0')})).filter(a=>a.amount_cents>0);}for(const k of ['principal_cents','interest_cents','fee_cents','amount_cents','original_principal_cents','remaining_principal_cents','confirmed_cents'])if(b[k]==='')delete b[k];return b;}
function webPaymentTime(lid,body){
 if(!['auto','explicit','unknown'].includes(body.txn_time_mode))return;
 // An existing bank record owns its time; an automatic clock must not replace it.
 if(body.txn_time_mode==='auto'&&(body.existing_transaction_id||body.existing_transaction_ids?.length)){delete body.time;delete body.txn_time;return;}
 const old=body.txn_time_mode==='auto'&&body.operation_key?db.get('SELECT signature FROM finance_payments WHERE ledger_id=? AND operation_key=?',lid,String(body.operation_key).trim().slice(0,100)):null;
 body.time=old?JSON.parse(old.signature).time:require('../lib/transaction-time').manualTime(body,db.nowStr());
 delete body.txn_time;
}
function routerFactory(api=false,h={}){
 const r=express.Router(),ctx=req=>api?{lid:req.openAuth.ledgerId,uid:req.openAuth.userId}:{lid:Number(req.res.locals.ledger.id),uid:req.session.userId},write=api?h.requireWrite:auth.requireLedgerWrite;
 if(!api)r.use(auth.requireLogin);
 function failedForm(name,req){
  const id=Number(req.params.id);
  if(name==='loan.create')return {action:'/finance/loans',returnTo:'/finance'};
  if(!Number.isSafeInteger(id)||id<1)return null;
  const base=name==='loan.pay'?'/finance/loans/'+id:name==='card.pay'?'/finance/cards/'+id:name==='payment.amend'?'/finance/payments/'+id:name==='statement.charges'?'/finance/statements/'+id:name==='source.preview'&&['loans','cards'].includes(req.params.kind)?'/finance/'+req.params.kind+'/'+id:null;
  return base?{action:base+(name==='payment.amend'?'/amend':name==='statement.charges'?'/charges':'/payments'),returnTo:base}:null;
 }
 function consumeTimeDraft(req,lid){
  const draft=req.session.financeTimeDraft,path=(req.baseUrl+req.path).replace(/\/$/,'');
  if(!draft||draft.ledgerId!==lid||draft.returnTo!==path)return null;
  delete req.session.financeTimeDraft;return draft;
 }
 function rememberTimeDraft(name,req,lid){
  const form=failedForm(name,req);if(!form)return null;
  const raw={date:req.body.date??req.body.txn_date,time:req.body.time!==undefined?req.body.time:req.body.txn_time,txn_time_mode:req.body.txn_time_mode,start_date:req.body.start_date,operation_key:req.body.operation_key,...(name==='loan.create'?{opening_mode:req.body.opening_mode==='disbursement'?'disbursement':'snapshot'}:{})},values={};
  for(const [key,value]of Object.entries(raw))if(value!==undefined)values[key]=String(value??'').slice(0,key==='operation_key'?100:32);
  req.session.financeTimeDraft={...form,ledgerId:lid,values};return form.returnTo;
 }

 function get(path,load,view,title){r.get(path,(req,res)=>{try{const {lid,uid}=ctx(req),data=load(lid,req);if(api)return h.ok(res,data);res.render(view,{...data,timeDraft:consumeTimeDraft(req,lid),title,activeNav:'finance',form:fd.txFormData(lid,uid),sources:db.all("SELECT * FROM transactions WHERE ledger_id=? AND deleted_at IS NULL AND status='cleared' AND type IN ('transfer','expense','fee','repay_pay','income','refund','repay_receive') ORDER BY id DESC LIMIT 200",lid),today:db.todayStr(),operationKey:require('node:crypto').randomUUID()});}catch(e){if(api)return h.bad(res,404,e.message);res.status(404).render('error',{title:'无法打开',message:e.message});}});}
 function post(path,name,fn,destination){r.post(path,write,(req,res)=>{try{const {lid,uid}=ctx(req),body=input(req.body);if(!api&&['loan.pay','card.pay','repayment.create','source.preview'].includes(name))webPaymentTime(lid,body);if(!api&&name!=='payment.amend'&&body.time==='')delete body.time;const data=fn(lid,uid,body,req);const previous=req.session?.financeTimeDraft,form=failedForm(name,req);if(!api&&previous?.ledgerId===lid&&previous.action===form?.action)delete req.session.financeTimeDraft;auth.audit(req,'finance.'+name,{ledgerId:lid,entity:'finance',entityId:Number(req.params.id)||data?.id||data?.account?.id});if(api)return h.ok(res,data);if(name==='loan.preview')return res.render('finance-replan',{title:'确认后续计划',activeNav:'finance',loan:loans.detail(lid,req.params.id),preview:data,params:input(req.body)});if(name==='source.preview')return res.render('finance-source-preview',{title:'确认关联已有付款',activeNav:'finance',preview:data,params:body,target:req.params.kind+'/'+req.params.id});res.flash('success','已保存，资金与核销已同步');res.redirect(destination?destination(data,req):'/finance');}catch(e){if(api)return h.bad(res,400,e.message);const returnTo=rememberTimeDraft(name,req,ctx(req).lid);res.flash('error',e.message);res.redirect(returnTo||'/finance');}});}
 get('/',lid=>({loans:loans.list(lid),archivedLoans:loans.list(lid,true),cards:cards.list(lid)}),'finance','贷款与信用卡');
 if(api)get('/repayment-options',lid=>payments.repaymentOptions(lid),'finance','还款对象');else r.get('/repayment-options',(req,res)=>res.redirect('/transactions/new?type=repayment'));
 get('/loans',lid=>({loans:loans.list(lid),archivedLoans:loans.list(lid,true),cards:cards.list(lid)}),'finance','贷款与信用卡');
 get('/loans/:id',(lid,req)=>({loan:loans.detail(lid,req.params.id,true)}),'finance-loan','贷款详情');
 get('/loans/:id/installments',(lid,req)=>({loan:loans.detail(lid,req.params.id),installments:loans.installments(lid,req.params.id)}),'finance-loan','贷款期次');
 get('/cards',lid=>({loans:loans.list(lid),archivedLoans:loans.list(lid,true),cards:cards.list(lid)}),'finance','信用卡');
 get('/cards/:id',(lid,req)=>({card:cards.detail(lid,req.params.id)}),'finance-card','信用卡详情');
 get('/cards/:id/statements',(lid,req)=>({card:cards.detail(lid,req.params.id),statements:cards.statements(lid,req.params.id)}),'finance-card','信用卡账单');
 get('/statements/:id',(lid,req)=>({statement:cards.statementDetail(lid,req.params.id),revisions:db.all('SELECT * FROM credit_statement_revisions WHERE ledger_id=? AND statement_id=? ORDER BY revision DESC',lid,Number(req.params.id))}),'finance-statement','账单详情');
 get('/payments/:id',(lid,req)=>{const payment=payments.detail(lid,req.params.id);return {payment,cardStatements:payment.target_kind==='card'?cards.statements(lid,payment.target_id):[]};},'finance-payment','付款与核销');
 const loanUrl=(d,req)=>'/finance/loans/'+(req.params.id||d.id),cardUrl=(d,req)=>'/finance/cards/'+(d.account?.id||req.params.id),billUrl=(d,req)=>'/finance/statements/'+req.params.id,payUrl=d=>'/finance/payments/'+d.id;
 post('/repayments','repayment.create',(l,u,b)=>payments.repay(l,u,b),payUrl);
 post('/loans','loan.create',(l,u,b)=>{if(!b.operation_key)throw Error('请提供operation_key');return loans.create(l,u,b);},loanUrl);
 post('/loans/:id','loan.update',(l,u,b,q)=>loans.update(l,q.params.id,b),loanUrl);
 post('/loans/:id/delete','loan.archive',(l,u,b,q)=>loans.archive(l,q.params.id));
 post('/loans/:id/restore','loan.restore',(l,u,b,q)=>loans.restore(l,q.params.id),loanUrl);
 post('/loans/:id/plan/preview','loan.preview',(l,u,b,q)=>loans.previewReplan(l,q.params.id,b));
 post('/loans/:id/plan','loan.replan',(l,u,b,q)=>loans.replan(l,q.params.id,b),loanUrl);
 post('/loans/:id/payments','loan.pay',(l,u,b,q)=>payments.payLoan(l,u,q.params.id,b),payUrl);
 post('/cards/:id/configure','card.configure',(l,u,b,q)=>cards.configure(l,q.params.id,b),cardUrl);
 post('/cards/:id/refresh','card.refresh',(l,u,b,q)=>({account:{id:Number(q.params.id)},statements:cards.refresh(l,q.params.id)}),cardUrl);
 post('/cards/:id/payments','card.pay',(l,u,b,q)=>payments.payCard(l,u,q.params.id,b),payUrl);
 post('/statements/:id/confirm','statement.confirm',(l,u,b,q)=>cards.confirmStatement(l,q.params.id,b),billUrl);
 post('/statements/:id/unconfirm','statement.unconfirm',(l,u,b,q)=>cards.unconfirmStatement(l,q.params.id,b),billUrl);
 post('/statements/:id/charges','statement.charges',(l,u,b,q)=>cards.recordCharges(l,q.params.id,b,u),billUrl);
 post('/transactions/:id/posting','transaction.posting',(l,u,b,q)=>({statements:cards.correctPosting(l,q.params.id,b)}));
 post('/transactions/posting','transaction.posting',(l,u,b)=>({statements:cards.correctPosting(l,b.transaction_id,b)}));
 post('/transactions/:id/installment','card.installment',(l,u,b,q)=>cards.installment(l,q.params.id,b),cardUrl);
 post('/transactions/installment','card.installment',(l,u,b)=>cards.installment(l,b.transaction_id,b),cardUrl);
 post('/plans/:id/cancel','plan.cancel',(l,u,b,q)=>cards.cancelPlan(l,q.params.id),cardUrl);
 post('/payments/:id/allocate','payment.allocate',(l,u,b,q)=>payments.allocate(l,q.params.id,b),payUrl);
 post('/payments/:id/amend','payment.amend',(l,u,b,q)=>payments.amend(l,u,q.params.id,b),payUrl);
 post('/payments/:id/reverse','payment.reverse',(l,u,b,q)=>{if(b.confirm!==true&&b.confirm!=='1')throw Error('请确认整体撤销资金与核销');return payments.reverse(l,q.params.id);},payUrl);
 post('/payments/:id/restore','payment.restore',(l,u,b,q)=>payments.restore(l,q.params.id),payUrl);
 post('/:kind/:id/sources/preview','source.preview',(l,u,b,q)=>{if(!['loans','cards'].includes(q.params.kind))throw Error('对象无效');return payments.sourcePreview(l,q.params.kind==='loans'?'loan':'card',q.params.id,b);});
 return r;
}
module.exports={routerFactory,input};
