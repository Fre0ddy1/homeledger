'use strict';
// Match a whole first-person pronoun, never a prefix such as 我老公/我的朋友.
const SELF_END='(?=\\s*(?:[0-9一二三四五六七八九十百千万两零点]|人民币|[，。,.！!？?]|$))';
const receive=new RegExp('(?:归还给|还给)(?:我们|我)'+SELF_END);
const borrowed=new RegExp('借给(?:我们|我)'+SELF_END);
function classify(text){
 const s=String(text||'');
 if(/信用卡.{0,8}(还款|偿还)|还.{0,5}信用卡|偿还.{0,5}(车贷|房贷|贷款)|(车贷|房贷|贷款).{0,6}还款|还车贷|还房贷/.test(s)&&!/仅.*(利息|手续费)|只.*(利息|手续费)/.test(s))return 'finance_payment';
 if(/我(?:本人)?还给/.test(s))return 'repay_pay';
 if(/我(?:本人)?借给/.test(s))return 'lend';
 if(/收回.{0,6}借款/.test(s)||receive.test(s))return 'repay_receive';
 if(/偿还.{0,6}借款|还给|归还.{0,6}借款/.test(s))return 'repay_pay';
 if(/(?:向|跟|找)(?:我们|我)借/.test(s))return 'lend';
 if(borrowed.test(s)||/借入|向.{1,8}借|从.{1,8}借/.test(s))return 'borrow';
 if(/借出|借给/.test(s))return 'lend';
 return null;
}
function assertOrdinary(item){if(item.requires_finance_review||classify([item.note,item.merchant].join(' '))==='finance_payment')throw Error('这笔涉及贷款或信用卡还款，请到贷款与信用卡核对本金、费用及已有付款，再关联核销（/finance）');}
module.exports={classify,assertOrdinary};
