-- Recovery coordination only. No staff, mappings, inventory or live provider seeds.
CREATE TABLE recovery_control (
  control_id TINYINT UNSIGNED NOT NULL,
  mode VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  store_id VARCHAR(191) NOT NULL,
  ledger_id VARCHAR(64) NOT NULL,
  environment VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  backup_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  initiated_by VARCHAR(191) NOT NULL,
  facts JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (control_id),
  CONSTRAINT recovery_singleton CHECK (control_id = 1),
  CONSTRAINT recovery_mode CHECK (mode IN ('NORMAL','FROZEN','RESTORING','VERIFYING','READY_FOR_RESUME','FAILED')),
  CONSTRAINT recovery_environment CHECK (environment IN ('production','test'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE recovery_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  initiated_by VARCHAR(191) NOT NULL,
  reason VARCHAR(191) NOT NULL,
  facts JSON NOT NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
