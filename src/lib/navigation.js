'use strict';
function forView(view,options={},originalUrl='/'){
 const url=new URL(originalUrl,'http://localhost'),q=url.searchParams,back=q.get('back')||options.back;
 const safeBack=typeof back==='string'&&/^\/(?:transactions|accounts\/\d+|calendar|reports|search)(?:\?|$)/.test(back)&&!/[\r\n]/.test(back)?back:null;
 const result=(href,label)=>({href,label});
 if(view==='finance-statement')return result('/finance/cards/'+Number(options.statement.account_id),'返回信用卡详情');
 if(view==='finance-payment')return result('/finance/'+(options.payment.target_kind==='loan'?'loans/':'cards/')+Number(options.payment.target_id),'返回'+(options.payment.target_kind==='loan'?'贷款详情':'信用卡详情'));
 if(view==='finance-replan')return result('/finance/loans/'+Number(options.loan.id),'返回贷款详情');
 if(view==='finance-source-preview')return result(/^\b(?:loans|cards)\/\d+$/.test(options.target)?'/finance/'+options.target:'/finance','返回还款详情');
 if(['finance-loan','finance-card'].includes(view))return result('/finance','返回贷款与信用卡');
 if(view==='debt-detail')return result('/debts','返回借钱台账');
 if(view==='account-detail')return result('/accounts','返回账户列表');
 if(view==='txn-form'||view==='entry-workspace')return result(safeBack||'/transactions','返回账单列表');
 if(view==='repayment-form')return result(options.selected?'/transactions/new?type=repayment':'/transactions/new',options.selected?'返回还款对象选择':'返回记一笔');
 if(view==='subscriptions'&&options.edit)return result('/subscriptions','返回订阅列表');
 if(view==='annual')return result('/reports','返回报表分析');
 if(view==='reports'&&options.top||view==='cashflow-report'&&options.top){q.delete('top');q.delete('page');return result('/reports?'+q.toString(),'返回报表汇总');}
 if(view==='join')return result('/','返回首页');
 return null;
}
module.exports={forView};
