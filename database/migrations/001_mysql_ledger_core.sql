-- Stage 1B-MySQL transitional ledger. Run once in a verified empty MySQL 8.4 test or target database.
-- MySQL DDL commits each statement; do not treat this three-table migration as one transaction.
-- A repeated run fails on the existing first table. Inspect any partial migration before retrying.
-- No historical browser data or legacy PostgreSQL relationship tables are imported here.

CREATE TABLE ledger_heads (
  ledger_id VARCHAR(64) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  state_schema_version INT UNSIGNED NOT NULL,
  state_json JSON NOT NULL,
  state_checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (ledger_id),
  CONSTRAINT chk_ledger_head_revision CHECK (revision <= 9007199254740991),
  CONSTRAINT chk_ledger_head_state CHECK (JSON_TYPE(state_json) = 'OBJECT')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE ledger_operations (
  ledger_id VARCHAR(64) NOT NULL,
  operation_key VARCHAR(120) NOT NULL,
  actor_principal_id VARCHAR(191) NOT NULL,
  action VARCHAR(100) NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint_version SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  expected_revision BIGINT UNSIGNED NOT NULL,
  observed_revision BIGINT UNSIGNED NOT NULL,
  terminal_status VARCHAR(24) NOT NULL,
  terminal_result JSON NOT NULL,
  committed_revision BIGINT UNSIGNED NULL,
  completed_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (ledger_id, operation_key),
  UNIQUE KEY uq_ledger_committed_revision (ledger_id, committed_revision),
  CONSTRAINT fk_ledger_operation_head FOREIGN KEY (ledger_id)
    REFERENCES ledger_heads (ledger_id) ON DELETE RESTRICT,
  CONSTRAINT chk_ledger_operation_status CHECK
    (terminal_status IN ('committed', 'revision-conflict', 'business-rejected')),
  CONSTRAINT chk_ledger_operation_version CHECK (fingerprint_version = 1),
  CONSTRAINT chk_ledger_operation_result CHECK (JSON_TYPE(terminal_result) = 'OBJECT'),
  CONSTRAINT chk_ledger_operation_revisions CHECK
    ((terminal_status = 'committed' AND committed_revision IS NOT NULL
      AND committed_revision = observed_revision + 1)
     OR (terminal_status <> 'committed' AND committed_revision IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE ledger_success_audit (
  ledger_id VARCHAR(64) NOT NULL,
  operation_key VARCHAR(120) NOT NULL,
  actor_principal_id VARCHAR(191) NOT NULL,
  action VARCHAR(100) NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  before_revision BIGINT UNSIGNED NOT NULL,
  after_revision BIGINT UNSIGNED NOT NULL,
  occurred_at DATETIME(6) NOT NULL,
  PRIMARY KEY (ledger_id, operation_key),
  CONSTRAINT fk_ledger_audit_operation FOREIGN KEY (ledger_id, operation_key)
    REFERENCES ledger_operations (ledger_id, operation_key) ON DELETE RESTRICT,
  CONSTRAINT chk_ledger_audit_revision CHECK (after_revision = before_revision + 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
