## Stage 4A accepted scope (2026-10-08)

Formal DAY/NIGHT, DAY dozen pricing and frozen transaction snapshots follow [Stage 4A contract](STAGE4A_SESSION_DEVICE.md). Device gateway/workflow is independent of employee open; real provider mutation is deferred to Stage 4B.

### 已确认：Stage 3C 正式管理后台

`/admin` 必须以正式 HTTP session 启动，服务端按当前 principal、permissions 和 policy attributes 返回最小后台视图及可信 ledger revision。只有 `backend.view` 能进入后台；该权限只授予查看资格，不授予任何审批。费用、采购、异常与待审批事项由服务端以明确权限过滤；未知权限一律不扩权。正式后台不从演示身份、浏览器角色或 `jbhh-demo-v1` 取得业务事实。

后台审批与驳回沿用 `POST /api/v1/commands/:action`、现有 trusted application、事务内认证复查与本人审批规则。新意图使用新 operationKey；结果不明时保留原键恢复；每次写入使用最后一次服务器确认的 revision，冲突后只重取状态，不自动重新审批。断网时旧快照只读，401 清除可写状态。Stage 3C 不包含真人账号初始化、部署、备份恢复、监控或真实美团生产启用。

### 已确认：平台券核销（R.1）

平台券只有服务端可信 redemption 为 REDEEMED、属于当前门店且未绑定订单时，才能覆盖房费。浏览器只能引用内部 voucherRedemptionId；券码、verified/redeemed 标记或 Skill 原始 JSON 不能作为开房证据。同一 redemption 最多绑定一个订单；provider 撤销／退款不能自动删除订单、付款、库存或历史成交，而应保留事实并产生异常待办。

生命周期集中维护：PENDING→REDEEMING；REDEEMING→REDEEMED/FAILED/UNKNOWN；UNKNOWN→REDEEMED/FAILED/REVERSED/REFUNDED；REDEEMED→REVERSED/REFUNDED。REVERSED/REFUNDED 默认终态。超时、断连、无法解析或无法关联到本次 attempt 一律 UNKNOWN；只有独立查询或可信事件的确定证据才能把 UNKNOWN 转为 FAILED，不能因网络错误判定失败或再次核销。乱序／无法合法转换的事件保留并进入 reconciliation/exception，不覆盖当前状态。

本地先以短事务保存 attempt、稳定 providerRequestId 与 REDEEMING，再在无 ledger head lock／MySQL transaction 时调用 provider，最后以第二短事务保存证据。相同 operationKey 在认领后重试不再调用 provider；已保存 UNKNOWN 为原 key 终态，后续查询使用新 operationKey 更新同一 redemption。未完成的认领也不会再次 consume，可通过独立查询收敛。权限不足没有本地 attempt 或外部副作用。provider actor 与员工 session principal 不混用。

券码是保留前导零及长度的 string；持久层仅保存服务器 secret 的 HMAC-SHA256 和 masked 值，不能保存明文或把 traceId 当成业务 flowId。providerRequestId 的本地唯一范围是 provider＋storeId，不代表 provider exactly-once 已获证明。业务 messageId 是事件去重键，公共 envelope msgId 另存。

Meituan production redemption = NOT ENABLED。Fake Gateway 仅用于显式隔离测试。真实启用前仍须完成门店业务授权、appAuthToken/developer credential 配置、mt-tech 实际响应契约、requestId 幂等范围与有效期、安全测试券／环境、正式 webhook 验签入口，以及 provider 商品与本地套餐的明确配置；不从名称猜映射。

 已确认需求与产品边界

本文件是当前产品需求的唯一维护位置。它说明“系统应该怎样”，不以当前代码是否已经实现来改写用户已确认的要求；实现状态见 [CURRENT_STAGE](./CURRENT_STAGE.md)。

状态含义：

- **已确认**：来自用户明确要求或已确认业务基线，变更需要新的用户决定。
- **建议**：为后续工程化提出的方案，不是验收门槛。
- **待决定**：缺少用户决定，不能由实现者自行补全。

## 已确认：脱岗 MVP 行为契约

- 14 天离场目标下，现场人员必须能安全、正确、简单地营业。共享可信账本、真人身份、正向交易与库存、撤单／退款／冲正、营业日与班次、渠道对账、审批审计、异常恢复及备份恢复的逐项目标见 [29 项 P0 矩阵](./OFFSITE_P0_MATRIX.md)。
- [OFFSITE_CONTRACTS](./OFFSITE_CONTRACTS.md) 定义跨模块金额、快照与反向交易行为；[KNOWN_ISSUES](./KNOWN_ISSUES.md) 标明当前错误复现及已修状态。错误结果不构成产品要求。
- 已确认的真人营业职责、免零限额、12:00 营业日切换点、营业额与资金归属、平台券门禁和无固定备用金规则见下文；账号映射、退款与冲正授权等仍待确认，见 [OPEN BUSINESS DECISIONS](./OPEN_BUSINESS_DECISIONS.md)。
- 当前单机演示阶段的非目标不限制将来的脱岗 MVP 范围；本候选的实现和测试状态以 [CURRENT_STAGE](./CURRENT_STAGE.md) 为准。

## 已确认：项目目标与范围

- 正式数据库方向为 MySQL 8.4 LTS + InnoDB。P0-1 当前采用版本化 JSON 快照过渡账本；最终领域关系模型和正式原始数据导入另行设计。
- 项目是金碧辉煌 KTV 的手机优先门店操作演示，供店员练习并让管理人员核对业务流程。
- 覆盖房间、消费、收款、预订、存取酒、库存、支出／采购、客诉、审批、交班和营业报表。
- 员工入口与系统管理后台入口独立，但当前演示在同一浏览器来源下共享本机状态。
- 当前演示使用手工确认收款、模拟身份和页面提醒；不得宣称真实支付、真实认证或正式营业能力。

## 已确认：身份、入口与权限

| 身份 | 岗位说明 |
|---|---|
| 管理员 | 后台总管理 |
| 卓老板 | 老板 |
| 老板娘 | 店长 |
| 邵老板 | 大堂经理 |
| 雄老板 | 外联经理 |
| 卓益 | 订房服务专员 |
| 美娇 | 订房专员 |

- 岗位名称只作说明；开房、收款、库存、审核等能力以具体权限为准。
- 真人营业职责已确认：卓老板、老板娘、邵叔、雄老板均可完成收款、独立零售、房单结账和交班等完整营业流程；卓益目前可加购，但最终结账须交由上述有权人员。此处不把真人称呼自动映射为任何历史演示账号 ID，正式账号映射仍待核实。
- 员工系统入口为 `/`，供所有员工以及老板、店长、大堂经理等有管理职责的人员处理日常营业工作。
- 员工系统提供“待办 / 审核中心”，只汇总当前身份的本人待办、按具体业务审核权限可处理的事项，以及本人已处理的对应审核记录；主动发起型业务仍保留在房间、库存、采购、客诉、交班或“我的”等所属模块。
- 系统管理后台入口为 `/admin`，只由 `backend.view` 控制进入；该权限不授予任何业务审核能力，具体审核权限也不要求同时拥有 `backend.view`。
- 管理员权限固定，并可按单个身份卡片调整其他演示身份的具体权限。
- 当前系统后台只提供已经实现的员工身份与具体权限管理，以及本阶段明确加入的商品、套餐和当前价格维护；不因本轮扩展会员、营销、跨店、企业微信或独立审计等能力。
- 商品、套餐和当前价格维护统一使用最小 `catalog.manage` 权限；该权限与日常营业审核权限解耦。
- 员工系统可按单个员工补录订房和房间商品增购，同时保存业务归属员工与实际登记人。独立零售由 `retail.sale` 控制；商品销售归属优先读取销售行的 `employeeId`／`person`，`recordedBy` 表示实际登记人。
- 挂账回款、特殊差额、超额赠酒水、房间恢复、库存盘点和客诉／异常恢复需要对应审核权限。审核本人提交的申请时，还必须有自审附加授权（当前演示以 `review.self` 表达），并记录是否经授权自审；超额免零还须遵守下文的真人限制，不能仅凭通用 `review.self` 扩大自批范围。
- 挂账审批和大额报销审批同样属于员工系统中的日常营业审核，继续使用各自既有具体权限和事务规则。
- 故障／维护标记提交照片或文字后立即生效，无需另一人审核；恢复空房才进入审核。
- 正式 approveRoomIssue／rejectRoomIssue 只从已锁账本中的对应恢复申请读取 submittedByPrincipalId，具体权限为 room.issue.approve；本人审核还必须有 review.self。payload 的申请人、selfReview 或 approver 不提供授权。缺少可信申请人 principal 的旧申请不根据姓名、演示 ID 或员工关联推断，批准／驳回均停写拒绝且不占操作键。决定保存 decidedByPrincipalId 与冻结 dbNow；decidedBy 仅为可信显示快照，无可信显示名时为 null。原房态、证据、批准及驳回规则保持。

## 已确认：正式 policy attributes 基础

- auth_accounts.policy_attributes_configured 默认 false；认证上下文用 false／null 表示未配置，true／[] 表示已配置空集合。不得按姓名、岗位、payload 或演示身份推断配置。
- 独立 InnoDB auth_policy_attributes 保存稳定 principal 的具体授权属性；当前具体属性为 rounding.self.excess、expense.approval.boss、credit.approval.manager 和 credit.approval.boss；属性不能替代普通 approve permission 或 review.self，也不开放尚未迁移的业务 action。
- configure／grant／revoke 是可信内部管理能力，实际操作者与目标 principal 分开传递、校验和审计；变更先按稳定 UUID 顺序锁 account，同一事务写属性／配置标志与事件。重复配置不清空已有集合，重复 grant／不存在的 revoke 不增加事件；grant／revoke 要求先显式 configure。
- transaction-bound revalidation 在调用方连接内锁住账号／session 后，对 grants 和属性作当前读取；属性变更下一次认证即生效，不更新 session 活动或把权限固化到 token。停用账号继续拒绝认证。没有真人属性配置，内部管理接口不得直接暴露给客户端。

## 已确认：正式员工名册基础

- 员工以服务端生成、稳定且不可复用的 UUID employee_id 标识；display_name 可同名，不作为身份键。员工可无登录账号，enabled 与账号启用状态独立。
- 可选 principal_id 唯一关联 auth_accounts；只能显式关联／解除，不按姓名或旧 USERS 自动推断，改关联对象前先解除原关联。
- 名册变更与审计同事务；记录 employee、实际审计操作者及关联前后 principal，使用数据库 UTC 时间，不复制密码、token、权限或业务 payload。
- actualActorPrincipalId 与 creditedEmployeeId／客诉负责人身份独立。保留历史姓名与旧演示 ID，不因名册建立、改关联或停用改写历史。
- 新业务归属只接受显式 creditedEmployeeId，在调用方现有事务内确认员工存在且 enabled；无账号员工可用，同名员工按 UUID 区分。返回 employeeId／displayName 可信快照，显示名不是身份键，不按 principal、姓名或旧 USERS 猜测归属。解析不负责事务生命周期；当前仅 reserve／sale／retailSale 消费它，其他员工归属业务尚未迁移。
- 名册管理仍是独立内部接口，不创建真人账号／员工、不导入旧名单、不接 HTTP 或 UI；真实人员配置仍属待决定项。

- 正式 reserve 使用显式 creditedEmployeeId；原 data.employee 字段只允许作为稳定 employee UUID 的兼容别名，二者同时提供必须一致。保留原选择归属员工时的 staff.record 代录权限；不得借员工或其关联账号获得授权。新预约保存 actualActorPrincipalId、creditedEmployeeId 和 creditedEmployeeNameSnapshot，person／employeeId／recordedBy 分别保留相应快照／稳定 ID／实际 principal，不猜本人归属。预约场次与房态校验不变，以冻结 dbNow 为时间来源，不新增营业日规则。
- 正式 sale／retailSale 同样必须显式选择员工 UUID，并保存 actualActorPrincipalId、creditedEmployeeId、creditedEmployeeNameSnapshot；销售归属和实际登记 principal 独立，旧姓名快照不改写。保留原代录权限：sale 使用 staff.record，retailSale 同时需要 retail.sale 与 staff.record；员工和其关联账号不授予 actor 权限。trusted 的销售／库存流水／零售付款时间只用冻结 dbNow；原房间增购、无房全额零售、多笔付款及基础单位库存规则不变。

## 已确认：房间、时段与房态

- 固定 9 间房：V01/V02/V03 为小房，V05/V06 为中房，333/666/999 为大房，888 为 VIP 房；没有 V04，不规范化房号。
- 白天场 14:00–18:00，纯唱价格为小／中房 68 元、大房 88 元、VIP 108 元。
- 夜间计价时段为 18:00–次日 02:00，现有套餐基础房费与赠饮分账，不能重复收费。
- 02:00 后已有营业单仍可继续消费与结账；新单不能在关闭时段开房。
- 房间支持空闲、营业中、待清洁、已预订和故障／维护中等展示；故障、维护或待恢复审核的房间不能开房或预订。
- 营业房卡可分别确认小吃、果盘已上；全部确认后对应按钮消失。

## 已确认：开房、酒水与其他消费

- 开房渠道默认为线下。美团／抖音等平台券须先核销成功，才能按平台券方案开房并记录券覆盖额；后续增购照常计价。核销失败时通常请顾客重新购买可用券，少数情况改为扫描店内收款码走线下支付；失败券不得记为已支付或已覆盖房费。当前演示的“零元开房、待验券”行为不符合这一正式目标。
- 普通赠饮为 12 支／打，高端赠饮为 10 支／打；销售整打统一 12 支，半打 6 支且价格为整打一半。
- 开房不提供手工半打赠饮入口；开房可选饮料、红青岛、蓝妹（罐装）和黑金百威。
- 选择“饮料”作为开房赠饮时，必须在开房表单内配完实际酒水种类与总支数，并按实际商品记账。
- 现有啤酒、饮料、汽水和瓶装水沿用原有规格与报价；饮料和汽水只按单支销售，瓶装水为 2 元／支。新增可售商品按目录分类进入同一个房间增购入口。
- 一张加单可以登记多种酒水。“加其他”支持小吃、热食、烧鸡烤肉、代驾和其他；代驾填写金额，其他填写项目与金额。
- 正式 serveExtra／otherCharge 的实际操作者、具体权限与时间只取 session 重验后的 trusted context，分别沿用 order.serveExtra／order.sale；两动作没有员工归属，不借员工或请求身份获得授权。serveExtra 保持标记配品已上，不再次扣库存或重算套餐；otherCharge 保持原金额、类别和营业中账单校验。新记录保存稳定 principal 字段及当时数据库时间，历史记录、商品快照、付款和房态不改写；授权拒绝不占操作键，有效原 actor 撤权后仍可取回旧终态。
- 套餐、付费增购和已赠酒水均可按支 1:1 换酒，只允许同级或向下、可部分换，原收费金额不变；瓶装水不可换出。
- 正式 exchange 只从 session 重验后的 trusted context 取得 order.exchange 权限、实际操作者及冻结 dbNow；两笔库存流水和换酒记录均使用该来源。原动作没有员工归属，不重选或改写历史归属员工，不借员工身份授权。原商品、数量、库存、目标行快照及成交金额规则保持，两步库存与订单变更必须整体原子提交，失败无半笔；授权拒绝不占操作键，撤权后的有效原 actor 仍能取回旧终态。
- 同一种可按打销售的酒水每增购 24 支，可直接赠对应酒水半打；超出额度进入赠酒审核。赠送不增加应收，待审核申请会阻止结账或挂账。
- 正式 trusted gift 只从 session context 取得 order.gift、actual actor 和冻结 dbNow；新超额 giftRequest 保存 submittedByPrincipalId，requestedBy 仅为可信显示快照（当前 null），requestedById 留空，不借演示 ID 或 payload 推断申请人。原赠酒没有员工归属输入，不重选或改写订单的 credited employee；显式 creditedEmployeeId 保持 Stage 2A 的非代录拒绝规则。额度内赠送／超额待确认、商品／数量、库存 counted 与 null／0、规格／参考值快照以及不增加应收的语义保持。权限不足不占操作键，撤权后的有效原 actor 可重放既有终态；赠酒审批的稳定身份边界见下一条。
- 正式 approveGift／rejectGift 只按锁定 ledger state 的 giftRequest.submittedByPrincipalId 判断申请人；两动作均需 gift.approve，本人还需 review.self。payload 中的 applicant／submittedByPrincipalId／selfReview／approver、旧姓名／演示 ID／员工关联不能作为授权事实；legacy 缺少可信稳定 principal 时两动作都拒绝、不占操作键。决定保存 decidedByPrincipalId，decidedBy 仅为可信显示快照（当前 null），decidedAt 只用冻结 dbNow；原批准／驳回、库存、数量、商品与历史快照语义保持。有效原 actor 撤权后仍可重放旧终态，新 key 使用当前权限；SQL 故障整体回滚。不增加岗位或 policy attribute 限制。

## 已确认：商品、套餐与价格模型

- 运行时商品目录只有一个事实来源：`state.catalog`。报价、开房赠饮、增购、库存、换酒、存酒、赠酒、报表和系统后台维护都必须读取它；不得长期同时维护静态 `PRODUCTS` 与状态目录。
- 可以保留类似 `DEFAULT_CATALOG` 的默认目录，但它只用于首次初始化、旧状态迁移和恢复 DEMO 数据。当前演示仍使用 `localStorage`，MySQL 过渡账本尚未接入页面；模型应方便未来把稳定商品 ID 映射到服务端商品编码。
- 商品使用稳定 `id`（当前已有 `bw`、`qd` 等），本阶段不增加与 `id` 重复的 `sku` 字段。商品至少包含：名称、分类、`baseUnit`、`saleOptions`、`inventoryManaged`、`sellable`、`manualPriceAllowed`、`exchangeLevel`、`openingGiftEligible`、`active` 和 `sortOrder`。
- `baseUnit` 是库存基础单位；`saleOptions` 表达销售规格，每个规格至少保存稳定规格 ID、名称、每个销售单位对应的基础数量和当前价格分。库存始终按基础单位计量，例如整打销售的 `baseQuantity` 为 12，库存扣减 12 支，不通过价格、等级或固定数字在业务逻辑中推导。
- 套餐有稳定 ID、名称、房型／时段、当前套餐售价、基础房费、赠饮参考值、固定配品和启停状态；套餐定义还必须表达赠饮数量及允许选择的商品范围。套餐本身不保存 `affectsInventory`，也不直接保存库存。
- 套餐定义与客人最终选择分开。开房时必须把实际选择保存为订单的 `resolvedComponents`，至少包括 `productId`、商品名称快照、基础数量和基础单位快照；库存只对最终组成中 `inventoryManaged === true` 的商品按基础数量扣减。以后修改套餐允许选择范围不得重新解析历史订单。
- 房费仍属于房型／时段报价规则，代驾和其他临时费用仍是订单独立收费项目；统一商品目录不要求把房费或自由收费伪装成库存商品。套餐配品可以作为不可直接销售的组合组成记录，但不因此获得商品售价。
- 付费销售订单行必须同时保存商品 ID、商品名称／分类／基础单位快照、销售规格 ID 和名称快照、`saleQuantity`、`baseQuantityPerSaleUnit`、`totalBaseQuantity`、`pricePerSaleUnitCents` 和 `amountCents`。这里的价格是一个销售规格的成交价，不表示一个库存基础单位的价格。
- 套餐开房订单保存套餐 ID、名称、套餐价格、基础房费、套餐赠饮参考值和 `resolvedComponents`；历史订单和历史报表不得只通过商品 ID 或套餐 ID 读取当前目录价格。
- 赠酒收费金额为 0，但必须保存赠送时对应销售规格的 `referenceValueCents` 及规格、数量和基础数量快照。历史报表只读该快照，不能用当前商品价重新计算过去的赠酒参考价值。
- 旧数据迁移不得使用迁移当天的当前售价伪造历史价格。旧记录已有成交金额时保留原金额；缺失且无法可靠恢复的商品名称、单价或赠酒参考值标记为 `legacy`／未知。迁移后修改当前目录价格不得改变旧订单金额或旧报表。

## 已确认：普通商品与独立零售

- 香烟、小吃、面包等均为普通目录商品，不建立分类专用的订单、库存或报表业务分支。后台可新增稳定 ID、名称、分类、基础单位、是否库存管理、是否可销售、销售规格、当前价格、启停和排序；商品 ID 创建后保持不变，商品内销售规格 ID 唯一，基础数量为正整数，价格合法。未确认的真实商品价格不得由实现者补造。
- `orders` 使用统一 `kind: 'room' | 'retail'`。房间消费保留房号及原结算流程；独立零售的 `room` 为 `null`，不要求开房，成交时立即全额付款并完成订单。沿用现有付款方式和金额校验，不引入找零、挂账、储值或新的支付规则。
- 房间增购和独立零售共用商品有效性、销售规格、数量、成交价快照、人员归属、基础单位扣库和库存流水关联规则。每条销售行保存 `employeeId`／`person` 与 `recordedBy`，库存流水关联 `orderId` 和 `saleLineId`，基础数量变化写明确负数。
- 新增 `inventoryManaged` 商品时只创建目录记录及“未建账”库存状态，不自动初始化为库存 0。销售前须经现有期初建账审核录入真实数量；未建账、库存不足、不可销售、无效价格、无权限或付款不合法时，整笔独立零售不产生订单、销售行、付款或库存流水。
- 当前演示只用 `createdAt`、`paidAt`、`closedAt` 等订单时间，日报／周报／月报沿用现有日期口径；下述正式营业日规则尚未在运行代码中实现，班次模型仍待设计。

## 已确认：收钱、结账、挂账与交班

- “收钱”只收最近一笔未收增购；没有增购待收时收开房费用。收钱后房间继续营业。
- “结账”汇总剩余未收费用，完成后房间才转待清洁。
- 收钱和结账均支持微信、支付宝、现金、美团、抖音多笔付款，合计必须匹配。
- 正式 trusted collect／pay 分别只检查 payment.collect／payment.settle；实际操作者、权限和付款时间只取同事务 session context。collect／pay／settle 的新 payment 生成安全随机 UUID paymentId，保存 occurredAt=dbNow、recordedByPrincipalId；person/time 只作可信兼容快照，不复制客户端身份或 ID。旧付款不回填，不按姓名推断。collect 收足当前 charge 后继续营业，pay 无免零且收足全部余款后转待清洁；原金额、渠道、charge 顺序和赠酒待确认阻断不变。付款、订单／房态、revision、operation、audit 同一原子提交；拒绝授权不占 key，重试原 key 只返回原终态。可信付款的独立资金口径与营业日冻结见下文 K05 契约。
- 正式 trusted settle 保持 payment.settle 及现有金额／说明校验，结清时机遵循本条修复后的免零生效规则。需审核的 roundingReview 保存 session 的 submittedByPrincipalId 和冻结 DB submittedAt；approveRounding／rejectRounding 从锁定 review 读取此 principal，均要求 rounding.approve，本人另需 review.self。只有实际免零 >1000 分的本人批准再要求已配置的 DB rounding.self.excess；本人驳回和 ≤1000 分特殊情况本人批准不要求该属性。payload 身份／角色／属性无效；legacy 无可信申请 principal 或免零事实无法安全解释时两决定均授权拒绝且不占 key。决定保存 decidedByPrincipalId／DB decidedAt，姓名仅显示。K01／K06 本批修复：需审核时仅提交真实 payment 和 pending review，订单保持营业、房间保持占用；批准使免零生效，重新核对余额为零时才与决定一同关单及转待清洁。驳回不生效，已收 payment 保留，不退款、不自动补款或再结算。
- 正式免零差额不超过 10 元时，现场可直接免零，主要用于凑整 5 元或整 10 元（例如应付 168 元下调至 160 元）；免零不得超过实际未收金额或造成负数应付；超过 10 元须进入审批，未经批准不得当作已收或完成合法结账。卓老板可以批准本人超额免零；老板娘、邵叔、雄老板不能自批，须由其他有权人员批准。卓益没有最终结账权限，不能借免零审批绕过该限制。普通 ≤10 元直接免零与真实付款、关单和房态在同一事务生效；显式特殊情况仍需说明并审核。
- `outstanding = max(0, total − 原有有效 payments 合计 − 已生效免零)`。当前 `rounding` 与可选 `roundingHistory` 只计入明确无 review 的普通 ≤1000 分直免，以及金额一致且状态明确为已批准的 review；pending、rejected、状态或金额不明的 legacy 记录均不抵扣。后续合法 pay／settle 替换当前免零字段前保留原事实快照，不回填未知状态。免零不生成 payment、不计资金流水；不把免零计入资金流水；双口径报表见下文。
- 所有演示身份均可从结账申请挂账。手机号或顾客姓名至少填写一个，挂账备注和经办签名必填；只挂尚未收取的余额。
- 挂账金额不超过 1000 元由店长审批，超过 1000 元由老板审批；提单起 24 小时到期，挂账不计入实收。
- 正式 trusted `credit` 申请创建只使用 session context 的 `credit.apply`、principal 和冻结 `dbNow`。新 `order.credit` 保存 `submittedByPrincipalId`，`submittedById` 不填演示 ID，`person` 仅作可信显示快照；payload 身份／权限／时钟不得覆盖。顾客姓名、手机号和签名仍是业务输入；金额只取原未收余额，期限仍为提单后 24 小时，原待审批和房态释放语义保持。原 approver 岗位标签仅保留既有业务路由，创建链不判断 manager／boss 属性；决定链见下一条，回款申请见下文。授权拒绝不占操作键，既有终态重放及完整 rollback 保持。
- 正式 credit 的 approve／reject 均从锁内 order.credit 读取 submittedByPrincipalId；必须有 credit.approve，本人额外需要 review.self。两动作保留相同金额分级：≤1000 元需要已配置的 credit.approval.manager 或 credit.approval.boss，>1000 元仅 credit.approval.boss；boss 覆盖 manager 资格。approver 是申请时保存的审批级别，不是审核人身份；不依据角色、姓名、payload 或当前未收余额补造级别。未知／矛盾的保存金额与级别、legacy 缺可信申请人均 fail closed，不占操作键。决定保存 decidedByPrincipalId，decisionBy 仅显示快照（当前 null），decisionAt 使用冻结 dbNow；原批准转已挂账、驳回归档并清除当前 credit／转营业中且不重新占房等语义不变。撤销 permission／属性后有效原 actor 的旧 key 仍取原终态，新 key 验当前资格；SQL 故障完整 rollback。
- 回款先登记金额和方式，审核通过后才扣减欠款并计入实收；存酒不能抵欠款。
- 正式 trusted repay 只使用 session context 的 credit.repay、principal 和冻结 dbNow；新 repaymentRequests 保存 submittedByPrincipalId，submittedById 不填演示 ID，submittedBy 只作可信显示快照，submittedAt 只用 dbNow。姓名、角色、payload 身份／权限／时钟不能覆盖。保留原已挂账订单、正整数分金额、付款方式及扣除待审申请后余额的校验；仅创建待审核申请，不扣挂账余额、不生成 payment／已确认回款，不改变订单状态、房态、库存或历史快照。授权拒绝不占键，既有终态 replay／冲突与完整 rollback 保持；回款审核见下一条；跨日资金筛选见下文，不把申请本身计入资金。
- 正式 approveRepayment／rejectRepayment 只从锁内本次 repaymentRequest.submittedByPrincipalId 判断本人，不能用原 credit 经办人；需 credit.repay.approve，本人另需 review.self。legacy 申请无有效 principal 两动作都 fail closed，不猜姓名／旧 ID。决定保存 decidedByPrincipalId；批准 payment／回款记录保存 approvedByPrincipalId，原姓名字段只作显示快照，时间只用冻结 dbNow，payload 身份／权限／时间不能覆盖。批准的申请决定、一笔 payment、挂账余额、相关历史与 ledger revision／result／audit 同事务提交，任一步失败全回滚；同 key 重放和双连接竞争不得重复资金效果。驳回不生成 payment、不减余额，原金额／状态／原因规则不变。授权拒绝不占 key；有效原 actor 撤权后旧 key 返回原终态，新 key 验当前资格。新 trusted 批准付款复用安全 UUID paymentId、occurredAt=dbNow、recordedByPrincipalId，同时保留 approvedByPrincipalId；原 time 仅兼容显示，资金只从 order.payments 计一次。
- Demo 交班保留实点收款合计与前台现金的旧界面；正式 trusted handover 只输入 actualCash（整数分、非负），使用当前 handover 权限及同事务 session principal／冻结 dbNow，不接受 payload 的 expected／previous／身份或时间。
- 正式交班采用连续现金抽屉链：第一次 bootstrap 保存实际清点，expectedCash=actualCash、difference=0；后续 expectedCash=上次 actualCash+本区间现金增加−本区间已证明的现金减少，difference=actualCash−expectedCash。差额后的下一轮仍以上次 actualCash 为基线，不绑定 12:00 营业日，不预设备用金。
- 当前明确现金增加只来自 canonical order.payments 中新出现的可信 paymentId／occurredAt／recordedByPrincipalId 且 method=现金；非现金只作区间渠道统计，credit.repayments 镜像不再计。deposit／withdraw 是存取酒；expense／procurement 没有抽屉资金来源事实，即使 method=现金也不能推断为抽屉支出，当前没有可认定的现金出流。真实抽屉支出的来源与登记规则仍为 OPEN，不宣称已覆盖该场景。
- 每次交班保存 handoverId／occurredAt／submittedByPrincipalId、actualCash／expectedCash／difference、previousHandoverId、bootstrap、版本化累计 payment ID 边界（含不可变事实签名）。首次基线吸收旧付款但不推算过去金额；旧 demo handover 永不成为可信前序。后续新增不明付款或边界事实被删改时停止计算，不猜时间、来源或退款。付款 ID 集合差保证同时间戳与跨 12:00 的每笔付款只计一次。
- 交班、稳定边界、revision、operation、success audit 一同提交；失败不前移边界，重放不消费第二次区间，两个旧 revision 命令最多一个成功。有效原 actor 撤权后可取旧终态，新 key 必须验当前 handover 权限；授权拒绝不占 key。
- 当前门店没有固定现金备用金制度；交班与现金应有数只能使用实际清点和已记录的期初现金，不预设固定开班金额。
- 已回款挂账以简洁折叠卡片显示，点击后再查看经办、开单、预订和备注详情。

## 已确认：预订、存取酒与个人归属

- 预订支持今天、明天、后天和第 N 天后；场次为下午 14:00–18:00、夜间 20:00–次日 02:00。
- 预订方式为线下、手机、座机、美团、抖音。
- 未来预订不占当前房态；营业中房间也能登记多个不冲突的未来场次。到店开房只接管当前匹配场次。
- 场次开始后仍未开房时，每小时在页面提醒登记该预订的员工。
- 有未来预订的空房卡显示“已预订”并进入对应筛选，但仍可处理当前场次；提示只显示日期和场次。
- 存酒联系人手机号或姓名至少填写一个；一次可登记多种酒。搜索支持手机号任意部分或姓名，取酒使用手机号最后 4–11 位或完整姓名核对。
- 存酒独立于欠款，不抵欠款，也不重复扣减商品销售库存。
- “我的”按当前身份显示本人预订、关联开房数和关联订单的酒水增购金额；没有确认提成比例时不推算应发金额。

## 已确认：库存、支出、采购与客诉

- 已有开房赠饮在未建账时可沿用旧流程记录未计账流水；付费商品销售必须先建账并通过库存校验。从明确的期初盘点开始管理，不追扣历史赠饮流水。
- 可售商品库存保存在 `state.inventory`，按各商品 `baseUnit` 管理；内部瓜子、冰块、纸巾、吸管等仍在 `state.consumables`，可另记已开封数量，本轮不迁移。瓜子等套餐配品没有已确认价格时不作为单独销售商品。
- 期初建账和每次盘点都先形成申请，审核通过后才改变账面数量；库管不能绕过审核直接改变库存。
- 正式 trusted `stock`／`consumableStock` 从锁定账本的 `count === null` 选择 `inventory.opening`，其他余额（包括 `0`）选择 `inventory.adjust`；仅使用 session context 的权限、principal 与冻结数据库时间。新申请保存 `submittedByPrincipalId`，姓名只作可信显示快照，不从 payload 或演示身份推断。原数量、基础单位及待审核语义保持。
- 正式 trusted `approveInventory`／`rejectInventory` 只从锁定账本中的申请读取 `submittedByPrincipalId`。非本人需 `inventory.approve`，本人另需 `review.self`；缺少可信申请人时两动作均授权拒绝、不占 operationKey，不从姓名、旧演示 ID、员工关联或 payload 推断。两动作保存 `decidedByPrincipalId`，姓名仅作显示快照；批准流水及通知附稳定申请人／审核人 principal。原批准、驳回、null／0、基础单位和数量变化语义不变。
- 所有演示岗位默认可登记支出／报销。低于财务的岗位只能看本人记录；财务、店长、老板、管理员可看全部，具体权限仍可覆盖。
- 报销超过 500 元进入老板审批。支出性质包括一次性支出、固定支出、资金周转；付款方式沿用五种收款方式。
- 正式 trusted `expense` 申请创建只使用 session context 的 `expense.create`、principal 和冻结数据库时间。新记录保存 `submittedByPrincipalId`，原 `person` 仅作可信显示快照，`submittedById` 不填演示 ID；payload 身份／权限／时钟不得覆盖。原显式支出日期、金额、用途、凭证及超过 500 元报销的待审批状态保持；申请创建不替代下述审核授权。
- 正式 trusted `approveExpense`／`rejectExpense` 从锁定账本的待审 expense 读取 `submittedByPrincipalId` 与保存的金额；非本人必须有 `expense.approve`，本人另需 `review.self`。金额 >500 元时两动作还需已配置的 `expense.approval.boss` 属性；未配置或已配置空集合均拒绝，≤500 元不需此属性。属性只取当前 session context，不从姓名、旧岗位或 payload 推导。缺少可信申请人的历史／采购关联报销均授权拒绝、不占 operationKey。两动作保存 `decidedByPrincipalId`，approver 只作显示快照；保留原待审状态校验、金额、决定及采购状态同步；采购申请接入见下条。撤销权限／属性后有效原 actor 的原请求仍返回已存终态，新 key 用当前授权事实。
- 采购自动关联一笔支出／报销记录，并保留经办归属。
- 正式 trusted `procurement` 只使用 session context 的 `procurement.create`、principal 与冻结 `dbNow`。新采购及关联 expense 同时保存同一 `submittedByPrincipalId`，`person` 仅可信显示快照，关联 expense 的 `submittedById` 留空；不从 payload 或演示身份补造。原显式采购日期、商品／单位／说明截断、整数数量／金额、付款方式和支出性质不变；仍只在报销严格超过 500 元时待老板审批，创建不额外要求 `expense.create` 或老板属性。采购与关联 expense、revision、operation、audit 同一原子提交；不自动入库或生成订单 payment。授权拒绝不占 key，重放不重复两笔记录；故障整体回滚，旧记录不改写。
- 客诉／异常包含日期、房号、类型、描述、负责人、处理结果和备注。未完成及待审核记录从每天 14:00 起在页面提示。
- 正式 trusted incident 只登记客诉／异常：incident.create、submittedByPrincipalId／actualActorPrincipalId 与 createdAt 仅来自有效 session context；负责人显式 assigneeEmployeeId（或 assignee UUID）在同一账本 connection 上通过 employee resolver 验证存在且 enabled。保存稳定 assigneeEmployeeId 和当时 assigneeEmployeeNameSnapshot，原 assignee／person 仅作显示；无账号关联员工仍可负责，同名员工按 UUID 区分，负责人不授予操作者权限。原日期输入、房号、类型、描述截断及待处理状态保持；授权拒绝不占 key，员工拒绝只留明确业务拒绝终态。撤权后有效原 actor 重放旧终态；处理结果及恢复审核见下条。
- 正式 trusted resolveIncident 需 incident.resolve；当前 session principal 通过同事务 principal→employee resolver 的显式启用关联，与锁定 incident.assigneeEmployeeId 相等后才可提交。principal／employee 始终独立，不按姓名、演示岗位、payload、incident.viewAll 或负责人名补授权；不新增管理者绕过。无关联、停用、身份不匹配及缺可信 assigneeEmployeeId 的旧记录均 authorization-denied、不占 key。新 resolutionReviews 保存 submittedByPrincipalId／submittedByEmployeeId，submittedBy 仅当前员工名快照、submittedAt 为冻结 dbNow，submittedById 不填演示 ID。原结果／备注校验、截断、待审核与提醒复位保持；撤权后有效原 actor 读取已存终态不重新检查关联／权限，失效 session 禁止读取。
- 负责人提交处理结果后进入恢复审核，审核通过才转为完成。正式 trusted approveIncidentResolution／rejectIncidentResolution 只从锁定 incident 中选中的本次 resolutionReviews 读取 submittedByPrincipalId；两动作都需既有 incident.resolve.approve，本人另需 review.self，不以 incident 创建人、assignee、姓名、旧演示 ID、employee 关联或 payload 代替本次申请人。缺少可信申请 principal 的 legacy 申请两动作均 authorization-denied、不写终态或占 key。保存 decidedByPrincipalId，decidedBy／reviewedBy 仅可信显示快照、decidedAt／resolvedAt 取冻结 dbNow；批准仍复制本次结果／备注、转已完成并复位提醒，驳回仍要求原因并回流待处理，保留其他历史字段。有效原 actor 撤权后同 key 原请求重放旧终态，新 key 使用当前权限；认证失效不能读取原结果。

## 已确认：报表、主题与数据边界

- 系统营业日切换点正式为每天 12:00，门店通常约凌晨 02:00 结束营业；两者不是同一时间。00:00:00–11:59:59 开立的订单归前一个 `businessDate`，12:00:00 起归当天。营业额按订单开单所属 `businessDate` 归属；每笔付款的资金流水按其真实 `occurredAt` 及相应营业日归属，不能全部从 `order.time` 推导。正式实现须保存原始时间和采用的规则版本，回款与将来退款的资金事件同样按各自实际发生时间归属。`shared/business-day.js:businessDateFor` 已提供版本化 12:00 纯计算规则，必须显式配置门店时区；当前新 trusted retailSale 在创建时冻结 businessDate、businessDayRuleVersion=noon-v1、businessTimeZone；服务端必须显式配置时区，缺失则拒绝新开单且不占操作键。唯一其他新订单入口 open 仍为 demo、未 trusted-enable；共享 orderBusinessDaySnapshot 能力已准备，不据练习时钟补正式日期。已确定的历史日期永不按现行 cutoff 重算。
- 报表按日／周／月切换；房间视图只列统计周期内开过房的房间，并另列独立零售交易。房间与零售商品销售都计入营业账单汇总，按销售行的名称、分类、单位、成交金额和人员快照统计；商品改名、改价后不得改变历史报表，不按 `category === '烟'` 等分类写专门统计分支。
- 房间视图继续列房费、套餐赠饮、商品销售、后续赠送、付款方式、免零和挂账备注；套餐赠饮不填赠送人，后续赠送单列参考值与赠送人。套餐免费果盘、小吃不作为付费商品销售。
- “我的”提供日间、夜间、自动三种主题。自动模式使用设备实际时间 06:00–19:00 为日间，其余为夜间，与手动练习时间无关。
- “切换演示身份”“调整练习时间”和“恢复演示数据”属于 DEMO / training tooling，不是正式生产业务能力；本轮暂留员工系统，正式后端和数据库接入时另行处理。
- 演示业务状态保存在当前浏览器 `localStorage`；不同设备、浏览器、`localhost` 与局域网地址不会自动共享。
- 已保存的演示记录若无法安全加载（含旧套餐价格不一致），必须保留原始主记录并停止保存；可解析的历史订单与付款笔数供只读核对，完整原文可查看复制。人工核对并修正当前套餐配置后才可显式重检恢复；不得借修正当前价格改写历史成交金额或付款。
- 当前唯一 schema authority 为 database/migrations/ 的 versioned MySQL migrations（MySQL 8.4 / InnoDB）。schema.sql/seed.sql/kdocs-import.md 为 LEGACY / NOT USED FOR CURRENT MYSQL，只保留历史参考，不初始化、部署或约束当前 JSON ledger，不维护第二套准生产 PostgreSQL schema；当前静态页面不执行 SQL。

## K05：正式营业额与资金双口径

- reporting.js:selectRevenueOrders 只按订单冻结 businessDate 查询，区间为 [fromBusinessDate,toBusinessDate)；未知／非法历史日期明确报告 ORDER_BUSINESS_DATE_UNKNOWN，不用当前规则或 order.time 补造。
- selectPaymentFlows 遍历所有订单的 canonical payments，按每笔自己的 occurredAt 与显式 offset 的 [from,to) 时间区间筛选，保留数据库微秒精度和原时间戳。只按 payment 统计，绝不叠加 credit.repayments，也不把 rounding 当资金。
- reportViewModel(state,period,query) 的正式 query 必须包含两个独立区间：fromBusinessDate／toBusinessDate 与 paymentInterval={from,to}。营业额 totals 与 cashFlow 各自计算，不读取 state.clock、不先用订单日期筛掉付款。未提供 query 的原演示日／周／月接口保留；遇到冻结日期必须要求显式查询，不能落回设备默认时区。页面与 HTTP 未接入。
- 新 trusted collect／pay／settle／retailSale／approveRepayment 的付款均由既有 appendPaymentRecords 生成 UUID、DB occurredAt 和 recordedByPrincipalId；回款还保留 approvedByPrincipalId，root payments 与回款历史引用同一事实。重放不执行生成器，订单／库存／挂账变化和 operation／audit 同一事务。
- 当前旧 time 字段没有独立可信来源标记，姓名、principal 或订单时间不能单独证明它是数据库资金时间，因此不做 occurredAt ?? time 回退。未知／损坏时间从区间合计排除，并通过 ambiguities、complete=false 暴露；合计只是可证明部分，不可宣称完整资金日结。不回填或猜测历史数据。

## 已确认：当前单机演示非目标（不适用于脱岗 MVP）

- 真实账号认证、多设备同步、服务端事务、真实支付或银行到账验证。
- 美团／抖音真实扫码验券、外部通知、短信或钉钉推送、可靠附件存储和自动备份。
- 退款、冲正、并房、换房、拆账、会员营销、存酒转赠／过期和正式断网队列。
- 内置香烟具体商品及未经确认的真实价格、会员、优惠券、跨店和企业微信。
- 商品删除、供应商 SKU、条形码、品牌、完整分类治理、已存在销售规格的结构编辑、复杂营销规则和正式价格审批流。
- 零售退款、撤单、冲正、找零、零售挂账、完整 POS、班次切换、跨日营业日与营业日关账，以及内部消耗品统一迁移。

## 建议：正式化方向

- 若进入正式营业版本，优先建立服务端认证、MySQL 8.4／InnoDB migration、审计和幂等，再迁移房间、订单、付款与权限。
- 历史报表先进入原始暂存区并完成逐字段校验，再以事务写入正式表；未知支付方式不能猜测。
- 通知、附件、支付和平台验券应作为独立外部集成验收，不能用页面模拟结果替代。

这些建议不是当前演示的完成门槛，是否实施由用户另行决定。

## 待决定

- 真人与历史演示账号 ID 的逐一映射、各班替补和远程审批替补及时限。
- 正式部署环境、账号来源、通知渠道、支付／验券接入方和备份要求。
- 员工订房及酒水提成比例、价格维护流程，以及尚未定价商品的主数据。
- 历史金山营业报表的实际导入时间、源文件版本和验收口径。

## Stage 3A HTTP 可信边界（2026-10-06）

正式浏览器请求通过同源 /api/v1/ HTTP API 进入现有认证和可信账本。登录使用既有账号、scrypt 凭据与 auth_sessions；原始 session token 仅放入 HttpOnly; SameSite=Strict; Path=/ Cookie，生产环境必须设置 Secure。开发环境的非 Secure Cookie 需显式配置。基于 Cookie 的退出和业务写入必须携带从已认证会话获得的 CSRF 证据，并通过同源 Origin 校验。

写入请求只提交 operationKey、expectedRevision 和 payload；URL 中的 action 必须同时存在于命令策略、trusted-enabled 清单及 HTTP 显式清单。客户端身份、权限、策略属性和时间均不是可信输入。HTTP 只映射输入及结果，现有同事务 session 重验、权限、revision、幂等重放、领域事务、审计和 MySQL 提交仍是唯一写入事实。

GET /api/v1/store/snapshot 在同一 MySQL 读事务内重验当前 session 权限与策略属性、读取账本 head 并生成有限字段投影，返回该状态对应的 revision，不下发完整数据库状态、演示身份、权限配置、操作历史或原始账本 JSON。backend.view 不授予业务审核，review.self 独立于具体审核权限。权限授予只接受既有正式 permission ID，未知 ID 不得写入 grants。HTTP 错误按稳定机器码区分认证、授权、CSRF、输入、业务拒绝、revision、幂等冲突及内部错误。

本阶段不迁移员工 UI、不启用真实美团 production、不部署，也不宣称正式生产或 14 天离岗 MVP 已就绪。


## Stage 3B 员工入口正式 HTTP 运行要求（2026-10-06）

员工入口 / 使用同源正式登录、HttpOnly 会话、服务端权限过滤的营业快照和受信命令。房态、订单、库存、收款、审核、员工归属、业务时钟及版本均以服务端为准；浏览器只保留当前已确认快照，不再从演示 localStorage 恢复或写入营业事实。既有 /admin 演示入口与历史演示数据不视为正式账本。

每次新操作产生一个 crypto.randomUUID() 操作键，携带当前服务端快照的 revision。发送 POST 前须先将当前单笔待确认请求的操作键、动作、版本、原 payload、创建时间和非敏感 session principal 绑定信息写入当前标签页的 sessionStorage；写入失败时禁止发送。该记录仅是传输恢复信息，不是业务账本或权限依据，不保存密码、Cookie 原始 session token、CSRF 或完整快照。响应丢失或内部错误无法证明未提交时保留记录；刷新后重新获取正式 session、CSRF 和 snapshot，显示结果待确认，仅允许原操作人员显式用同一操作键、同一版本、同一请求体重试。换账号不得重试旧操作；有待确认记录时退出须先提示。成功、业务拒绝、授权拒绝、版本或幂等冲突等明确终态清除记录；冲突后新操作须人工重新发起并换键。成功后重新读取 session 与 snapshot。401 清除当前可操作视图；断网与状态未确认时停止新写入。前端展示权限只改善使用体验，最终授权仍由服务端执行。顾客、员工归属字段不改变实际 session actor。

本阶段不包括正式账号初始化、真实美团、部署、备份恢复或监控；不得据此称为 production ready。
