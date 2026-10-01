CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  encrypted_auth TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_state (
  account_id TEXT PRIMARY KEY,
  last_run_at INTEGER,
  last_result TEXT,
  last_message TEXT,
  last_balance INTEGER,
  lock_until INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO accounts (account_id, encrypted_auth, connected_at, updated_at)
SELECT 'legacy', encrypted_auth, connected_at, updated_at
FROM account WHERE id = 1;

INSERT OR IGNORE INTO account_state
  (account_id, last_run_at, last_result, last_message, last_balance, lock_until)
SELECT 'legacy', last_run_at, last_result, last_message, last_balance, lock_until
FROM service_state WHERE id = 1 AND EXISTS (
  SELECT 1 FROM accounts WHERE account_id = 'legacy'
);

ALTER TABLE oauth_session ADD COLUMN account_id TEXT;
