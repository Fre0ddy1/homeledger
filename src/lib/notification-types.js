'use strict';

const types = Object.freeze({
  subscription_renewal: '订阅即将扣费',
  subscription_expiry: '订阅即将到期',
  subscription_trial: '试用即将结束',
  subscription_due: '订阅到期待确认',
  subscription_blocked: '订阅自动记账异常',
  recurring: '周期账单待确认',
  budget: '预算预警与超支',
  forecast: '月末超支预测',
  debt: '应收应付到期',
  loan: '贷款还款',
  card_statement: '信用卡出账',
  card_repayment: '信用卡还款',
  daily_spend: '当天消费预警',
  goal_due: '储蓄目标临近',
  goal_reached: '储蓄目标达成',
  member_joined: '成员加入',
});

// 兼容旧通知正文的去重码，展示和新的唯一索引共用同一个解析边界。
const suffix = /\s*\|((?:sub(?:-hold|-blocked|trial)?|recurring|budget|forecast|debt|finance|goal|daily-spend):[^\s|]+)\s*$/;
function readableBody(body) {
  return String(body || '').replace(suffix, '');
}

function eventKey(body) {
  return suffix.exec(body || '')?.[1] || null;
}

module.exports = { types, readableBody, eventKey };
