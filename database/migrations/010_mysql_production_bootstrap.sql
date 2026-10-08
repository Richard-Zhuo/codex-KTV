-- Apply once after 009; data initialization is a separate controlled CLI.
-- This audit records an external operator, not a fabricated authenticated actor.
CREATE TABLE production_bootstrap_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id VARCHAR(191) NOT NULL,
  ledger_id VARCHAR(64) NOT NULL,
  environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  initiated_by VARCHAR(191) NOT NULL,
  config_version VARCHAR(64) NOT NULL,
  plan_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  facts JSON NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (event_id),
  CONSTRAINT bootstrap_environment CHECK (environment IN ('production', 'test'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

