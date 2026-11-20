'use strict';

const crypto = require('node:crypto');
const db = require('../db');
const channels = require('./push-channels');
const rules = require('./notification-rules');
const { types, readableBody } = require('./notification-types');
const { money } = require('./util');

const DAY = 86400000;
const RETRIES = [60000, 300000];

function settingsFor(userId, ledgerId) {
  const list = db.all(`SELECT id, name, type, enabled, timeout_ms, event_types, hide_amount, quiet_start, quiet_end, timezone
    FROM push_channels WHERE user_id=? AND deleted_at IS NULL ORDER BY id`, userId);
  return {
    list: list.map(channel => ({ ...channel, events: JSON.parse(channel.event_types) })),
    logs: db.all(`SELECT channel_name, event_type, created_ms, status, error, attempts FROM push_deliveries
      WHERE user_id=? ORDER BY id DESC LIMIT 50`, userId),
    kinds: channels.kinds, types, timezone: rules.defaultTimezone(),
    daily: ledgerId ? rules.dailyRule(ledgerId) : null,
  };
}

function ownChannel(userId, channelId) {
  const channel = db.get('SELECT * FROM push_channels WHERE user_id=? AND id=? AND deleted_at IS NULL', userId, channelId);
  if (!channel) throw Error('推送渠道不存在');
  return channel;
}

function jsonObject(input, label) {
  try {
    if (input.length > 8192) throw Error();
    const parsed = JSON.parse(input);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error();
    return parsed;
  } catch { throw Error(`${label}需要是 JSON 对象，例如 {"key":"value"}`); }
}

function addressFrom(body) {
  if (body.url?.trim()) return body.url.trim();
  const host = (body.host || '').trim();
  if (!host) return '';
  if (!['http', 'https'].includes(body.protocol) || /[\/\\@?#\s]/.test(host)) throw Error('协议或服务主机格式不正确');
  const hostname = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const port = body.port?.trim();
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) throw Error('端口应在 1–65535 之间');
  const pathname = (body.path || '').trim();
  return `${body.protocol}://${hostname}${port ? ':' + port : ''}${pathname && !pathname.startsWith('/') ? '/' : ''}${pathname}`;
}

function cutoff() {
  return db.get('SELECT COALESCE(MAX(id),0) AS id FROM notifications').id;
}

function saveChannel(userId, channelId, body) {
  const previous = channelId ? ownChannel(userId, channelId) : null;
  const type = previous?.type || body.type;
  if (!Object.hasOwn(channels.kinds, type)) throw Error('请选择推送渠道类型');
  const name = String(body.name || '').trim();
  const timeoutMs = Number(body.timeout_ms || 5000);
  if (!name || name.length > 60) throw Error('渠道名称应为 1–60 个字符');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20000) throw Error('超时应在 500–20000 毫秒之间');
  if (!previous && db.get('SELECT COUNT(*) AS n FROM push_channels WHERE user_id=? AND deleted_at IS NULL', userId).n >= 20)
    throw Error('最多可添加 20 个渠道');
  const config = previous && body.replace_config !== '1' ? channels.decrypt(previous.config) : {};
  if (body.official_url === '1') delete config.url;
  const address = addressFrom(body);
  if (address.length > 2048) throw Error('服务地址过长');
  if (address) config.url = address;
  for (const name of ['key', 'titleTemplate', 'contentTemplate']) {
    const value = String(body[name] || '').trim();
    if (value.length > 8192) throw Error('渠道配置内容过长');
    if (value) config[name] = value;
  }
  for (const [field, label] of [['query', 'Query'], ['headers', '请求头'], ['body', '请求体'], ['options', '可选参数']]) {
    if (body[field]?.trim()) config[field] = jsonObject(body[field], label);
  }
  config.method = body.method || config.method || 'POST';
  config.bodyFormat = body.bodyFormat || config.bodyFormat || 'json';
  if (!['GET', 'POST'].includes(config.method) || !['json', 'form'].includes(config.bodyFormat)) throw Error('请求方法或请求体格式无效');
  const embedded = type === 'serverchan' ? channels.serverChanKeyInUrl(config.url) : null;
  if (embedded) {
    if (body.key?.trim() && body.key.trim() !== embedded)
      throw Error('完整地址中仍是另一个 SendKey，请同时更新地址或勾选恢复服务默认地址');
    delete config.key;
  }
  channels.buildRequest(type, config, { title: '测试通知', content: '渠道配置检查', event_type: 'test', date: '2000-01-01' });
  const selected = [body.event_types || []].flat().filter(event => Object.hasOwn(types, event));
  const events = body.all_events === '1' ? ['*'] : [...new Set(selected)];
  const quietStart = body.quiet_start || null;
  const quietEnd = body.quiet_end || null;
  if ((quietStart || quietEnd) && (!quietStart || !quietEnd || rules.timeOf(quietStart) === rules.timeOf(quietEnd)))
    throw Error('请填写不同的免打扰起止时间');
  const encrypted = channels.encrypt(config);
  const enabled = body.enabled === '1' ? 1 : 0;
  const timezone = rules.timezoneOf(body.timezone);
  return db.tx(() => {
    const values = [name, enabled, timeoutMs, encrypted, JSON.stringify(events), body.hide_amount === '1' ? 1 : 0,
      quietStart, quietEnd, timezone, crypto.randomUUID(), cutoff()];
    if (previous) {
      db.run(`UPDATE push_channels SET name=?,enabled=?,timeout_ms=?,config=?,event_types=?,hide_amount=?,quiet_start=?,
        quiet_end=?,timezone=?,revision=?,start_after_id=? WHERE user_id=? AND id=?`, ...values, userId, channelId);
      return channelId;
    }
    return db.run(`INSERT INTO push_channels(user_id,type,name,enabled,timeout_ms,config,event_types,hide_amount,quiet_start,
      quiet_end,timezone,revision,start_after_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, userId, type, ...values).lastInsertRowid;
  });
}

function changeChannelState(userId, channelId, action) {
  ownChannel(userId, channelId);
  if (!['enable', 'disable', 'delete'].includes(action)) throw Error('无效的渠道操作');
  db.run(`UPDATE push_channels SET enabled=?, revision=?, start_after_id=?, deleted_at=?
    WHERE id=? AND user_id=?`, action === 'enable' ? 1 : 0, crypto.randomUUID(), cutoff(),
  action === 'delete' ? db.nowStr() : null, channelId, userId);
}

function notificationValues(notice, channel) {
  const detail = JSON.parse(notice.event_details || '{}');
  const label = types[notice.event_type] || '家账簿通知';
  const vendor = /^https?:\/\//i.test(detail.vendorUrl || '') ? detail.vendorUrl : '';
  let readable = readableBody(notice.body);
  if (!channel.hide_amount && notice.event_type === 'daily_spend') {
    const rule = rules.dailyRule(notice.ledger_id);
    if (rule) {
      detail.amountCents = rules.dailyAmount(rule, detail.date);
      readable = rules.dailyMessage(rule, detail.date, detail.amountCents, detail.currency);
    }
  }
  if (!channel.hide_amount && notice.event_type === 'card_repayment' && detail.statementId) {
    const card = db.get(`SELECT a.id,a.currency FROM credit_statements s JOIN accounts a ON a.id=s.account_id
      WHERE s.id=? AND s.ledger_id=?`, detail.statementId, notice.ledger_id);
    const statement = card && require('./finance/cards').statements(notice.ledger_id, card.id).find(s => s.id === detail.statementId);
    if (statement) {
      detail.amountCents = statement.remaining_cents;
      const timezone = rules.cardRule(card.id)?.timezone || rules.defaultTimezone();
      const { date } = rules.localClock(new Date(), timezone);
      const days = (Date.parse(statement.due_date) - Date.parse(date)) / DAY;
      readable = `还款日 ${statement.due_date}，${days < 0 ? `已逾期 ${-days} 天` : `剩余 ${days} 天`}，待还 ${money(statement.remaining_cents, card.currency)}`;
    }
  }
  return {
    title: notice.title || label,
    content: channel.hide_amount ? label : [readable, vendor].filter(Boolean).join('\n'),
    event_type: notice.event_type, date: detail.date || notice.created_at?.slice(0, 10),
    amount: !channel.hide_amount && detail.amountCents != null ? (detail.amountCents / 100).toFixed(2) : '',
    url: vendor,
  };
}

async function testChannel(userId, channelId) {
  const channel = ownChannel(userId, channelId);
  const since = Date.now() - 60000;
  const tests = db.get("SELECT COUNT(*) AS n FROM push_deliveries WHERE user_id=? AND event_type='test' AND created_ms>?", userId, since).n;
  if (tests >= 5) throw Error('测试过于频繁，请稍后再试');
  const now = Date.now();
  const id = db.run(`INSERT INTO push_deliveries (user_id,channel_id,channel_name,channel_revision,event_type,created_ms,
    next_ms,expires_ms,attempts,status) VALUES (?,?,?,?,'test',?,?,?,1,'sending')`,
  userId, channelId, channel.name, channel.revision, now, now, now + DAY).lastInsertRowid;
  const sample = { title: '家账簿测试通知', content: '这是一条渠道测试消息。', event_type: 'test', date: db.todayStr() };
  const result = await sendSafely(channel, sample,
    () => db.get(`SELECT d.id FROM push_deliveries d JOIN push_channels c ON c.id=d.channel_id
      JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.event_type='test' AND d.status='sending'
      AND d.created_ms=? AND d.channel_revision=? AND c.revision=d.channel_revision AND c.deleted_at IS NULL AND u.status='active'`,
    id, now, channel.revision) ? sample : null);
  db.run(`UPDATE push_deliveries SET status=?,error=? WHERE id=? AND status='sending' AND event_type='test'
    AND created_ms=? AND channel_revision=?`, result.status, result.message || null, id, now, channel.revision);
  return result;
}

async function sendSafely(channel, values, currentValues) {
  let config;
  try { config = channels.decrypt(channel.config); }
  catch (error) { return { status: 'failed', message: error.message }; }
  try { return await channels.send(channel.type, config, values, channel.timeout_ms, currentValues); }
  catch { return { status: 'failed', message: '渠道请求格式无效，请检查配置' }; }
}

function enqueue(now) {
  return db.tx(() => {
    const cursor = db.get('SELECT last_notification_id FROM push_state WHERE id=1').last_notification_id;
    const items = db.all('SELECT * FROM notifications WHERE id>? ORDER BY id LIMIT 250', cursor);
    for (const notice of items) {
      if (!notice.event_type || !notice.created_ms || notice.created_ms + DAY <= now) continue;
      const enabled = db.all(`SELECT id,name,revision,event_types FROM push_channels
        WHERE user_id=? AND enabled=1 AND deleted_at IS NULL AND start_after_id<?`, notice.user_id, notice.id);
      for (const channel of enabled) {
        const events = JSON.parse(channel.event_types);
        if (!events.includes('*') && !events.includes(notice.event_type)) continue;
        db.run(`INSERT OR IGNORE INTO push_deliveries(notification_id,user_id,channel_id,channel_name,channel_revision,
          event_type,created_ms,next_ms,expires_ms) VALUES (?,?,?,?,?,?,?,?,?)`,
        notice.id, notice.user_id, channel.id, channel.name, channel.revision, notice.event_type, notice.created_ms, now, notice.created_ms + DAY);
      }
    }
    if (items.length) db.run('UPDATE push_state SET last_notification_id=? WHERE id=1', items.at(-1).id);
    return items.length;
  });
}

function canDeliver(notice, now) {
  if (!db.get("SELECT id FROM users WHERE id=? AND status='active'", notice.user_id)) return false;
  if (notice.ledger_id && !db.get(`SELECT l.id FROM ledgers l JOIN ledger_members m ON l.id=m.ledger_id
    WHERE l.id=? AND m.user_id=? AND l.is_archived=0`, notice.ledger_id, notice.user_id)) return false;
  const detail = JSON.parse(notice.event_details || '{}');
  if (notice.event_type === 'daily_spend') {
    const rule = rules.dailyRule(notice.ledger_id);
    return rule?.enabled && rules.localClock(new Date(now), rule.timezone).date === detail.date
      && rules.dailyAmount(rule, detail.date) >= Math.ceil(rule.budget_cents * rule.alert_pct / 100);
  }
  if (detail.subscriptionId) {
    const subscription = db.get('SELECT * FROM subscriptions WHERE ledger_id=? AND id=?', notice.ledger_id, detail.subscriptionId);
    if (!subscription || !['active', 'trial'].includes(subscription.status)) return false;
    if (notice.event_type === 'subscription_trial') return subscription.trial_ends_on === detail.date && detail.date >= db.todayStr();
    return subscription.next_charge_at === detail.date &&
      (notice.event_type === 'subscription_due' || detail.date >= db.todayStr());
  }
  if (notice.event_type === 'card_statement' && !detail.statementId) {
    if (!detail.cardAccountId || detail.daysAhead == null) return false;
    const rule = rules.cardRule(detail.cardAccountId);
    const account = db.get('SELECT id FROM accounts WHERE id=? AND ledger_id=? AND is_archived=0', detail.cardAccountId, notice.ledger_id);
    return account && rule?.closing_days === detail.daysAhead && detail.date >= rules.localClock(new Date(now), rule.timezone).date
      && !!require('./finance/cards').plannedClosing(notice.ledger_id, account.id, detail.date);
  }
  if (detail.statementId) {
    const statement = db.get(`SELECT s.*, a.is_archived, p.remind_enabled FROM credit_statements s
      JOIN accounts a ON a.id=s.account_id JOIN credit_profiles p ON p.account_id=s.account_id
      WHERE s.id=? AND s.ledger_id=? AND s.deleted_at IS NULL`, detail.statementId, notice.ledger_id);
    if (!statement || statement.is_archived) return false;
    const rule = rules.cardRule(statement.account_id);
    if (notice.event_type === 'card_statement')
      return rule?.closing_days === detail.daysAhead && statement.closing_date === detail.date
        && detail.date >= rules.localClock(new Date(now), rule.timezone).date
        && !!(statement.confirmed_at || require('./finance/cards').plannedClosing(notice.ledger_id, statement.account_id, detail.date));
    if (notice.event_type === 'card_repayment') {
      const configuredDays = rule?.repayment_days ? JSON.parse(rule.repayment_days) : null;
      const matches = configuredDays ? configuredDays.includes(detail.daysAhead) : detail.daysAhead == null;
      return matches && statement.remind_enabled && statement.due_date === detail.date
        && require('./finance/cards').statements(notice.ledger_id, statement.account_id).find(s => s.id === statement.id)?.remaining_cents > 0;
    }
  }
  return true;
}

function quietNow(channel, now) {
  if (!channel.quiet_start) return false;
  const { time } = rules.localClock(new Date(now), channel.timezone);
  const { quiet_start: start, quiet_end: end } = channel;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

async function dispatch(job, now) {
  const channel = db.get('SELECT * FROM push_channels WHERE id=? AND enabled=1 AND deleted_at IS NULL', job.channel_id);
  const notice = db.get('SELECT * FROM notifications WHERE id=?', job.notification_id);
  const conclude = (status, message) => db.run(`UPDATE push_deliveries SET status=?,error=?
    WHERE id=? AND status IN ('pending','sending') AND channel_revision=? AND notification_id=? AND created_ms=?`,
  status, message || null, job.id, job.channel_revision, job.notification_id, job.created_ms);
  let current = false;
  try { current = !!notice && canDeliver(notice, now); }
  catch { conclude('failed', '无法核对当前提醒状态'); return; }
  if (!channel || channel.revision !== job.channel_revision || !current) {
    conclude('skipped', '渠道或提醒已停用、变更或过期');
    return;
  }
  if (quietNow(channel, now)) {
    db.run("UPDATE push_deliveries SET next_ms=? WHERE id=? AND status='pending'", now + 60000, job.id);
    return;
  }
  const claim = db.run("UPDATE push_deliveries SET status='sending',attempts=attempts+1,next_ms=? WHERE id=? AND status='pending'",
    now + 60000, job.id);
  if (!claim.changes) return;
  const values = notificationValues(notice, channel);
  const result = await sendSafely(channel, values, () => {
    const current = db.get(`SELECT n.* FROM push_deliveries d JOIN notifications n ON n.id=d.notification_id
      JOIN push_channels c ON c.id=d.channel_id WHERE d.id=? AND d.status='sending' AND d.notification_id=?
      AND d.created_ms=? AND d.channel_revision=? AND c.revision=d.channel_revision AND c.enabled=1
      AND c.deleted_at IS NULL AND d.expires_ms>?`, job.id, job.notification_id, job.created_ms, job.channel_revision, Date.now());
    return current && canDeliver(current, Date.now()) ? notificationValues(current, channel) : null;
  });
  const delay = RETRIES[job.attempts];
  const next = Date.now() + Math.max(delay || 0, result.retryAfter || 0);
  if (result.retry && delay && next < job.expires_ms) {
    db.run(`UPDATE push_deliveries SET status='pending',next_ms=?,error=?
      WHERE id=? AND status='sending' AND channel_revision=? AND notification_id=? AND created_ms=?`,
    next, result.message, job.id, job.channel_revision, job.notification_id, job.created_ms);
  } else conclude(result.status, result.message);
}

let running = false;
let lastCardMinute = -1;
async function tick(now = Date.now()) {
  const minute = Math.floor(now / 60000);
  if (lastCardMinute !== minute) {
    try {
      rules.checkConfiguredCards(new Date(now));
      lastCardMinute = minute;
    } catch { console.error('[notifications] 信用卡提醒检查失败'); }
  }
  if (running) return;
  running = true;
  try {
    try { rules.checkDaily(new Date(now)); }
    catch { console.error('[notifications] 当天消费检查失败'); }
    enqueue(now);
    db.run("UPDATE push_deliveries SET status='skipped',error='提醒已过期' WHERE status='pending' AND expires_ms<=?", now);
    db.run("UPDATE push_deliveries SET status='unknown',error='发送过程已中断，送达结果未知' WHERE status='sending' AND next_ms<=? AND event_type<>'test'", now);
    db.run("UPDATE push_deliveries SET status='unknown',error='测试过程已中断，送达结果未知' WHERE status='sending' AND event_type='test' AND created_ms<=?", now - 60000);
    const due = db.all("SELECT * FROM push_deliveries WHERE status='pending' AND next_ms<=? ORDER BY next_ms,id LIMIT 24", now);
    for (let i = 0; i < due.length; i += 4)
      await Promise.allSettled(due.slice(i, i + 4).map(job => dispatch(job, Date.now())));
  } finally { running = false; }
}

function init() {
  const run = () => tick().catch(() => console.error('[notifications] 后台推送检查失败'));
  setTimeout(run, 4500).unref();
  setInterval(run, 15000).unref();
}

module.exports = { settingsFor, saveChannel, changeChannelState, testChannel, tick, init, notificationValues };
