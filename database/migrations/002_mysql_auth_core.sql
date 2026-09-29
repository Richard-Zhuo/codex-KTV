-- Stage 2B authentication foundation. Run once after verifying the MySQL 8.4 target.
-- MySQL DDL commits each statement; a partial failure requires inspection before retry.
-- No real-person account, login identifier, password or grant is seeded here.

CREATE TABLE auth_accounts (
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  credential_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  disabled_at DATETIME(6) NULL,
  PRIMARY KEY (principal_id),
  CONSTRAINT chk_auth_account_enabled CHECK (enabled IN (0, 1)),
  CONSTRAINT chk_auth_account_disabled CHECK
    ((enabled = 1 AND disabled_at IS NULL) OR (enabled = 0 AND disabled_at IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE auth_credentials (
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  login_identifier VARCHAR(191) COLLATE utf8mb4_bin NOT NULL,
  password_algorithm VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  password_params_version SMALLINT UNSIGNED NOT NULL,
  salt VARBINARY(32) NOT NULL,
  derived_key VARBINARY(32) NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (principal_id),
  UNIQUE KEY uq_auth_login_identifier (login_identifier),
  CONSTRAINT fk_auth_credential_account FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_auth_credential_algorithm CHECK
    (password_algorithm = 'scrypt' AND password_params_version = 1),
  CONSTRAINT chk_auth_credential_lengths CHECK
    (OCTET_LENGTH(salt) = 32 AND OCTET_LENGTH(derived_key) = 32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE auth_grants (
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  permission_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  granted_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (principal_id, permission_id),
  CONSTRAINT fk_auth_grant_account FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_auth_grant_specific CHECK
    (permission_id <> 'administrator' AND permission_id NOT LIKE '%*%')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE auth_sessions (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_digest BINARY(32) NOT NULL,
  credential_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  last_seen_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  idle_expires_at DATETIME(6) NOT NULL,
  absolute_expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_auth_session_token_digest (token_digest),
  KEY ix_auth_session_principal (principal_id),
  CONSTRAINT fk_auth_session_account FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_auth_session_expiry CHECK
    (idle_expires_at <= absolute_expires_at AND absolute_expires_at > created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE auth_events (
  event_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  event_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  occurred_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (event_id),
  KEY ix_auth_event_principal_time (principal_id, occurred_at),
  CONSTRAINT fk_auth_event_account FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT fk_auth_event_session FOREIGN KEY (session_id)
    REFERENCES auth_sessions (session_id) ON DELETE RESTRICT,
  CONSTRAINT chk_auth_event_type CHECK (event_type IN (
    'account-created', 'credential-rotated', 'grant-added', 'grant-removed',
    'login-success', 'login-failure', 'logout', 'session-revoked', 'account-disabled'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
