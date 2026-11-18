'use strict';
const express=require('express');
const crypto=require('node:crypto');
const auth=require('../lib/auth');
const service=require('../lib/advances');
const fd=require('../lib/formdata');
const navigation=require('../lib/navigation');
const {parseAmountToCents}=require('../lib/util');
const {get,todayStr}=require('../db');
const router=express.Router();
router.use(auth.requireLogin);
function editUrl(primaryId, back) {
  return '/transactions/'+primaryId+'/edit?back='+encodeURIComponent(navigation.forView('txn-form',{back}).href);
}
function editReturn(lid, id, back) {
  const path = '/advances/'+id;
  const payment = get('SELECT primary_transaction_id FROM advances WHERE ledger_id=? AND id=? AND deleted_at IS NULL',lid,id);
  return payment ? editUrl(payment.primary_transaction_id,back||path) : path;
}
router.get('/',(req,res)=>res.render('advances',{title:'代垫与回收',activeNav:'advances',items:service.list(Number(res.locals.ledger.id),{includeDeleted:true})}));
router.get('/:id',(req,res)=>{
  const lid=Number(res.locals.ledger.id);let item;
  try{item=service.detail(lid,Number(req.params.id));}catch(e){return res.status(404).render('error',{title:'记录不存在',message:'未找到此账本的代垫记录。'});}
  if(!item)return res.status(404).render('error',{title:'记录不存在',message:'未找到此账本的代垫记录。'});
  if(req.query.edit==='1'&&auth.canWrite(res.locals.ledger.role)&&!item.deleted_at){
    return res.redirect(editUrl(item.primary_transaction_id,req.query.back||'/advances/'+item.id));
  }
  const form=fd.txFormData(lid,req.session.userId);
  const draft=req.session.advanceDraft;
  if(draft?.ledgerId===lid&&draft.id===item.id)delete req.session.advanceDraft;
  const attachments=require('../lib/attachments');
  const images=[...attachments.listByTxn(item.primary_transaction_id),...(item.source_transaction_id?attachments.listByTxn(item.source_transaction_id):[])];
  res.render('advance-detail',{title:'代垫详情',activeNav:'advances',item,images,form,today:todayStr(),draft:draft?.ledgerId===lid&&draft.id===item.id?draft.values:null,operationKey:crypto.randomUUID()});
});
const editFields={person:60,merchant:60,note:300,category_id:20,owner_label:20,tags:500,no_rhythm:1,amount:24,personal:24,account_id:20,txn_date:10,txn_time:8,type:12,operation_key:100};
router.post('/:id/details',auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
  const input=Object.fromEntries(Object.keys(editFields).filter(key=>req.body?.[key]!==undefined).map(key=>[key,req.body[key]]));
  if (req.body.back !== undefined && input.no_rhythm === undefined) input.no_rhythm = '0';
  try {
    const {amount,personal,...fields}=input;
    for (const [value,key,label] of [[amount,'amount_cents','付款金额'],[personal,'personal_cents','自用金额']]) {
      if(value===undefined)continue;
      if(typeof value!=='string'||!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value.trim()))throw Error('请输入有效'+label+'，最多两位小数');
      fields[key]=parseAmountToCents(value);
    }
    const next=service.edit(lid,req.session.userId,id,fields);
    if(req.session.advanceEditDraft?.ledgerId===lid&&req.session.advanceEditDraft.id===id)delete req.session.advanceEditDraft;
    auth.audit(req,next.id===id?'advance.edit_details':'advance.amend',{ledgerId:lid,entity:'advance',entityId:next.id});
    res.flash('success','代垫账单详情已保存');
    if (req.body.back === undefined) return res.redirect('/advances/'+next.id);
    const back = navigation.forView('txn-form',{back:req.body.back}).href;
    return res.redirect(back==='/advances/'+id ? '/advances/'+next.id : back);
  } catch(e) {
    const values=Object.fromEntries(Object.entries(input).filter(([,value])=>typeof value==='string').map(([key,value])=>[key,value.slice(0,editFields[key])]));
    req.session.advanceEditDraft={ledgerId:lid,id,values};
    res.flash('error',e.message);
    return res.redirect(editReturn(lid,id,req.body.back));
  }
});
router.post('/:id/amend',auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
  try{const old=service.detail(lid,id),personal=old.transactions.find(t=>t.role==='personal');const next=service.amend(lid,req.session.userId,id,{...old,type:personal?.type||'expense',category_id:personal?.category_id,person:req.body.person,amount_cents:parseAmountToCents(req.body.amount),personal_cents:parseAmountToCents(req.body.personal),operation_key:req.body.operation_key});auth.audit(req,'advance.amend',{ledgerId:lid,entity:'advance',entityId:next.id});return res.redirect('/advances/'+next.id);}catch(e){res.flash('error',e.message);res.redirect('/advances/'+id);}
});
router.post('/:id/collect',auth.requireLedgerWrite,(req,res)=>{
  const lid=Number(res.locals.ledger.id),id=Number(req.params.id);
  try{
    const r=service.collect(lid,req.session.userId,id,{amount_cents:parseAmountToCents(req.body.amount),account_id:req.body.account_id,txn_date:req.body.date,txn_time:req.body.time,excess_handling:req.body.excess_handling,excess_category_id:req.body.excess_category_id,operation_key:req.body.operation_key});
    auth.audit(req,'advance.collect',{ledgerId:lid,entity:'advance',entityId:id,detail:'代垫回收 #'+r.id});
    res.flash('success',r.excess_cents?'已回收，回本 '+(r.principal_cents/100).toFixed(2)+'，凑整差额 '+(r.excess_cents/100).toFixed(2)+' 已计收入。':'已回收，冲减待收款；不计消费收入。');
  }catch(e){req.session.advanceDraft={ledgerId:lid,id,values:{amount:req.body.amount,account_id:req.body.account_id,date:req.body.date,time:req.body.time,excess_handling:req.body.excess_handling,excess_category_id:req.body.excess_category_id,operation_key:req.body.operation_key}};res.flash('error',e.message);}
  res.redirect(req.body.return_to_edit==='1'?editReturn(lid,id,req.body.back):'/advances/'+id);
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
    res.redirect(req.body.return_to_edit==='1'?editReturn(lid,id,req.body.back):'/advances/'+id);
  });
}
module.exports=router;
