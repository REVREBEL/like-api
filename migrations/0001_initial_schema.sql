-- REVREBEL like/view counter schema
-- D1 uses SQLite semantics.

CREATE TABLE IF NOT EXISTS content_counters (
  slug TEXT PRIMARY KEY,
  likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
  views INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counter_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('like', 'view')),
  action TEXT NOT NULL CHECK (action IN ('increment', 'decrement')),
  delta INTEGER NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (slug) REFERENCES content_counters(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_counter_events_slug_created_at
  ON counter_events(slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_content_counters_updated_at
  ON content_counters(updated_at DESC);
