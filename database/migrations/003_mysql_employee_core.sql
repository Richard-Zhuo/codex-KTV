-- Employee roster foundation. Requires 002_mysql_auth_core.sql; run once.
-- MySQL DDL commits each statement; inspect a partial failure before retry.
-- No employee, account, demo USERS or name mapping is seeded here.

CREATE TABLE employees (
  employee_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  display_name VARCHAR(80) COLLATE utf8mb4_bin NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (employee_id),
  UNIQUE KEY uq_employee_principal (principal_id),
  CONSTRAINT fk_employee_principal FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_employee_name CHECK (CHAR_LENGTH(TRIM(display_name)) > 0),
  CONSTRAINT chk_employee_enabled CHECK (enabled IN (0, 1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE employee_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  employee_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  before_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  after_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (event_id),
  KEY ix_employee_event_time (employee_id, occurred_at, event_id),
  CONSTRAINT fk_employee_event_employee FOREIGN KEY (employee_id)
    REFERENCES employees (employee_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employee_event_actor FOREIGN KEY (actor_principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employee_event_before FOREIGN KEY (before_principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_employee_event_after FOREIGN KEY (after_principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_employee_event_shape CHECK (
    (event_type = 'employee-created' AND before_principal_id IS NULL AND after_principal_id IS NULL)
    OR (event_type = 'principal-linked' AND before_principal_id IS NULL AND after_principal_id IS NOT NULL)
    OR (event_type = 'principal-unlinked' AND before_principal_id IS NOT NULL AND after_principal_id IS NULL)
    OR (event_type = 'employee-disabled' AND (
      (before_principal_id IS NULL AND after_principal_id IS NULL)
      OR (before_principal_id IS NOT NULL AND after_principal_id IS NOT NULL
        AND before_principal_id = after_principal_id)
    ))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
