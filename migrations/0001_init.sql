CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  encrypted_auth TEXT NOT NULL,
  connected_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_session (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at INTEGER,
  last_result TEXT,
  last_message TEXT,
  last_balance INTEGER,
  lock_until INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO service_state (id, lock_until) VALUES (1, 0);
