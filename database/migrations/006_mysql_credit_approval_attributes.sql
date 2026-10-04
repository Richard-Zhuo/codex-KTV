-- Apply after 005 on MySQL 8.4. Only expand the two named metadata CHECK constraints.
-- Each ALTER commits independently; inspect partial progress after a failure.
-- Repeating the script replaces the same CHECK definitions and preserves rows.
-- No account, permission, attribute assignment or business state is created.

ALTER TABLE auth_policy_attributes
  DROP CHECK chk_auth_policy_attribute_specific,
  ADD CONSTRAINT chk_auth_policy_attribute_specific CHECK (
    attribute_id IN ('rounding.self.excess', 'expense.approval.boss', 'credit.approval.manager', 'credit.approval.boss')
  );

ALTER TABLE auth_events
  DROP CHECK chk_auth_attribute_event,
  ADD CONSTRAINT chk_auth_attribute_event CHECK (
    (event_type NOT IN ('policy-attributes-configured', 'policy-attribute-granted', 'policy-attribute-revoked')
      AND actor_principal_id IS NULL AND policy_attribute_id IS NULL)
    OR
    (event_type IN ('policy-attributes-configured', 'policy-attribute-granted', 'policy-attribute-revoked')
      AND actor_principal_id IS NOT NULL AND principal_id IS NOT NULL
      AND session_id IS NULL AND reason_code IS NULL
      AND ((event_type = 'policy-attributes-configured' AND policy_attribute_id IS NULL)
        OR (event_type IN ('policy-attribute-granted', 'policy-attribute-revoked')
          AND policy_attribute_id IS NOT NULL
          AND policy_attribute_id IN ('rounding.self.excess', 'expense.approval.boss', 'credit.approval.manager', 'credit.approval.boss'))))
  );
