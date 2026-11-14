'use strict';

// Re-run after restoring a database as well as during initial startup.
function ensure(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS advance_accounts (
      ledger_id INTEGER NOT NULL, currency TEXT NOT NULL, account_id INTEGER NOT NULL UNIQUE,
      PRIMARY KEY(ledger_id,currency)
    );
    CREATE TABLE IF NOT EXISTS advances (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
      person TEXT NOT NULL, amount_cents INTEGER NOT NULL, personal_cents INTEGER NOT NULL,
      advance_cents INTEGER NOT NULL, currency TEXT NOT NULL, account_id INTEGER NOT NULL,
      receivable_account_id INTEGER NOT NULL, primary_transaction_id INTEGER,
      source_transaction_id INTEGER, source_snapshot TEXT, operation_key TEXT NOT NULL,
      signature TEXT NOT NULL, txn_date TEXT NOT NULL, txn_time TEXT, note TEXT, merchant TEXT,
      created_at TEXT NOT NULL, deleted_at TEXT, replaced_by INTEGER,
      UNIQUE(ledger_id,operation_key)
    );
    CREATE INDEX IF NOT EXISTS idx_advances_ledger ON advances(ledger_id,deleted_at);
    CREATE TABLE IF NOT EXISTS advance_txns (
      advance_id INTEGER NOT NULL, transaction_id INTEGER NOT NULL, role TEXT NOT NULL,
      PRIMARY KEY(advance_id,transaction_id)
    );
    CREATE INDEX IF NOT EXISTS idx_advance_txns_transaction ON advance_txns(transaction_id);
    CREATE TABLE IF NOT EXISTS advance_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_id INTEGER NOT NULL, advance_id INTEGER NOT NULL,
      transaction_id INTEGER NOT NULL UNIQUE, amount_cents INTEGER NOT NULL, account_id INTEGER NOT NULL,
      operation_key TEXT NOT NULL, signature TEXT NOT NULL, txn_date TEXT NOT NULL, txn_time TEXT,
      created_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(ledger_id,operation_key)
    );
  `);
}

module.exports = {ensure};
