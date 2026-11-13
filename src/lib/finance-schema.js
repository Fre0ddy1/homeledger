'use strict';
// Called both at module initialization and after restoring an older database.
function ensure(db,column){
  column('transactions','debt_id','INTEGER');
  column('transactions','posted_date','TEXT');
  column('transactions','recurring_run_id','INTEGER');
  column('debts','opening_cents','INTEGER');
  column('debts','initial_principal_cents','INTEGER');
  column('debts','origin_key','TEXT');
  column('debts','managed','INTEGER NOT NULL DEFAULT 0');
  column('debts','deleted_at','TEXT');
  column('debts','remind_enabled','INTEGER NOT NULL DEFAULT 1');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_origin ON debts(ledger_id,origin_key);
    CREATE INDEX IF NOT EXISTS idx_txn_debt ON transactions(ledger_id,debt_id);
    CREATE TABLE IF NOT EXISTS borrowing_operations(ledger_id INTEGER NOT NULL, operation_key TEXT NOT NULL, debt_id INTEGER NOT NULL, transaction_id INTEGER NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(ledger_id,operation_key));`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS finance_contracts(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,account_id INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'loan',institution TEXT,original_principal_cents INTEGER NOT NULL,annual_rate REAL NOT NULL DEFAULT 0,term_n INTEGER NOT NULL,method TEXT NOT NULL,start_date TEXT NOT NULL,due_day INTEGER NOT NULL,remind_enabled INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,created_at TEXT NOT NULL,UNIQUE(ledger_id,account_id));
    CREATE TABLE IF NOT EXISTS finance_installments(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,contract_id INTEGER NOT NULL,seq INTEGER NOT NULL,due_date TEXT NOT NULL,principal_cents INTEGER NOT NULL,interest_cents INTEGER NOT NULL DEFAULT 0,fee_cents INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,deleted_at TEXT,UNIQUE(contract_id,revision,seq));
    CREATE TABLE IF NOT EXISTS finance_plan_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,contract_id INTEGER NOT NULL,snapshot_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS finance_payments(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,target_kind TEXT NOT NULL,target_id INTEGER NOT NULL,account_id INTEGER NOT NULL,principal_cents INTEGER NOT NULL,interest_cents INTEGER NOT NULL DEFAULT 0,fee_cents INTEGER NOT NULL DEFAULT 0,amount_cents INTEGER NOT NULL,txn_date TEXT NOT NULL,operation_key TEXT NOT NULL,signature TEXT NOT NULL,external_txn_id INTEGER,deleted_at TEXT,created_at TEXT NOT NULL,UNIQUE(ledger_id,operation_key));
    CREATE TABLE IF NOT EXISTS finance_payment_txns(payment_id INTEGER NOT NULL,transaction_id INTEGER NOT NULL,role TEXT NOT NULL,PRIMARY KEY(payment_id,transaction_id));
    CREATE TABLE IF NOT EXISTS finance_allocations(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,payment_id INTEGER NOT NULL,target_kind TEXT NOT NULL,target_id INTEGER NOT NULL,principal_cents INTEGER NOT NULL DEFAULT 0,interest_cents INTEGER NOT NULL DEFAULT 0,fee_cents INTEGER NOT NULL DEFAULT 0,UNIQUE(payment_id,target_kind,target_id));
    CREATE TABLE IF NOT EXISTS credit_profiles(account_id INTEGER PRIMARY KEY,ledger_id INTEGER NOT NULL,bill_day INTEGER NOT NULL,due_day INTEGER NOT NULL,due_month_offset INTEGER NOT NULL DEFAULT 1,remind_enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_statements(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,account_id INTEGER NOT NULL,closing_date TEXT NOT NULL,period_start TEXT NOT NULL,due_date TEXT NOT NULL,computed_cents INTEGER NOT NULL DEFAULT 0,confirmed_cents INTEGER,confirmed_at TEXT,fingerprint TEXT NOT NULL DEFAULT '',dirty INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,note TEXT,deleted_at TEXT,UNIQUE(account_id,closing_date));
    CREATE TABLE IF NOT EXISTS credit_statement_items(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,statement_id INTEGER NOT NULL,transaction_id INTEGER NOT NULL,item_key TEXT NOT NULL,amount_cents INTEGER NOT NULL,label TEXT,UNIQUE(statement_id,item_key));
    CREATE TABLE IF NOT EXISTS credit_plans(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,account_id INTEGER NOT NULL,transaction_id INTEGER NOT NULL UNIQUE,principal_cents INTEGER NOT NULL,term_n INTEGER NOT NULL,first_closing TEXT NOT NULL,interest_cents INTEGER NOT NULL DEFAULT 0,fee_cents INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_statement_revisions(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,statement_id INTEGER NOT NULL,revision INTEGER NOT NULL,amount_cents INTEGER NOT NULL,items_json TEXT NOT NULL,note TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recurring_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,ledger_id INTEGER NOT NULL,rule_id INTEGER NOT NULL,scheduled_date TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(rule_id,scheduled_date));
    CREATE INDEX IF NOT EXISTS idx_finance_alloc_target ON finance_allocations(ledger_id,target_kind,target_id);
    CREATE INDEX IF NOT EXISTS idx_statement_card ON credit_statements(ledger_id,account_id);
  `);
  column('finance_payments','txn_time','TEXT');
  column('finance_payments','sources_json',"TEXT NOT NULL DEFAULT '[]'");
  column('finance_payments','external_mode','TEXT');
  column('finance_payments','allocation_mode',"TEXT NOT NULL DEFAULT 'manual'");
  column('finance_payments','replaced_by','INTEGER');
  column('credit_profiles','rules_json',"TEXT NOT NULL DEFAULT '[]'");
  column('credit_profiles','opening_closing','TEXT');
  column('finance_contracts','disbursement_txn_id','INTEGER');
  column('transactions','refund_of_id','INTEGER');
  db.exec('CREATE TABLE IF NOT EXISTS credit_charge_operations(ledger_id INTEGER NOT NULL,operation_key TEXT NOT NULL,statement_id INTEGER NOT NULL,signature TEXT NOT NULL,transaction_ids TEXT NOT NULL,PRIMARY KEY(ledger_id,operation_key))');
  db.exec('CREATE TABLE IF NOT EXISTS finance_create_operations(ledger_id INTEGER NOT NULL,operation_key TEXT NOT NULL,contract_id INTEGER NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(ledger_id,operation_key))');
}
module.exports={ensure};
