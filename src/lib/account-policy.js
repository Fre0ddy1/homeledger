'use strict';
// 普通记账与受控金融服务共用账户资格；channel 仅由服务调用传入，不读取请求正文。
const DEBT = new Set(['loan','receivable','payable']);
const TWO_SIDED = new Set(['transfer','invest_buy','invest_sell']);
function reject(message) {
  const error = Error(message);
  error.status = 400;
  throw error;
}
function allowed(type, accountType, channel = 'ordinary') {
  if (channel === 'finance') return true;
  // 导入保留银行已发生的还款/放款事实，之后由金融服务关联核销。
  if (channel === 'import') {
    if (type === 'transfer' && ['loan','credit'].includes(accountType)) return true;
    if (accountType === 'loan' && ['income','refund','repay_receive'].includes(type)) return true;
  }
  if (DEBT.has(accountType)) return false;
  if (accountType === 'credit' && (TWO_SIDED.has(type) || ['lend','borrow','repay_pay','repay_receive','adjust'].includes(type))) return false;
  return true;
}
function validate(ledgerId, type, accountId, toAccountId, channel = 'ordinary') {
  const {get} = require('../db');
  for(const id of [accountId, ...(TWO_SIDED.has(type)?[toAccountId]:[])]) {
    if(!id) continue;
    const a=get('SELECT type,is_archived FROM accounts WHERE id=? AND ledger_id=?',id,ledgerId);
    if(!a || a.is_archived) reject('请选择当前账本的有效账户');
    if(!allowed(type,a.type,channel)) reject(type==='transfer'?'普通转账仅用于自有资产账户；信用卡和贷款还款请使用“还款”入口':'该账户不能用于普通收支或借钱记账；信用卡可用于消费，贷款及应收应付请在对应台账操作');
  }
}
const TYPES=['expense','income','refund','reimburse','fee','interest','transfer','lend','borrow','repay_pay','repay_receive','invest_buy','invest_sell','adjust'];
function decorate(accounts) {
  return accounts.map(account => ({
    ...account,
    transaction_types: account.is_archived ? '' : TYPES.filter(type => allowed(type, account.type)).join(','),
  }));
}
module.exports={allowed,validate,decorate};
