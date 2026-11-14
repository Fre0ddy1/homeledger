'use strict';
const db=require('../../db');
function managed(lid,id){return !!db.get('SELECT account_id FROM advance_accounts WHERE ledger_id=? AND account_id=?',lid,Number(id));}
function bound(lid,id){return !!(db.get('SELECT id FROM finance_contracts WHERE ledger_id=? AND account_id=?',lid,Number(id))||db.get('SELECT account_id FROM credit_profiles WHERE ledger_id=? AND account_id=?',lid,Number(id)));}
function update(lid,acc,body){const initial=body.initial_balance!==undefined?require('../util').parseAmountToCents(body.initial_balance):body.initial_cents;if(managed(lid,acc.id)){for(const [key,value] of [['type',body.type],['currency',body.currency],['initial_cents',initial],['include_in_net',body.include_in_net===undefined?undefined:(body.include_in_net?1:0)]])if(value!==undefined&&String(value)!==String(acc[key]))throw Error('代垫待收款账户的类型、币种、期初和净资产口径由代垫台账维护');}if(!bound(lid,acc.id))return;for(const [key,value] of [['type',body.type],['currency',body.currency],['initial_cents',initial],['bill_day',body.bill_day],['due_day',body.due_day]])if(value!==undefined&&String(value||'')!==String(acc[key]||''))throw Error('此账户已关联贷款或信用卡账单，类型、币种、期初本金及账期请在贷款与信用卡中管理');}
function remove(lid,id){if(managed(lid,id))throw Error('代垫待收款账户须保留历史，请在代垫台账处理');if(bound(lid,id)||db.get('SELECT id FROM debts WHERE ledger_id=? AND account_id=?',lid,Number(id)))throw Error('账户仍被台账引用，不能删除；历史记录必须保留');}
function archive(lid,id){if(managed(lid,id))throw Error('代垫待收款账户不能停用，请在代垫台账处理');if(bound(lid,id))throw Error('此账户关联金融台账，请保留账户；贷款可在合同详情归档');}
module.exports={bound,update,remove,archive};
