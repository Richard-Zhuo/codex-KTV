# Stage 4C trusted opening and device readiness

## Server authority

DEVICE_CONTROL_MODE defaults to disabled. A disabled opening keeps the established business behavior and explicitly records deviceControl.status=DISABLED; this is no provider verification. required enrolls one room_control_workflows record with the order, package/inventory effects, original openingOperationKey, ledger operation result and success audit in the same locked MySQL transaction. Missing/disabled room_device_mappings fails closed with 该房间设备尚未完成系统绑定. Only manually configured ledger/internalRoomId/provider/externalDeviceId/enabled rows are valid; no real device seed or name inference exists.

The frozen order remains the business record. Its original businessState=OPENING is the creation snapshot; current readiness is derived from checksummed workflow evidence on the same snapshot connection before permission filtering. While pending, the existing occupied room/order binding reserves the room; another open cannot pass. Trusted order commands read current workflow readiness under the head lock and reject before ACTIVE, even if the server mode later changes to disabled. Failure never deletes orders, restores stock, refunds or reopens the room automatically.

## Claim, effect, evidence

Transaction A: existing auth revalidation, authorization, original-key lookup, revision, employee/session/price facts, domain transaction and workflow insert commit together. HTTP returns promptly with orderId, deviceWorkflowId, businessState and revision. Replaying the exact original request returns the original creation result, not a new workflow. Read snapshots for current progress.

The server runtime uses a bounded persistent MySQL queue and existing per-workflow claim/lease/version fences. A worker tick commits the claim and releases its connection before ensureSession/status/control/query; a second short transaction persists safe evidence. No employee session token is stored for workers: the server only advances a previously authorized, committed intent. Revoking an employee session prevents new employee commands but does not strand an accepted opening. Order ownership and stable mapping remain checked before new effects.

Initial ONLINE+CLOSED skips close with PRECONDITION_SATISFIED. ONLINE+OPEN closes once and verifies CLOSED before one combined open-with-countdown. OFFLINE is WAITING_DEVICE with no mutation; restart scans the same rows. UNKNOWN/expired claims only query; only settled NOT_APPLIED with retrySafe permits a later effect. ACK with unavailable verification stays verification pending, query-only. Late results are fenced by persisted attempt ID. ACTIVE is terminal historical confirmation.

countdownSeconds is ceil((frozen targetEndAt - trusted current DB time)/1000); no whole-minute overrun and no browser clock. The shared remaining-seconds predicate accepts persisted ACK dispatch time plus fresh ONLINE/OPEN and bounded elapsed-time evidence. An exact target echo is accepted for the isolated Fake provider. Historical confirmed OPEN is retained after expiry.

## Production gate

KtvSkyRoomControlGateway.productionEnabled is still false. The bootstrap never reads live credentials or changes a live gate; required mode can reserve a business opening but its real worker remains paused until a separately authorized production cutover. DEVICE_CONTROL_MODE=required does not itself enable KTVSky. Fake runtimes require explicit testOnly and jbhh_ktv_test; never a production fallback.

## Verification

The guarded existing ledger/trusted-clean.integration.test.js fixture applies migrations 001..009 and invokes devices/open.integration.js. Formal HTTP session/CSRF, real MySQL and FakeGateway cover CLOSED, OPEN, WAIT/restart, lost open response, ACK/query failure, timing evidence, original-key replay, concurrent clients, missing mapping, rollback after intent insert and absence of held SQL head locks during effects. devices/worker.test.js covers bounded overlapping ticks and shutdown. No real provider request belongs to Stage 4C tests.
