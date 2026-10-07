-- Apply after 001..007. Independent device outbox; never rewrites order facts.
CREATE TABLE room_control_workflows (
  ledger_id VARCHAR(64) NOT NULL,
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_key VARCHAR(120) NOT NULL,
  order_id VARCHAR(191) NOT NULL,
  actor_principal_id VARCHAR(191) NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT UNSIGNED NOT NULL,
  state_json JSON NOT NULL,
  state_checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (ledger_id, workflow_id),
  UNIQUE KEY room_control_operation (ledger_id, operation_key),
  UNIQUE KEY room_control_order (ledger_id, order_id),
  CONSTRAINT room_control_version CHECK (version <= 9007199254740991),
  CONSTRAINT room_control_state CHECK (JSON_TYPE(state_json) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
