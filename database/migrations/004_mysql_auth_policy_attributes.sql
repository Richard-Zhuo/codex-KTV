-- Policy attribute foundation: apply once after 002 on MySQL 8.4.
-- Each DDL statement commits independently. Inspect partial progress before retry.
-- No person, role, legacy name or principal is configured by this migration.

ALTER TABLE auth_accounts
  ADD COLUMN policy_attributes_configured TINYINT(1) NOT NULL DEFAULT 0,
  ADD CONSTRAINT chk_auth_policy_configured CHECK (policy_attributes_configured IN (0, 1));

CREATE TABLE auth_policy_attributes (
  principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attribute_id VARCHAR(100) COLLATE utf8mb4_bin NOT NULL,
  granted_at DATETIME(6) NOT NULL DEFAULT (UTC_TIMESTAMP(6)),
  PRIMARY KEY (principal_id, attribute_id),
  CONSTRAINT fk_auth_policy_attribute_account FOREIGN KEY (principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  CONSTRAINT chk_auth_policy_attribute_specific CHECK (attribute_id = 'rounding.self.excess')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE auth_events
  ADD COLUMN actor_principal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN policy_attribute_id VARCHAR(100) COLLATE utf8mb4_bin NULL,
  ADD KEY ix_auth_event_actor_time (actor_principal_id, occurred_at),
  ADD CONSTRAINT fk_auth_event_actor FOREIGN KEY (actor_principal_id)
    REFERENCES auth_accounts (principal_id) ON DELETE RESTRICT,
  DROP CHECK chk_auth_event_type,
  ADD CONSTRAINT chk_auth_event_type CHECK (event_type IN (
    'account-created', 'credential-rotated', 'grant-added', 'grant-removed',
    'login-success', 'login-failure', 'logout', 'session-revoked', 'account-disabled',
    'policy-attributes-configured', 'policy-attribute-granted', 'policy-attribute-revoked'
  )),
  ADD CONSTRAINT chk_auth_attribute_event CHECK (
    (event_type NOT IN ('policy-attributes-configured', 'policy-attribute-granted', 'policy-attribute-revoked')
      AND actor_principal_id IS NULL AND policy_attribute_id IS NULL)
    OR
    (event_type IN ('policy-attributes-configured', 'policy-attribute-granted', 'policy-attribute-revoked')
      AND actor_principal_id IS NOT NULL AND principal_id IS NOT NULL
      AND session_id IS NULL AND reason_code IS NULL
      AND ((event_type = 'policy-attributes-configured' AND policy_attribute_id IS NULL)
        OR (event_type IN ('policy-attribute-granted', 'policy-attribute-revoked')
          AND policy_attribute_id IS NOT NULL AND policy_attribute_id = 'rounding.self.excess')))
  );
