-- Track Webflow CMS mappings and the last successfully published counters.

ALTER TABLE content_counters ADD COLUMN webflow_item_id TEXT;
ALTER TABLE content_counters ADD COLUMN synced_likes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_counters ADD COLUMN synced_views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_counters ADD COLUMN sync_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_counters ADD COLUMN last_synced_at TEXT;
ALTER TABLE content_counters ADD COLUMN sync_error TEXT;

CREATE INDEX IF NOT EXISTS idx_content_counters_sync_pending
  ON content_counters(sync_pending, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_content_counters_webflow_item_id
  ON content_counters(webflow_item_id)
  WHERE webflow_item_id IS NOT NULL;
