# B4-A：认证加密封装（独立组件候选）

## 范围与接口

只新增 backup/encryption.js；不修改 format1、S4 身份门禁、原备份／TEST 恢复、B2 调度、生产配置或 CLI。不接入自动加密、KMS、异地上传、保留删除或生产恢复。Owner 的 Windows 云服务器、RPO≤60分钟／RTO≤240分钟及原服务器全损后在新服务器恢复目标仍需完整后续链路证明。

- encryptArtifact({directory, expectedChecksum, storeId, ledgerId, keyId, keyProvider})：先调用原 verifyArtifact，读取并核对三份原始文件字节快照，返回密文 Buffer；不删除原备份、不自动保存或发布密文。
- withDecryptedArtifact({envelope, expectedKeyId, keyProvider, temporaryParent, expectedChecksum, storeId, ledgerId}, consume)：验证封装、密钥与认证，随后在受控临时目录重建三份原始文件并调用原 verifyArtifact。只有全部成功才向 consume({directory, checksum}) 借出目录；consume 可调用原 TEST restoreDatabase，原确认、目标与恢复门禁不变。目录只在回调期间有效，调用方不得保存路径供稍后使用或自行重命名／复制到不受保护位置。
- temporaryParent 必须已存在、位于 Git 外并由调用方准备好。Windows 要求受保护 DACL，仅当前身份／SYSTEM／Administrators 的可信 Allow 项；组件只在新建的空暂存子目录上复用原生 ACL 保护。POSIX 父目录须属于当前 UID 且无组／其他用户写权限，子目录保持0700。失败即拒绝，不降级绕过 ACL。
- keyProvider.resolve({keyId, algorithm, usage}) 返回 {keyId, key} 或 null。key 必须是32字节 Buffer；usage 为 encrypt 或 decrypt，算法固定 aes-256-gcm。返回 ID 必须匹配请求。keyId 是公开的非敏感标识，支持1–64位 ASCII 字母数字及 ._-，不得把秘密当 ID。无默认密钥、密码派生、环境变量回退或 Windows DPAPI 绑定。原 provider Buffer 不修改，内部副本尽力清零。
- 明文 manifest 的校验值、storeId、ledgerId 仍由授权调用方独立提供，保持 format1 的原预期身份／校验契约；它们不放入外部明文头。密钥能跨授权环境提供，但正式取回授权、身份与恢复流程尚未实现。

## 封装与认证

布局：8字节 KTVB4AE1；4字节大端头长度；规范化 JSON 头；等长密文；16字节 GCM tag。头只有 envelopeVersion=1、algorithm=aes-256-gcm、keyId、nonce。每次从 node:crypto.randomBytes 生成新的12字节 nonce；magic、头长度及整个规范化头共同作为 AAD。版本、算法、字段集合、编码、长度、重复字段或 ID 不符立即拒绝，绝不尝试明文或其他算法回退。

内部只是三份 format1 文件的定长顺序封装，每份以4字节大端长度开头：manifest.json、data.json、manifest.sha256。原文件字节、内容、schema、快照及校验算法保持不变。上限分别1MiB、128MiB、1KiB；头≤1KiB，总长度有界，不解包任意文件名／路径。当前使用有界内存整包处理，不是大文件流式接口，后续接入须核对并发和峰值内存预算。

使用 Node 原生 AES-256-GCM 和完整128位 tag；update 的暂存明文留在内存，final 认证成功之前不写入磁盘、不调用 consumer。随后再做原 format1 校验，认证不替代校验。参考 [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding)。

缺失／错误标识／无效密钥、错误密钥、篡改、截断、原格式拒绝、consumer 失败及清理失败只返回固定 B4_* 错误码；不附加底层异常、路径、密钥、明文或配置，不写普通日志。清理失败覆盖可能的成功返回，不能声称本次调用干净完成；consumer 已做的恢复不会因此自动回滚，调用方须核对既有恢复状态，不盲目重试。

## 明文生命周期仍未闭环

1. 原 backupDatabase 仍按原顺序写入明文 data.json、manifest.json、manifest.sha256；本组件未接入创建／调度，所以不能称正式备份已经加密。源文件、半写文件、备份校验失败和进程中断残留均保留原风险。
2. 解密只在认证后写私有暂存目录，正常完成或可捕获失败会清理自有目录；强制终止、进程崩溃、断电或清理失败仍可能留下认证后的明文。未实现启动扫描／恢复日志、隔离残留处置或按生产保留规则清理。
3. 后续集成须验收：源暂存及祖先目录权限、磁盘／分页／崩溃转储风险、加密输出完整写入与验证后发布、生产容量与内存、崩溃恢复、残留登记、保留策略及授权处置。不得先删除唯一有效备份，不得把失败产物计为成功；源明文到可靠密文的切换时序尚未实现。
4. 普通删除及内存 Buffer 清零均不保证安全擦除；文件系统、磁盘、缓存、分页和运行时对象仍可能留痕，不作此保证。
5. 正式密钥生成、独立托管、轮换与每密钥使用预算、历史密钥保留、紧急取回、人员授权及新 Windows 服务器恢复演练单独验收。生产云资源／KMS／生产密钥未创建。

## 行为证据与停止点

发起条件：已获授权的 synthetic 原 format1 备份、独立预期校验／门店／账本、正确 keyId 与内存测试密钥；测试资源就绪另需 Git 外受控目录，SQL 用例只准项目自有 disposable MySQL。资源就绪不是成功证据。

成功证据：原字节往返后原 verifyArtifact 通过；篡改／错误密钥时 consumer 未执行且无明文目录；独立进程和独立暂存目录用相同授权密钥可解密；原 TEST 恢复保持 VERIFYING 并逐表还原，源账本不变。无真实第二台服务器、生产恢复或 RPO/RTO 达标证据。任一认证／格式／权限／清理错误即失败，保留密文与原备份，不报告成功或自动重试。

当前实际 focused 结果、TAP 与清理证据统一在 [CURRENT_STAGE](CURRENT_STAGE.md)，命令见 [DEVELOPMENT_ENVIRONMENT](DEVELOPMENT_ENVIRONMENT.md)。作者测试不替代 Owner 独立验收。
