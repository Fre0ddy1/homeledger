'use strict';

function ensure(db, ensureColumn) {
  ensureColumn('notifications', 'event_type', 'TEXT');
  ensureColumn('notifications', 'event_details', 'TEXT');
  ensureColumn('notifications', 'event_key', 'TEXT');
  ensureColumn('notifications', 'created_ms', 'INTEGER');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event ON notifications(user_id, event_key) WHERE event_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS push_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL,
      config TEXT NOT NULL,
      event_types TEXT NOT NULL,
      hide_amount INTEGER NOT NULL DEFAULT 0,
      quiet_start TEXT,
      quiet_end TEXT,
      timezone TEXT NOT NULL,
      revision TEXT NOT NULL,
      start_after_id INTEGER NOT NULL,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_push_channel_owner ON push_channels(user_id);
    CREATE TABLE IF NOT EXISTS push_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER,
      user_id INTEGER NOT NULL,
      channel_id INTEGER NOT NULL,
      channel_name TEXT NOT NULL,
      channel_revision TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_ms INTEGER NOT NULL,
      next_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      UNIQUE (notification_id, channel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_push_due ON push_deliveries(status, next_ms);
    CREATE INDEX IF NOT EXISTS idx_push_history ON push_deliveries(user_id, id);
    CREATE TABLE IF NOT EXISTS push_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_notification_id INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO push_state SELECT 1, COALESCE(MAX(id), 0) FROM notifications;
    CREATE TABLE IF NOT EXISTS daily_spend_rules (
      ledger_id INTEGER PRIMARY KEY,
      enabled INTEGER NOT NULL,
      budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
      alert_pct INTEGER NOT NULL CHECK (alert_pct BETWEEN 1 AND 100),
      timezone TEXT NOT NULL,
      scope TEXT NOT NULL,
      category_id INTEGER,
      account_id INTEGER
    );
    CREATE TABLE IF NOT EXISTS credit_reminder_rules (
      account_id INTEGER PRIMARY KEY,
      ledger_id INTEGER NOT NULL,
      timezone TEXT NOT NULL,
      send_time TEXT NOT NULL,
      closing_days INTEGER,
      repayment_days TEXT
    );
  `);
}

function afterRestore(db) {
  db.exec(`
    UPDATE push_state SET last_notification_id = (SELECT COALESCE(MAX(id), 0) FROM notifications);
    UPDATE push_deliveries SET status = 'skipped', error = '已恢复备份'
      WHERE status IN ('pending', 'sending');
  `);
}

module.exports = { ensure, afterRestore };
