'use strict';
const express=require('express');
const crypto=require('node:crypto');
const auth=require('../lib/auth');
const service=require('../lib/advances');
const fd=require('../lib/formdata');
const {parseAmountToCents}=require('../lib/util');
const {todayStr}=require('../db');
const router=express.Router();
router.use(auth.requireLogin);
router.get('/',(req,res)=>res.render('advances',{title:'代垫与回收',activeNav:'transactions',items:service.list(Number(res.locals.ledger.id),{includeDeleted:true})}));
router.get('/:id',(req,res)=>{
  const lid=Number(res.locals.ledger.id);let item;
  try{item=service.detail(lid,Number(req.params.id));}catch(e){return res.status(404).render('error',{title:'记录不存在',message:'未找到此账本的代垫记录。'});}
  if(!item)return res.status(404).render('error',{title:'记录不存在',message:'未找到此账本的代垫记录。'});
  const draft=req.session.advanceDraft;
  if(draft?.ledgerId===lid&&draft.id===item.id)delete req.session.advanceDraft;
  res.render('advance-detail',{title:'代垫详情',activeNav:'transactions',item,images:item.source_transaction_id?require('../lib/attachments').listByTxn(item.source_transaction_id):[],form:fd.txFormData(lid,req.session.userId),today:todayStr(),draft:draft?.ledgerId===lid&&draft.id===item.id?draft.values:null,operationKey:crypto.randomUUID(),amendKey:crypto.randomUUID()});
});
router.post('/:id/amend',auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
  try{const old=service.detail(lid,id),personal=old.transactions.find(t=>t.role==='personal');const next=service.amend(lid,req.session.userId,id,{...old,type:personal?.type||'expense',category_id:personal?.category_id,person:req.body.person,amount_cents:parseAmountToCents(req.body.amount),personal_cents:parseAmountToCents(req.body.personal),operation_key:req.body.operation_key});auth.audit(req,'advance.amend',{ledgerId:lid,entity:'advance',entityId:next.id});return res.redirect('/advances/'+next.id);}catch(e){res.flash('error',e.message);res.redirect('/advances/'+id);}
});
router.post('/:id/collect',auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
  try{
    const r=service.collect(lid,req.session.userId,id,{amount_cents:parseAmountToCents(req.body.amount),account_id:req.body.account_id,txn_date:req.body.date,txn_time:req.body.time,operation_key:req.body.operation_key});
    auth.audit(req,'advance.collect',{ledgerId:lid,entity:'advance',entityId:id,detail:'代垫回收 #'+r.id});
    res.flash('success','已回收，冲减待收款；不计消费收入。');
  }catch(e){req.session.advanceDraft={ledgerId:lid,id,values:{amount:req.body.amount,account_id:req.body.account_id,date:req.body.date,time:req.body.time,operation_key:req.body.operation_key}};res.flash('error',e.message);}
  res.redirect('/advances/'+id);
});
for(const action of ['reverse','restore']){
  router.post('/:id/'+action,auth.requireLedgerWrite,(req,res)=>{
    const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
    try{service[action](lid,id);auth.audit(req,'advance.'+action,{ledgerId:lid,entity:'advance',entityId:id});res.flash('success',action==='reverse'?'已整体撤销':'已恢复代垫');}catch(e){res.flash('error',e.message);}
    res.redirect('/advances/'+id);
  });
  router.post('/:id/collections/:collectionId/'+action,auth.requireLedgerWrite,(req,res)=>{
    const lid=Number(res.locals.ledger.id),id=Number(req.params.id),cid=Number(req.params.collectionId);
    try{const item=service.detail(lid,id);if(!item?.collections.some(c=>Number(c.id)===cid))throw Error('回款不属于此代垫');service[action==='reverse'?'reverseCollection':'restoreCollection'](lid,cid);auth.audit(req,'advance.collection.'+action,{ledgerId:lid,entity:'advance_collection',entityId:cid});res.flash('success',action==='reverse'?'已撤销回款':'已恢复回款');}catch(e){res.flash('error',e.message);}
    res.redirect('/advances/'+id);
  });
}
module.exports=router;
