'use strict';

const db = require('../db');
const auth = require('./auth');
const { money, parseAmountToCents } = require('./util');

const defaultTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function timezoneOf(value) {
  const zone = String(value || defaultTimezone()).trim();
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    throw Error('请输入有效时区，例如 Asia/Shanghai');
  }
}

function timeOf(value) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error('时间请填写为 HH:MM');
  return value;
}

function localClock(now, timeZone) {
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const parts = Object.fromEntries(format.formatToParts(now).map(({type, value}) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function daysBetween(from, to) {
  return (Date.parse(to) - Date.parse(from)) / 86400000;
}

function int(value, min, max, error) {
  const n = Number(value);
  if (value === '' || !Number.isInteger(n) || n < min || n > max) throw Error(error);
  return n;
}

function saveDaily(ledgerId, body) {
  const budget = parseAmountToCents(body.budget);
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 1e12) throw Error('请填写有效的每日预算金额');
  const pct = int(body.alert_pct, 1, 100, '提醒比例应为 1–100 的整数');
  const scope = body.scope;
  if (!['overall', 'category', 'account'].includes(scope)) throw Error('请选择消费统计范围');
  const category = scope === 'category' ? require('./categories').find(ledgerId, Number(body.category_id), true) : null;
  const categoryId = category?.id ?? null;
  const accountId = scope === 'account' ? Number(body.account_id) : null;
  if (scope === 'category' && (category?.kind !== 'expense' || category.deleted_at)) throw Error('分类不可用');
  if (scope === 'account' && (!Number.isSafeInteger(accountId) || !db.get(
    'SELECT id FROM accounts WHERE id=? AND ledger_id=? AND is_archived=0', accountId, ledgerId))) throw Error('账户不可用');
  db.run(`INSERT INTO daily_spend_rules VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(ledger_id) DO UPDATE SET
    enabled=excluded.enabled, budget_cents=excluded.budget_cents, alert_pct=excluded.alert_pct, timezone=excluded.timezone,
    scope=excluded.scope, category_id=excluded.category_id, account_id=excluded.account_id`,
  ledgerId, body.enabled === '1' ? 1 : 0, budget, pct, timezoneOf(body.timezone), scope, categoryId, accountId);
}

function dailyRule(ledgerId) {
  return db.get('SELECT * FROM daily_spend_rules WHERE ledger_id=?', ledgerId);
}

function dailyAmount(rule, date) {
  return require('./scheduler').budgetUsedInRange({ ...rule, trigger_type: 'expense' }, date, date, { clearedOnly: true });
}

function dailyMessage(rule, date, amount, currency) {
  const threshold = Math.ceil(rule.budget_cents * rule.alert_pct / 100);
  return `${date} 已消费 ${money(amount, currency)}，达到每日预算 ${money(rule.budget_cents, currency)} 的 ${rule.alert_pct}%（预警线 ${money(threshold, currency)}，超出 ${money(amount - threshold, currency)}）`;
}

function notifyOnce(ledgerId, key, message) {
  return db.tx(() => {
    if (auth.alreadyNotified(key)) return 0;
    const users = auth.ledgerWriterIds(ledgerId);
    for (const uid of users) auth.notify(uid, {
      ...message, ledgerId, body: `${message.body || ''} |${key}`,
    });
    return users.length;
  });
}

function checkDaily(now = new Date()) {
  let count = 0;
  const rules = db.all(`SELECT r.*, l.currency FROM daily_spend_rules r
    JOIN ledgers l ON l.id=r.ledger_id WHERE r.enabled=1 AND l.is_archived=0`);
  for (const rule of rules) {
    const { date } = localClock(now, rule.timezone);
    const threshold = Math.ceil(rule.budget_cents * rule.alert_pct / 100);
    const amount = dailyAmount(rule, date);
    if (amount < threshold) continue;
    count += notifyOnce(rule.ledger_id, `daily-spend:${rule.ledger_id}:${date}`, {
      eventType: 'daily_spend', kind: 'warn', title: '当天消费已达预警线', link: '/budgets',
      body: dailyMessage(rule, date, amount, rule.currency),
      details: { date, timezone: rule.timezone, amountCents: amount, currency: rule.currency },
    });
  }
  return count;
}

function cardRule(accountId) {
  return db.get('SELECT * FROM credit_reminder_rules WHERE account_id=?', accountId);
}

function saveCard(ledgerId, accountId, body) {
  const profile = db.get(`SELECT p.account_id FROM credit_profiles p JOIN accounts a ON a.id=p.account_id
    WHERE p.account_id=? AND p.ledger_id=? AND a.is_archived=0`, accountId, ledgerId);
  if (!profile) throw Error('请先设置该信用卡的账期');
  const closing = body.closing_days === '' || body.closing_days == null
    ? null : int(body.closing_days, 0, 30, '出账提前天数应为 0–30');
  const repayment = String(body.repayment_days || '').trim();
  const days = repayment ? [...new Set(repayment.split(/[,，、]/).map(day =>
    int(day.trim(), 0, 60, '还款提前天数应为 0–60，请用逗号分隔')))].sort((a, b) => b - a) : null;
  if (days && days.length > 12) throw Error('最多设置 12 个还款提前时间');
  db.run(`INSERT INTO credit_reminder_rules VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET
    timezone=excluded.timezone, send_time=excluded.send_time, closing_days=excluded.closing_days,
    repayment_days=excluded.repayment_days`, accountId, ledgerId, timezoneOf(body.timezone),
  timeOf(body.send_time || '09:00'), closing, days ? JSON.stringify(days) : null);
}

function checkCard(profile, statements, rule, now = new Date()) {
  if (!rule) return 0;
  const { date, time } = localClock(now, rule.timezone);
  if (time < rule.send_time) return 0;
  const repayment = JSON.parse(rule.repayment_days || '[]');
  let count = 0;
  if (rule.closing_days != null) {
    const closingDate = new Date(Date.parse(date) + rule.closing_days * 86400000).toISOString().slice(0, 10);
    const known = statements.find(row => row.closing_date === closingDate);
    const planned = known?.confirmed_at ? known : require('./finance/cards').plannedClosing(profile.ledger_id, profile.account_id, closingDate);
    const statement = planned && (known || planned);
    if (statement) {
      const amount = statement.confirmed_at && !statement.dirty ? statement.confirmed_cents : null;
      count += notifyOnce(profile.ledger_id, `finance:card-close:${profile.account_id}:${closingDate}:${rule.closing_days}`, {
        eventType: 'card_statement', title: `信用卡出账提醒：${profile.card_name}`,
        link: statement.id ? `/finance/statements/${statement.id}` : `/finance/cards/${profile.account_id}`,
        body: `出账日 ${closingDate}，还款日 ${statement.due_date}${amount === null ? '' : `，账单金额 ${money(amount, profile.currency)}`}`,
        details: { date: closingDate, daysAhead: rule.closing_days, statementId: statement.id, cardAccountId: profile.account_id, amountCents: amount, currency: profile.currency },
      });
    }
  }
  for (const statement of statements) {
    const remaining = daysBetween(date, statement.due_date);
    const link = `/finance/statements/${statement.id}`;
    if (profile.remind_enabled && statement.remaining_cents > 0 && statement.closing_date <= date && repayment.includes(remaining)) {
      count += notifyOnce(profile.ledger_id, `finance:card:${statement.id}:${statement.due_date}:${remaining}`, {
        eventType: 'card_repayment', kind: 'warn', link,
        title: `信用卡还款提醒：${profile.card_name}${statement.dirty ? '（待核对）' : ''}`,
        body: `还款日 ${statement.due_date}，剩余 ${remaining} 天，待还 ${money(statement.remaining_cents, profile.currency)}`,
        details: { date: statement.due_date, daysAhead: remaining, statementId: statement.id, amountCents: statement.remaining_cents, currency: profile.currency },
      });
    }
  }
  return count;
}

function checkConfiguredCards(now = new Date()) {
  const profiles = db.all(`SELECT p.*,r.timezone,r.send_time,r.closing_days,r.repayment_days,a.name AS card_name,a.currency
    FROM credit_reminder_rules r JOIN credit_profiles p ON p.account_id=r.account_id AND p.ledger_id=r.ledger_id
    JOIN accounts a ON a.id=p.account_id JOIN ledgers l ON l.id=p.ledger_id
    WHERE a.is_archived=0 AND l.is_archived=0 AND (r.closing_days IS NOT NULL OR (p.remind_enabled=1 AND r.repayment_days IS NOT NULL))`);
  for (const profile of profiles) {
    if (localClock(now, profile.timezone).time < profile.send_time) continue;
    const statements = require('./finance/cards').statements(profile.ledger_id, profile.account_id);
    checkCard(profile, statements, profile, now);
  }
}

module.exports = { defaultTimezone, timezoneOf, timeOf, localClock, saveDaily, dailyRule, dailyAmount, dailyMessage, checkDaily, cardRule, saveCard, checkCard, checkConfiguredCards };
