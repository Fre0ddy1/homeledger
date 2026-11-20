'use strict';

const router = require('express').Router();
const auth = require('../lib/auth');
const push = require('../lib/notification-push');
const rules = require('../lib/notification-rules');
const settingsUrl = '/settings#notifications';

function handle(fn, success) {
  return (req, res) => {
    try {
      fn(req, res);
      res.flash('success', success);
    } catch (error) {
      res.flash('error', error.message);
    }
    res.redirect(settingsUrl);
  };
}

router.use(auth.requireLogin);
router.post('/channels', handle(req => push.saveChannel(req.session.userId, null, req.body), '渠道已添加'));
router.post('/channels/:id/save', handle(req => push.saveChannel(req.session.userId, Number(req.params.id), req.body), '渠道已保存'));
router.post('/channels/:id/state', handle(req => push.changeChannelState(req.session.userId, Number(req.params.id), req.body.action), '渠道状态已更新'));
router.post('/channels/:id/test', async (req, res) => {
  try {
    const result = await push.testChannel(req.session.userId, Number(req.params.id));
    res.flash(result.status === 'sent' ? 'success' : 'error',
      result.status === 'sent' ? '渠道服务已接受测试通知，请查看手机。' : result.message);
  } catch (error) {
    res.flash('error', error.message);
  }
  res.redirect(settingsUrl);
});
router.post('/daily', auth.requireLedgerManage,
  handle((req, res) => {
    const ledgerId = Number(res.locals.ledger.id);
    if (Number(req.body.ledger_id) !== ledgerId) throw Error('当前账本已切换，请刷新设置页后再保存');
    rules.saveDaily(ledgerId, req.body);
  }, '当天消费预警已保存'));
router.post('/cards/:id', auth.requireLedgerManage,
  handle((req, res) => rules.saveCard(Number(res.locals.ledger.id), Number(req.params.id), req.body), '信用卡提醒已保存'));

module.exports = router;
