# Stage 5A — Production bootstrap candidate

Scope: controlled local initialization and read-only readiness checks. Base main f64e4752a483b7b316aa86777bea006269c80024. No production initialization, deployment, backup/restore drill or provider request was performed by this implementation.

## Identity and permission authority

The existing auth_accounts/auth_credentials/auth_grants/auth_sessions/auth_events/auth_policy_attributes and employees remain authoritative. Actual actor principal and credited employee are separate UUIDs with an explicit unique binding. No users table, runtime role system, shared account or name-based authority is added.

[Full UUID/permission matrix](REAL_STAFF_PERMISSION_MATRIX.md) and [proposed staff plan](../production/staff-plan.proposed.json) contains six stable pairs, proposed login identifiers, approved=false and enabled=false for every account. It creates nothing automatically. Owner must review a copy, confirm target/store, choose individual credentials and account activation before apply. 邵叔 and 邵老板 refer to the same proposed person, not two accounts.

Templates in production/plan.js expand only explicit known PERMISSION_IDS:

- NIGHT_OPERATOR: room.open, room.reserve, room.clean, room.issue, staff.record, order.sale, retail.sale, payment.collect, payment.settle, handover.
- SALES_BOOKING: order.sale, staff.record, room.reserve.
- BOOKING_STAFF: staff.record, room.reserve.

Additional permissions and policy attributes must be explicit existing IDs. Unknown IDs, wildcards, duplicate identifiers/bindings and conflicting existing rows stop the transaction. Names are display labels only.

| Person | Template | Independent night / settle / retail | Booking attribution | Backend / approvals / self review |
|---|---|---|---|---|
| 卓老板 | NIGHT_OPERATOR | YES after activation | Explicit employee binding | NEEDS OWNER DECISION; currently none |
| 老板娘 | NIGHT_OPERATOR | YES after activation | Explicit employee binding | NEEDS OWNER DECISION; currently none |
| 邵叔（邵老板） | NIGHT_OPERATOR | YES after activation | Explicit employee binding | NEEDS OWNER DECISION; currently none |
| 雄老板 | NIGHT_OPERATOR | YES after activation | Explicit employee binding | NEEDS OWNER DECISION; currently none |
| 卓益 | SALES_BOOKING | NO / NO / NO | YES | NEEDS OWNER DECISION; currently none |
| 美娇 | BOOKING_STAFF | NO / NO / NO | YES | NEEDS OWNER DECISION; currently none |

Booking attribution does not grant permissions or establish a new commission rate. Commission rules and employee snapshots remain in the existing trusted application. Neither template grants backend.view, review.self, rounding.approve, credit.approve, inventory approval, expense approval or privileged policy attributes.

Existing rules remain: <=10 yuan rounding direct; >10 requires approval. Self excess approval requires rounding.approve + review.self + rounding.self.excess. Reject does not require rounding.self.excess. Credit <=1000 requires credit.approve plus credit.approval.manager or credit.approval.boss; >1000 requires the boss attribute. backend.view is only view eligibility. Expense boss policy and every review grant remain independent.

## Controlled identity bootstrap

Apply versioned migrations 001–010 separately. Bootstrap never performs DDL. It verifies MySQL 8.4, the exact eighteen-table migration-derived structure, constraints, indexes, engine, migration source digests and database target before initialization. Extra/unknown/partial schema stops. See [schema authority](../database/README.md).

Use a Git-external secret JSON with databaseUrl and passwords keyed by principal UUID. Values are individually selected final passwords, never a shared default. Do not put secrets on the command line or in the plan. External paths are resolved; any file within a Git checkout, including through a symlink, is refused. Restrict file access to the operator/person and remove temporary handoff files after use. The tool does not print the file, driver diagnostics, raw passwords, tokens or Cookie values.

Example shape only (no real credential):

```json
{
  "databaseUrl": "mysql://CHANGE_USER:CHANGE_PASSWORD@CHANGE_HOST/jbhh_ktv",
  "passwords": { "REVIEWED_PRINCIPAL_UUID": "INDIVIDUAL_FINAL_PASSWORD" }
}
```

Read-only review:

```powershell
node production/bootstrap-cli.js --plan production/staff-plan.proposed.json --secrets-file C:\Users\KAMABOKO\.secrets\staff-bootstrap.json --confirm-target jbhh_ktv/jbhh/main --initiated-by OWNER_OPERATOR --dry-run
```

Default is dry-run. Explicit --apply requires approved=true in the reviewed plan. Dry-run runs a READ ONLY transaction, inspects conflicts, lists planned creation/grants/bindings and missing credential IDs, rolls back, and writes no audit or data. Target confirmation must exactly match database/storeId/ledgerId. The committed database/store/ledger values are proposals, not accepted production targets.

Production plans refuse test database names. Test plans require exact jbhh_ktv_test, the explicitly supplied LEDGER_MYSQL_TEST_URL, and a non-production environment. Initialization records the store/ledger/environment and refuses subsequent cross-store use.

Apply uses one transaction and a database-scoped bootstrap lock. Account locks precede employee locks. It reuses existing scrypt derivation and auth persistence operations. Rerun preserves credentials, existing accounts/employees/bindings and grants. Before the first receipt for an identity, missing compatible employee/grant data may be added. Once recorded, the normalized person plan (including template, expanded grants and attributes) and current grants must match; altered bindings, additional grants or missing grants are conflicts, never reconciliation. Same-plan no-op returns status=already_satisfied and writes only an execution audit receipt; existing names, enablement, different bindings, extra grants and conflicting policy attributes are never overwritten or deleted. A configured policy set must match exactly; changes to it use the existing separately authorized policy management service. Disabled accounts/employees are supported at creation. Later disable/revoke uses the existing auth administration service; bootstrap rejects enablement conflicts.

production_bootstrap_events records external initiatedBy, UTC startedAt/completedAt transaction-work timestamps, source, config version/digest and exact non-secret identities/grants/policy facts and counts. This is an OS-authorized CLI operation; initiatedBy is not falsely presented as an authenticated browser actor. Existing auth events also record creation/grants/disable. No fabricated technical employee or auth account is needed. Commit ambiguity returns BOOTSTRAP_COMMIT_UNKNOWN; inspect persisted facts and rerun the same plan, never reset data.

## Password changes

production/change-password-cli.js is a controlled server CLI using existing auth.changeOwnPassword. A private Git-external input includes databaseUrl, database, storeId, ledgerId, environment, loginIdentifier, currentPassword and newPassword. Invoke with --secrets-file and the same --confirm-target.

Current credential is verified with existing scrypt under the account/session locks. Wrong/disabled credentials are rejected. Success updates the existing credential, increments credential_version, revokes old sessions and records credential-rotated/session-revoked events. No password/hash is returned. HTTP login remains unchanged; next login uses the new password. This is not an employee browser password page or an administrator reset feature. Admin reset and its authority/process remain NEEDS OWNER DECISION; direct SQL hash edits are not an operating procedure.

## Room mapping checklist

production/mapping-cli.js accepts --plan, --secrets-file (databaseUrl), --confirm-target, --initiated-by, --dry-run/--apply. A mapping plan has configVersion, environment, database, storeId, ledgerId, approved and mappings. Each explicit mapping requires internalRoomId, provider=ktvsky, externalDeviceId, enabled, source=human-confirmed, confirmedAt (UTC ISO) and confirmedBy.

Requires a valid existing ledger room and schema; never guesses from room names. Dry-run does not write. Same target reruns create zero mappings. Any different existing target/enablement or duplicate external device fails without overwrite. Identity bootstrap and mapping bootstrap are separate transactions; no cross-tool atomicity is claimed. Mapping rows remain in room_device_mappings; source/time/operator are durably recorded in production_bootstrap_events.facts.mappings. Ordinary CLI/readiness output masks devices to their last four characters. No MAC is hardcoded in business code.

| Room | Human mapping evidence | Stage 5A initialization |
|---|---|---|
| V01 | NEEDS CONFIRMATION | unmapped/disabled |
| V02 | NEEDS CONFIRMATION | unmapped/disabled |
| V03 | NEEDS CONFIRMATION | unmapped/disabled |
| V05 | NEEDS CONFIRMATION | unmapped/disabled |
| V06 | CONFIRMED historically, suffix 674B, Stage 4B.1 | not written to production in this task; submit reviewed external mapping |
| 333 | NEEDS CONFIRMATION | unmapped/disabled |
| 666 | NEEDS CONFIRMATION | unmapped/disabled |
| 999 | NEEDS CONFIRMATION | unmapped/disabled |
| 888 | NEEDS CONFIRMATION | unmapped/disabled |

A confirmed mapping does not activate provider control. Stage 5A rejects KTVSKY_LIVE_CONTROL_ENABLED=true. No provider login, query, close, open or timer request is made.

## Production configuration and startup

Production is selected by any of NODE_ENV, KTV_HTTP_ENV or KTV_DEPLOYMENT_ENV=production, or enabled API without explicit development HTTP mode. The shared deployment parser accepts only absent values or canonical development/test/production; other case, surrounding whitespace, empty values and aliases (including prod/live/staging) are rejected, never interpreted as development. validateProductionConfig requires:

| Setting | Required value |
|---|---|
| KTV_API_MODE | enabled |
| KTV_HTTP_ENV | production |
| KTV_MYSQL_URL | explicit authenticated MySQL URL, production database |
| KTV_STORE_ID / KTV_LEDGER_ID | explicit reviewed identities |
| KTV_BUSINESS_TIME_ZONE | valid explicit IANA zone, e.g. Asia/Shanghai |
| KTV_BUSINESS_DATE_CUTOFF | 12:00 |
| KTV_SESSION_RULE_VERSION | opening-hours-v1 |
| DEVICE_CONTROL_MODE | disabled or required |
| KTVSKY_LIVE_CONTROL_ENABLED | false |
| KTV_PUBLIC_ORIGIN | HTTPS exact origin |
| KTV_INSECURE_COOKIE | absent or false |
| KTVSKY_CREDENTIALS_FILE | optional while control OFF; if supplied, Git-external telno/password JSON validated locally |

DAY 14:00–18:00, NIGHT 18:00–next-day02:00, CLOSED02:00–14:00 are existing frozen domain rules; sessionDate and revenue businessDate remain separate. Validation does not introduce another clock or price rule.

Invalid static config throws before pool connection. Then the server performs read-only schema/store/identity/ledger/catalog/inventory/mapping checks. Until they succeed, /api/* returns 503 service_unavailable; trusted writes and device worker do not run. Failures remain unavailable until operator correction and restart. There is no demo/localStorage fallback. The default non-production static development behavior is retained; formal employee/admin entries continue to use HTTP authority.

Required mode needs enabled, human-confirmed mappings for every room. Since the production provider is still disabled, required mode also reports DEVICE_REQUIRED_PROVIDER_PRODUCTION_DISABLED and remains unavailable in Stage 5A. Disabled mode is the explicitly supported safe bootstrap configuration; it does not claim device control.

## Read-only readiness report

```powershell
node production/readiness-cli.js --config-file C:\Users\KAMABOKO\.secrets\production-config.json
```

The external JSON supplies the settings above. Output contains target/store, schema migrations, server revision, redacted configuration, product IDs/options/categories, DAY/NIGHT prices, inventory counts, mapping checklist and blocker codes. It omits DB URL/user/password, provider secrets and full device IDs. Exit0=ready for this bootstrap configuration, exit2=reported blockers, exit1=invalid/unavailable checks. This does not mean production ready.

Catalog uses the existing pricedSaleOptions helper: ordinary beer/beverage DAY half50/dozen100 yuan, premium half60/dozen120; singles unchanged. Missing/unknown category, missing sale option, invalid DAY base quantity or price is reported, not guessed. OTHER explicitly retains the existing price plan. Existing beverage half/dozen options derived by the trusted DAY plan are reported as derived DAY options; they are not written into catalog by this tool.

Inventory null/undefined means uninitialized; 0 is a valid initialized count. Every active inventory-managed product/consumable is checked. No count is automatically set to zero. No catalog, order, payment, inventory or historical snapshot is modified by bootstrap/readiness.

Current DEFAULT_CATALOG inspection (not a production DB read): 23 active entries, 16 sellable; DAY coverage valid, 20 inventory-managed entries have count=null and need real opening counts. Actual production ledger/catalog/inventory have not been provided or initialized, and remain cutover blockers.

## Destructive safety and verification

test-support/destructive-safety.js uses the same strict deployment parser as startup and the test-target guard: any production value or any noncanonical/unknown value for NODE_ENV, KTV_HTTP_ENV or KTV_DEPLOYMENT_ENV is refused. All five real MySQL fixture entry points acquire the common guard before DDL; every fixture cleanup DROP rechecks it. The policy fixture loader and historical browser recovery harness also guard before fixture writes. Existing exact jbhh_ktv_test target checks, ownership lists and fixture lock remain. Formal / never invokes demo reset/fixture loading.

Focused tests cover preview zero writes, fresh migration, first/repeated/concurrent bootstrap, partial rows, conflicts, unknown capabilities, one-to-one binding, scrypt/non-secret audit, current-password verification, session invalidation, disabled trusted writes, mapping roundtrip, required missing mappings, null versus zero, config/zone validation and production cleanup refusal. Real integration uses only the owned loopback MySQL 8.4.11/InnoDB instance on33313, not any production service.

## Remaining owner decisions / gates

- Confirm production database/store/ledger identity and six login identifiers; approve/activate individual accounts and private password handoff.
- Decide backend, rounding/credit/repayment/expense/inventory/gift/room-issue/incident approval grants and self review separately for each person.
- Assign manager/boss credit and expense/self-excess policy attributes explicitly. No inference from names or template names.
- Confirm any exchange/gift/deposit/report/expense/procurement duties beyond the minimal accepted templates.
- Confirm all real room device mappings, source/time/operator and desired enabled flags; keep provider production gate OFF.
- Supply actual production catalog and opening inventory counts through existing trusted paths; bootstrap never invents them.
- Admin reset authority/process, employee browser password UX and multi-process login rate limiting remain future operating/deployment decisions.
- Backup/restore drill, deployment, monitoring, real Meituan and production cutover are not completed here.

PRODUCTION IDENTITY BOOTSTRAP = implemented candidate
PRODUCTION CONFIG READINESS CHECKS = implemented candidate
BACKUP / RESTORE DRILL = NOT DONE
DEPLOYMENT = NOT DONE
KTVSKY LIVE PRODUCTION CONTROL = OFF
PRODUCTION READY = NO
14-DAY OFFSITE MVP READY = NO
