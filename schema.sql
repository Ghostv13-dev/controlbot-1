-- schema.sql - idempotent: safe to re-run. Seeds only apply to EMPTY tables,
-- so re-running never brings back items you deleted.

CREATE TABLE IF NOT EXISTS users (
  tg_id      INTEGER PRIMARY KEY,
  username   TEXT,
  first_name TEXT,
  role       TEXT    NOT NULL DEFAULT 'user',   -- owner | admin | user
  state      TEXT    NOT NULL DEFAULT 'IDLE',   -- IDLE | LIVE | NP_* | AD_*
  state_data TEXT,                              -- JSON for wizards
  lang       TEXT    NOT NULL DEFAULT 'en',
  banned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS targets (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  title TEXT,
  type  TEXT                                    -- channel | group | page
);

CREATE TABLE IF NOT EXISTS bot_menus (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id    INTEGER,                         -- NULL = main reply keyboard
  button_text  TEXT NOT NULL,
  action_type  TEXT NOT NULL,                   -- text | url | topics | live | sub
  action_value TEXT,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS support_topics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id    INTEGER,
  title        TEXT NOT NULL,
  content_type TEXT NOT NULL,                   -- category | answer | link | live
  payload      TEXT,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS support_sessions (
  admin_msg_id INTEGER PRIMARY KEY,             -- message id inside the admin group
  user_id      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS post_queue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id     INTEGER NOT NULL,
  from_chat_id  INTEGER NOT NULL,
  message_id    INTEGER NOT NULL,
  scheduled_for INTEGER NOT NULL,               -- Unix ms, UTC
  status        TEXT NOT NULL DEFAULT 'pending',-- pending | sending | sent | failed | cancelled
  error         TEXT,
  created_at    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_due   ON post_queue (status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_menus_par   ON bot_menus (parent_id, position);
CREATE INDEX IF NOT EXISTS idx_topics_par  ON support_topics (parent_id, position);

-- ---- seeds (only when empty) ----
INSERT OR IGNORE INTO settings (key, value)
VALUES ('welcome', '👋 Welcome! Choose an option from the menu below.');

INSERT INTO bot_menus (id, parent_id, button_text, action_type, action_value, position)
SELECT * FROM (
  SELECT 1, NULL, '📚 Help Center',  'topics', NULL, 1
  UNION ALL SELECT 2, NULL, '🎧 Live Support', 'live',   NULL, 2
  UNION ALL SELECT 3, NULL, '🔗 Links',        'sub',    NULL, 3
  UNION ALL SELECT 4, 3,    '🌐 Website',      'url',    'https://example.com', 1
) WHERE NOT EXISTS (SELECT 1 FROM bot_menus);

INSERT INTO support_topics (id, parent_id, title, content_type, payload, position)
SELECT * FROM (
  SELECT 1, NULL, '❓ General', 'category', NULL, 1
  UNION ALL SELECT 2, 1,    'How does this bot work?', 'answer', 'Browse the help topics, or open Live Support to chat with our team.', 1
  UNION ALL SELECT 3, 1,    'Talk to a person',        'live',   NULL, 2
  UNION ALL SELECT 4, NULL, '🌐 Our website',          'link',   'https://example.com', 2
) WHERE NOT EXISTS (SELECT 1 FROM support_topics);
