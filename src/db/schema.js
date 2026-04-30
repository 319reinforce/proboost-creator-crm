const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS creators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT,
  email_identity TEXT,
  status TEXT NOT NULL DEFAULT 'invited',
  source TEXT,
  notes TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pushed',
  pushed_at TEXT,
  registered_at TEXT,
  raw_source TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES creators(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  purpose TEXT,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(name, version)
);

CREATE TABLE IF NOT EXISTS send_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER,
  invite_code_id INTEGER,
  template_id INTEGER,
  campaign_id INTEGER,
  subject_rendered TEXT,
  body_rendered TEXT,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 1,
  sent_at TEXT,
  verified_at TEXT,
  error_message TEXT,
  screenshot_path TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES creators(id),
  FOREIGN KEY (invite_code_id) REFERENCES invite_codes(id),
  FOREIGN KEY (template_id) REFERENCES templates(id),
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
);

CREATE TABLE IF NOT EXISTS mail_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER,
  provider_thread_id TEXT,
  mailbox TEXT,
  subject TEXT,
  sender TEXT,
  recipient TEXT,
  first_message_at TEXT,
  last_message_at TEXT,
  last_synced_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE TABLE IF NOT EXISTS mail_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER,
  creator_id INTEGER,
  direction TEXT NOT NULL,
  subject TEXT,
  sender TEXT,
  recipient TEXT,
  body_text TEXT,
  body_html TEXT,
  sent_at TEXT,
  received_at TEXT,
  raw_snapshot_path TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (thread_id) REFERENCES mail_threads(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE TABLE IF NOT EXISTS analysis_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER,
  creator_id INTEGER,
  intent TEXT,
  confidence REAL,
  sentiment TEXT,
  needs_invite_code INTEGER,
  has_contact INTEGER,
  contact_type TEXT,
  contact_value TEXT,
  recommended_action TEXT,
  reason TEXT,
  model TEXT,
  prompt_version TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES mail_messages(id),
  FOREIGN KEY (creator_id) REFERENCES creators(id)
);

CREATE TABLE IF NOT EXISTS manual_review_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id INTEGER,
  thread_id INTEGER,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  assignee TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (creator_id) REFERENCES creators(id),
  FOREIGN KEY (thread_id) REFERENCES mail_threads(id)
);

CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  manifest_path TEXT,
  batch_number TEXT,
  template_name TEXT,
  payload_json TEXT,
  result_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const SEED = `
INSERT OR IGNORE INTO templates (
  name,
  purpose,
  subject_template,
  body_template,
  version,
  is_active
) VALUES (
  '督促产品使用',
  'unused_invite_reminder',
  'Quick reminder — your access code expires soon',
  'Hi \${creator_name}!

Just checking in — did you get a chance to activate your Moras access code?

Your invite code is: \${invite_code}

Quick note: this code is only valid for the next \${expires_in}, and we are currently onboarding creators in limited batches.

The setup is super quick — most creators generate their first shoppable video in under 2 minutes.

Signup link: \${signup_link}

Best,
ProBoost Team',
  1,
  1
);
`;

module.exports = {
  SCHEMA,
  SEED,
};
