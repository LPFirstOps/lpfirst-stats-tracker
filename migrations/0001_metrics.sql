-- Flat mirror of every scraped daily snapshot. One row per metric per stream per day.
-- company: 'aaction' | 'icon' | 'moyers'
-- source:  'cc' | 'sedgwick' | 'alacrity'
-- entity:  Icon location key, Alacrity contractor label, or '' for single-stream sources
CREATE TABLE metrics (
  company    TEXT NOT NULL,
  source     TEXT NOT NULL,
  entity     TEXT NOT NULL DEFAULT '',
  date       TEXT NOT NULL,             -- 'YYYY-MM-DD' in America/Chicago
  metric_key TEXT NOT NULL,
  value      REAL NOT NULL,
  year       INTEGER,                   -- ContractorConnection only (data is year-to-date); NULL otherwise
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (company, source, entity, date, metric_key)
) WITHOUT ROWID;

CREATE INDEX idx_metrics_stream_date ON metrics (company, source, entity, date);
CREATE INDEX idx_metrics_key_date    ON metrics (metric_key, date);
