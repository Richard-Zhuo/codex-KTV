# Real staff permission matrix — proposed, not applied

Source: [stable plan](../production/staff-plan.proposed.json); template expansion: production/plan.js. All accounts remain disabled; approved=false. Database/store/login identifiers require owner confirmation. 邵叔 alias 邵老板 is one person.

| Person | Employee UUID | Principal UUID | Proposed login | Template | Enabled | Explicit permissions | Policy attributes |
|---|---|---|---|---|---|---|---|
| 卓老板 | 9d2ac576-575c-4a98-8e46-d170333b46b1 | 71a8d829-ad0e-4e0e-b6cd-5f907d748ba5 | zhuo-laoban | NIGHT_OPERATOR | NO | handover, order.sale, payment.collect, payment.settle, retail.sale, room.clean, room.issue, room.open, room.reserve, staff.record | none |
| 老板娘 | e7d3abd9-82a5-4446-a07c-e03d7844e4a4 | 629ec12e-a030-4e01-a012-54796e73c4a8 | laobanniang | NIGHT_OPERATOR | NO | handover, order.sale, payment.collect, payment.settle, retail.sale, room.clean, room.issue, room.open, room.reserve, staff.record | none |
| 邵叔 | 21b8362a-e065-4381-b735-4b0b11b46d25 | 9f032ade-9cf6-4329-aa26-b2b2a3088605 | shao-shu | NIGHT_OPERATOR | NO | handover, order.sale, payment.collect, payment.settle, retail.sale, room.clean, room.issue, room.open, room.reserve, staff.record | none |
| 雄老板 | 41a239fc-0be9-446d-9c28-3d6ef16e14e2 | cb83cdaa-0064-421c-a1a1-a32fc1eb3d5f | xiong-laoban | NIGHT_OPERATOR | NO | handover, order.sale, payment.collect, payment.settle, retail.sale, room.clean, room.issue, room.open, room.reserve, staff.record | none |
| 卓益 | 31773658-a1a6-466c-a98d-a169012454fc | e76141ee-1558-4ef3-9083-d2431c3a9ba8 | zhuo-yi | SALES_BOOKING | NO | order.sale, room.reserve, staff.record | none |
| 美娇 | a6e4fe91-f26c-45aa-bbe4-ad14bc97cbce | 7da426bf-a628-4999-a71d-cb6751f035cf | mei-jiao | BOOKING_STAFF | NO | room.reserve, staff.record | none |

backend.view, rounding/credit/inventory/expense/gift/repayment/room-recovery/incident approvals, review.self and privileged policy attributes: NEEDS OWNER DECISION per person; currently denied. Independent operation/settle/retail is proposed for the four NIGHT_OPERATOR accounts after activation; 卓益 may add sales and receive booking attribution, 美娇 booking attribution only. No new commission rules are introduced.
