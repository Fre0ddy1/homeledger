'use strict';

const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const rules = require('../lib/notification-rules');
const { readableBody } = require('../lib/notification-types');

module.exports = ({ ok, bad }) => {
  const router = express.Router();
  const cardConfig = (row) => row ? { ...row, repayment_days: row.repayment_days ? JSON.parse(row.repayment_days) : null } : null;
  const manage = (req, res, next) => {
    if (!auth.canManage(req.openAuth.role)) return bad(res, 403, '需要账本管理员及以上权限');
    if (!db.get('SELECT id FROM ledgers WHERE id=? AND is_archived=0', req.openAuth.ledgerId))
      return bad(res, 403, '账本已归档（只读）');
    next();
  };
  router.get('/', (req, res) => {
    const { ledgerId, userId } = req.openAuth;
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
    const notices = db.all(`SELECT id,event_type,kind,title,body,link,is_read,created_at FROM notifications
       WHERE ledger_id=? AND user_id=? ORDER BY id DESC LIMIT ?`, ledgerId, userId, limit);
    ok(res, { notifications: notices.map(row => ({ ...row, body: readableBody(row.body), is_read: !!row.is_read })) });
  });
  router.get('/rules', (req, res) => {
    const { ledgerId } = req.openAuth;
    const cards = db.all(`SELECT p.account_id,p.remind_enabled,r.closing_days,r.repayment_days,r.send_time,r.timezone
      FROM credit_profiles p JOIN accounts a ON a.id=p.account_id
      LEFT JOIN credit_reminder_rules r ON r.account_id=p.account_id
      WHERE p.ledger_id=? AND a.is_archived=0 ORDER BY p.account_id`, ledgerId);
    ok(res, { daily: rules.dailyRule(ledgerId) || null, cards: cards.map(cardConfig) });
  });
  router.post('/rules/daily', manage, (req, res) => {
    const { ledgerId } = req.openAuth;
    const body = req.body || {};
    if (!Number.isSafeInteger(body.budget_cents)) return bad(res, 400, 'budget_cents 必须为整数分');
    try {
      rules.saveDaily(ledgerId, {
        ...body, budget: (body.budget_cents / 100).toFixed(2),
        enabled: body.enabled === true || body.enabled === 1 ? '1' : '0',
      });
      auth.audit(req, 'api.notification.daily', { ledgerId });
      ok(res, { daily: rules.dailyRule(ledgerId) });
    } catch (error) { bad(res, 400, error.message); }
  });
  router.post('/rules/cards/:id', manage, (req, res) => {
    const { ledgerId } = req.openAuth;
    const accountId = Number(req.params.id);
    const body = req.body || {};
    if (body.repayment_days != null && !Array.isArray(body.repayment_days)) return bad(res, 400, 'repayment_days 必须为天数数组或 null');
    try {
      rules.saveCard(ledgerId, accountId, { ...body, repayment_days: body.repayment_days?.join(',') });
      auth.audit(req, 'api.notification.card', { ledgerId, entityId: accountId });
      ok(res, { card: cardConfig(rules.cardRule(accountId)) });
    } catch (error) { bad(res, 400, error.message); }
  });
  return router;
};
