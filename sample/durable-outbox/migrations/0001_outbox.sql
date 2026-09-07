CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  mail_json TEXT NOT NULL,
  message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending','retry','accepted','dead_letter','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  claim_id TEXT,
  lease_until INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX outbox_due ON outbox(status,next_attempt_at);
CREATE INDEX outbox_leases ON outbox(status,lease_until);
CREATE TABLE outbox_attempts (
  id TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbox(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  smtp_attempt_id TEXT,
  response_code INTEGER,
  tls_mode TEXT,
  reason TEXT,
  UNIQUE(outbox_id,number)
);
