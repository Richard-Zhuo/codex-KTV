# Stage 4A session and price contract

## Accepted basis and cases

Stage 3C accepted HEAD 3ebfad2 was fast-forwarded into main, passed 1859/1859 (0 fail, 0 skip), and was normally pushed after fetch verified no remote drift. Stage 4A stays local for human acceptance.

Server opening schedule reuses shared/time.js: DAY [14:00,18:00), NIGHT [18:00,02:00), closed [02:00,14:00). The reservation start at 20:00 is a separate reservation window, not a change to opening hours. No new opening hours are assumed. Existing noon business-date attribution is unchanged.

For new trusted room orders, businessSession freezes sessionType, sessionDate, explicit IANA timeZone, opening-hours-v1, pricePlanId and targetEndAt from transaction dbNow. After midnight NIGHT belongs to the previous sessionDate and ends at that session's following 02:00. countdownFor uses trusted current time; expired, forged, ambiguous or nonexistent local closing times fail closed. Duration rounds up to minutes; provider unit/rounding compatibility remains a Stage 4B gate. Browser time, plan and target are never trusted.

DAY day-v1 prices per dozen (12 base units): ORDINARY_BEER 10000 cents; BEVERAGE 10000; PREMIUM_BEER 12000. Only dozen price changes; other options retain current catalog values. BEVERAGE gets a DAY-only dozen option. All NIGHT/existing prices use night-existing-v1 and current catalog sale options unchanged. Stable v1 IDs migrate to explicit priceCategory in catalog schema v2; custom unknown IDs default OTHER, no display-name or historical-price inference. Catalog remains stored in the existing MySQL ledger JSON; no second SQL catalog is introduced. Migration is deterministic/idempotent at the existing mergeCatalog boundary and projection; it does not change old orders.

Room additions use the order's frozen session plan for its lifetime; retail uses transaction dbNow and configured zone. Retail outside room opening hours retains the existing all-hours permission and existing-price plan. Historical orders without session metadata retain existing prices; no retroactive DAY inference. Product, option, base quantity, unit price, amount, price category, plan and session snapshots are frozen on each sale. Current catalog edits affect only future facts.

Cases: trusted DAY room/retail sale charges 100/100/120; NIGHT stays existing; forged client plan/clock/target does not alter server choice; replay preserves receipt; catalog edits do not change prior lines. Success evidence is saved server snapshot and revision, not a rendered estimate. Full tests require the guarded disposable MySQL harness. Device countdown dispatch and real provider integration are not part of this commit.
