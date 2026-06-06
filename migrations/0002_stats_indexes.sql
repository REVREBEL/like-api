-- Helpful query paths for dashboards/reporting later.

CREATE INDEX IF NOT EXISTS idx_content_counters_likes
  ON content_counters(likes DESC);

CREATE INDEX IF NOT EXISTS idx_content_counters_views
  ON content_counters(views DESC);
