'use strict';
const db=require('../db'),u=require('./util');
// Only liquid household accounts participate. Moving money between two of
// these accounts has zero household cash flow; liability/investment legs do not.
const FUNDS="('cash','debit','virtual','prepaid')";
const CTE=`WITH classified AS (
 SELECT t.*,a.type AS from_type,b.type AS to_type,a.name AS account_name,b.name AS to_account_name,c.name AS category_name,pc.name AS category_parent,c.icon AS category_icon,c.color AS category_color,
 CASE WHEN a.type IN ${FUNDS} THEN 1 ELSE 0 END AS from_fund,
 CASE WHEN b.type IN ${FUNDS} THEN 1 ELSE 0 END AS to_fund,
 COALESCE(pc.name,c.name,CASE WHEN t.type IN ('income','interest','refund','reimburse') THEN '其他流入' ELSE '日常支出' END) AS category_label
 FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id AND a.ledger_id=t.ledger_id
 LEFT JOIN accounts b ON b.id=t.to_account_id AND b.ledger_id=t.ledger_id
 LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN categories pc ON pc.id=c.parent_id
 WHERE t.ledger_id=? AND t.deleted_at IS NULL AND t.status='cleared' AND t.txn_date BETWEEN ? AND ?
), effects AS (
 SELECT *,CASE
 WHEN type IN ('expense','fee','lend','repay_pay') AND from_fund=1 THEN -amount_base_cents
 WHEN type IN ('income','interest','refund','reimburse','borrow','repay_receive') AND from_fund=1 THEN amount_base_cents
 WHEN type IN ('transfer','invest_buy','invest_sell') THEN amount_base_cents*(to_fund-from_fund)
 ELSE 0 END AS delta FROM classified
)`;
function params(lid,start,end){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(start))||!/^\d{4}-\d{2}-\d{2}$/.test(String(end))||start>end)throw Error('资金流日期范围无效');return [Number(lid),start,end];}
function summary(lid,start,end){const r=db.get(CTE+` SELECT COALESCE(SUM(CASE WHEN delta>0 THEN delta ELSE 0 END),0) AS income,COALESCE(SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END),0) AS expense,COUNT(CASE WHEN delta<>0 THEN 1 END) AS count FROM effects`,...params(lid,start,end));return {...r,basis:'cashflow',inflow:r.income,outflow:r.expense,net:r.income-r.expense};}
function daily(lid,start,end){return db.all(CTE+` SELECT txn_date AS date,SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) AS income,SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) AS expense,COUNT(*) AS count FROM effects WHERE delta<>0 GROUP BY txn_date ORDER BY txn_date`,...params(lid,start,end));}
function monthly(lid,n=6,month=db.todayStr().slice(0,7)){n=Math.max(1,Math.min(36,Number(n)||6));if(!/^\d{4}-\d{2}$/.test(month))throw Error('月份无效');const first=u.addMonths(month,1-n),rows=db.all(CTE+` SELECT substr(txn_date,1,7) AS month,SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) AS income,SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) AS expense FROM effects GROUP BY month`,...params(lid,first+'-01',month+'-31'));return Array.from({length:n},(_,i)=>{const m=u.addMonths(first,i),r=rows.find(x=>x.month===m);return {month:m,income:r?.income||0,expense:r?.expense||0};});}
const GROUP=`CASE WHEN type='lend' THEN '借出' WHEN type='borrow' THEN '借入' WHEN type='repay_pay' THEN '亲友还款' WHEN type='repay_receive' THEN '收回借款'
 WHEN type IN ('transfer','invest_buy','invest_sell') AND delta<0 AND to_type='credit' THEN '信用卡还款'
 WHEN type IN ('transfer','invest_buy','invest_sell') AND delta<0 AND to_type='loan' THEN '贷款还本'
 WHEN type IN ('transfer','invest_buy','invest_sell') AND delta<0 AND to_type='investment' THEN '投资转入'
 WHEN type IN ('transfer','invest_buy','invest_sell') AND delta>0 AND from_type='investment' THEN '投资转回'
 WHEN type='transfer' AND delta>0 AND from_type='loan' THEN '贷款到账'
 WHEN type='transfer' AND delta>0 AND from_type='credit' THEN '信用卡转出'
 WHEN type IN ('transfer','invest_buy','invest_sell') THEN CASE WHEN delta>0 THEN '其他转入' ELSE '其他转出' END
 ELSE category_label END`;
function breakdown(lid,start,end,kind='expense'){return db.all(CTE+` SELECT ${GROUP} AS name,SUM(ABS(delta)) AS total,COUNT(*) AS count FROM effects WHERE delta ${kind==='income'?'>':'<'}0 GROUP BY name ORDER BY total DESC`,...params(lid,start,end)).map((r,i)=>({...r,id:null,icon:kind==='income'?'↙':'↗',color:['#0071e3','#248544','#c28c32','#8b72c5','#cd6464'][i%5]}));}
function entries(lid,start,end,{kind='expense',group='',page=1,pageSize=20}={}){page=Math.max(1,Math.floor(Number(page)||1));pageSize=Math.max(1,Math.min(80,Math.floor(Number(pageSize)||20)));const where=` WHERE delta ${kind==='income'?'>':'<'}0`+(group?` AND (${GROUP})=?`:''),args=[...params(lid,start,end),...(group?[String(group)]:[])],total=db.get(CTE+' SELECT COUNT(*) AS n FROM effects'+where,...args).n,rows=db.all(CTE+' SELECT *,SUM(CASE WHEN delta>0 THEN delta ELSE 0 END) OVER(PARTITION BY txn_date) AS cash_day_income,SUM(CASE WHEN delta<0 THEN -delta ELSE 0 END) OVER(PARTITION BY txn_date) AS cash_day_expense FROM effects'+where+' ORDER BY txn_date DESC,id DESC LIMIT ? OFFSET ?',...args,pageSize,(page-1)*pageSize).map(require('./txn').decorate);return {rows,total,page,pages:Math.max(1,Math.ceil(total/pageSize)),pageSize};}
function groupDates(rows){const groups=new Map();for(const r of rows){if(!groups.has(r.txn_date))groups.set(r.txn_date,{date:r.txn_date,income:r.cash_day_income,expense:r.cash_day_expense,items:[]});groups.get(r.txn_date).items.push(r);}return [...groups.values()];}
module.exports={summary,daily,monthly,breakdown,entries,groupDates};
