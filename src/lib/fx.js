'use strict';

const FEED = 'https://api.frankfurter.dev/v2/rates?base=CNY';
const HOUR = 3600000;
const validCode = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);

function quotes() {
  const { all } = require('../db');
  return new Map(all('SELECT base,quote,rate,noted_at,source FROM exchange_rates')
    .filter(row => Number.isFinite(row.rate) && row.rate > 0)
    .map(row => [row.base + ':' + row.quote, row]));
}

function quote(from, to, rates = quotes()) {
  if (from === to) return { rate: 1, source: 'identity', noted_at: null };
  const direct = (a, b) => {
    const found = rates.get(a + ':' + b);
    const reverse = rates.get(b + ':' + a);
    if (found && (!reverse || reverse.source !== 'frankfurter' ||
      (found.source === 'frankfurter' && found.noted_at >= reverse.noted_at))) return found;
    return reverse && { ...reverse, rate: 1 / reverse.rate };
  };
  const found = direct(from, to);
  if (found) return found;
  const left = direct(from, 'CNY');
  const right = direct('CNY', to);
  if (!left || !right) return null;
  return {
    rate: left.rate * right.rate,
    source: left.source === 'frankfurter' && right.source === 'frankfurter' ? 'frankfurter' : 'seed',
    noted_at: left.noted_at < right.noted_at ? left.noted_at : right.noted_at,
  };
}

function transactionRate(ledgerId, currency, amount, options, old) {
  const { get } = require('../db');
  const base = get('SELECT currency FROM ledgers WHERE id=?', ledgerId)?.currency || 'CNY';
  if (!validCode(currency)) throw Error('币种应为三个字母，例如 CNY 或 USD');
  if (currency === base) return { base, rate: 1, amountBase: amount, source: 'identity', date: null };
  if (options.settlement_amount_cents != null) {
    const amountBase = Number(options.settlement_amount_cents);
    if (!Number.isSafeInteger(amountBase) || amountBase / amount <= 0) throw Error('实际入账金额无效');
    return { base, rate: amountBase / amount, amountBase, source: 'settlement', date: null };
  }
  if (old && old.currency === currency && (options.rate === undefined ||
    (options.rate !== '' && options.rate != null && Number(options.rate) === old.rate))) {
    if (old.rate_source === 'settlement')
      return { base, rate: old.amount_base_cents / amount, amountBase: old.amount_base_cents, source: 'settlement', date: null };
    const amountBase = amount === old.amount_cents ? old.amount_base_cents : Math.round(amount * old.rate);
    return { base, rate: old.rate, amountBase, source: old.rate_source, date: old.rate_date };
  }
  if (options.rate !== undefined && options.rate !== null && options.rate !== '') {
    const rate = Number(options.rate);
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(Math.round(amount * rate))) throw Error('汇率必须是有效的正数');
    return { base, rate, amountBase: Math.round(amount * rate), source: 'manual', date: null };
  }
  const reference = quote(currency, base);
  if (!reference) throw Error(`暂时没有 ${currency} 到 ${base} 的参考汇率，请填写汇率或实际入账金额`);
  return { base, rate: reference.rate, amountBase: Math.round(amount * reference.rate),
    source: reference.source || 'seed', date: reference.noted_at };
}

function amountInCurrency(amount, amountBase, original, base, target, rates, strict = false) {
  if (!target || target === base) return amountBase;
  if (target === original) return amount;
  const reference = quote(base, target, rates);
  if (reference) return Math.round(amountBase * reference.rate);
  if (strict) throw Error(`暂时没有 ${base} 到 ${target} 的参考汇率，无法计算该账户的入账金额`);
  return null;
}

function transactionValuation(ledgerId, currency, amount, options, accountId, toAccountId, old) {
  const { get } = require('../db');
  const exchange = transactionRate(ledgerId, currency, amount, options, old);
  const unchanged = old && old.currency === currency && old.amount_cents === amount && old.amount_base_cents === exchange.amountBase;
  const value = (id, previousId, previousCents) => {
    if (!id) return null;
    if (unchanged && id === previousId && previousCents != null) return previousCents;
    const target = get('SELECT currency FROM accounts WHERE id=? AND ledger_id=?', id, ledgerId)?.currency;
    return amountInCurrency(amount, exchange.amountBase, currency, exchange.base, target, undefined, true);
  };
  return { ...exchange, accountAmount: value(accountId, old?.account_id, old?.account_amount_cents),
    toAccountAmount: value(toAccountId, old?.to_account_id, old?.to_account_amount_cents) };
}

async function refreshRates(fetcher = fetch) {
  const response = await fetcher(FEED, { signal: AbortSignal.timeout(6000), redirect: 'error' });
  if (!response.ok) throw Error('参考汇率服务暂时不可用');
  const results = await response.json();
  if (!Array.isArray(results) || results.length > 400) throw Error('参考汇率格式不正确');
  const rates = results.filter(row => row?.base === 'CNY' && validCode(row.quote) &&
    Number.isFinite(row.rate) && row.rate > 0 && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  if (!rates.length) throw Error('参考汇率数据为空');
  const { run, tx } = require('../db');
  tx(() => {
    for (const row of rates)
      run(`INSERT INTO exchange_rates(base,quote,rate,noted_at,source) VALUES(?,?,?,?, 'frankfurter')
        ON CONFLICT(base,quote) DO UPDATE SET rate=excluded.rate,noted_at=excluded.noted_at,source=excluded.source
        WHERE exchange_rates.source<>'frankfurter' OR excluded.noted_at>=exchange_rates.noted_at`,
      row.base, row.quote, row.rate, row.date);
  });
  return rates.length;
}

function init() {
  if (process.env.NODE_ENV === 'test') return;
  const refresh = () => refreshRates().catch(() => console.warn('[fx] 参考汇率更新暂不可用，继续使用已保存汇率'));
  setTimeout(refresh, 1000).unref();
  setInterval(refresh, HOUR).unref();
}

module.exports = { quotes, quote, transactionValuation, amountInCurrency, refreshRates, init };
