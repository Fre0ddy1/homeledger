'use strict';
const express=require('express'),b=require('../lib/borrowing'),auth=require('../lib/auth'),db=require('../db'),fd=require('../lib/formdata'),u=require('../lib/util');
function body(raw){return {...raw,amount_cents:raw.amount_cents===undefined?(raw.amount===undefined?undefined:u.parseAmountToCents(raw.amount)):Number(raw.amount_cents),create_txn:raw.create_txn===true||raw.create_txn==='1'};}
function routerFactory(api=false,helpers={}){
 const r=express.Router();
 const context=req=>api?{lid:req.openAuth.ledgerId,uid:req.openAuth.userId}:{lid:Number(req.res.locals.ledger.id),uid:req.session.userId};
 const write=api?helpers.requireWrite:auth.requireLedgerWrite;
 function action(name,fn){return(req,res)=>{try{const {lid,uid}=context(req),result=fn(lid,uid,req);auth.audit(req,'debt.'+name,{ledgerId:lid,entity:'debt',entityId:Number(req.params.id)||result?.id});if(api)return helpers.ok(res,result||{ok:true});res.flash('success','借钱条目已更新');res.redirect('/debts'+(req.params.id?'/'+req.params.id:''));}catch(e){if(api)return helpers.bad(res,400,e.message);res.flash('error',e.message);res.redirect('/debts'+(req.params.id?'/'+req.params.id:''));}};}
 if(!api)r.use(auth.requireLogin);
 r.get('/',(req,res)=>{const {lid}=context(req),deleted=req.query.show==='deleted',items=b.list(lid,deleted),receivable=items.filter(x=>x.direction==='receivable').reduce((s,x)=>s+x.balance_cents,0),payable=items.filter(x=>x.direction==='payable').reduce((s,x)=>s+x.balance_cents,0);if(api)return helpers.ok(res,{debts:items,receivable,payable});res.render('debts',{title:'借钱台账',activeNav:'debts',debts:items,deleted,receivable,payable,form:fd.txFormData(lid,context(req).uid),today:db.todayStr(),operationKey:require('node:crypto').randomUUID()});});
 r.get('/:id',(req,res)=>{try{const {lid,uid}=context(req),debt=b.detail(lid,req.params.id,true);if(api)return helpers.ok(res,{debt});res.render('debt-detail',{title:'借钱详情',activeNav:'debts',debt,form:fd.txFormData(lid,uid),today:db.todayStr(),operationKey:require('node:crypto').randomUUID(),unlinked:db.all("SELECT * FROM transactions WHERE ledger_id=? AND debt_id IS NULL AND deleted_at IS NULL AND type IN ('lend','borrow','repay_receive','repay_pay') ORDER BY txn_date DESC LIMIT 100",lid)});}catch(e){if(api)return helpers.bad(res,404,e.message);res.status(404).render('error',{title:'条目不存在',message:e.message});}});
 r.post('/',write,action('create',(lid,uid,req)=>b.create(lid,uid,body(req.body))));
 r.post('/:id',write,action('update',(lid,uid,req)=>b.update(lid,req.params.id,req.body)));
 r.post('/:id/settle',write,action('settle',(lid,uid,req)=>b.settle(lid,uid,req.params.id,body(req.body))));
 r.post('/:id/link',write,action('link',(lid,uid,req)=>b.link(lid,req.params.id,req.body.transaction_id,{opening_included:[true,1,'1'].includes(req.body.opening_included)})));
 r.post('/:id/delete',write,action('delete',(lid,uid,req)=>{b.archive(lid,req.params.id);return {archived:true};}));
 r.post('/:id/restore',write,action('restore',(lid,uid,req)=>{b.restore(lid,req.params.id);return {restored:true};}));
 return r;
}
module.exports={routerFactory};
