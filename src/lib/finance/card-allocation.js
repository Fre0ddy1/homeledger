'use strict';
const db = require('../../db');

// Rebuild only automatic matches. Bank snapshots and explicit manual matches
// remain authoritative; this service never creates or changes money movements.
function reconcile(ledgerId, accountId) {
  const payments = db.all("SELECT * FROM finance_payments WHERE ledger_id=? AND target_kind='card' AND target_id=? AND deleted_at IS NULL AND allocation_mode='auto' ORDER BY txn_date,id", ledgerId, accountId);
  for (const payment of payments) db.run('DELETE FROM finance_allocations WHERE ledger_id=? AND payment_id=?', ledgerId, payment.id);
  const bills = require('./cards').statements(ledgerId, accountId)
    .filter(bill => bill.closing_date <= db.todayStr())
    .sort((a,b) => a.due_date.localeCompare(b.due_date) || a.id-b.id);
  for (const payment of payments) {
    let remaining = payment.amount_cents;
    for (const bill of bills) {
      const amount = Math.min(remaining, bill.remaining_cents);
      if (amount <= 0) continue;
      db.run("INSERT INTO finance_allocations(ledger_id,payment_id,target_kind,target_id,principal_cents,interest_cents,fee_cents) VALUES(?,?,'card',?,?,0,0)", ledgerId, payment.id, bill.id, amount);
      bill.remaining_cents -= amount;
      remaining -= amount;
      if (!remaining) break;
    }
  }
}
module.exports = { reconcile };
