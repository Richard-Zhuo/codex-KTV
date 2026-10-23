# B5-B2B 固定安全根：Windows 11 断网实验室复验

只供 Owner 审核后手工执行。开发机和现有虚拟机副本未被本次修改。
固定根 C:\JbhhKtvSecure\oss-acceptance；没有旧 ProgramData 路径回退。
不放宽 ProgramData 的 WA/WEA 检查，不迁移凭据，不批准 OSS 联网。

## 已取得的基础验收结果（Owner 提供）

WINDOWS 11 BASIC SECURITY ACCEPTANCE = PASS
FULL B5-B2B OSS ACCEPTANCE = NOT COMPLETED
TESTED CODE COMMIT = ecb0382f15effc5507f30636eb4caf9ac2488d8a

Owner 已报告在 Windows 11 断网虚拟机完成以下操作。本轮仅整理文档，未操作虚拟机、
未重复测试，也未进行新增独立实测。此处不虚构证据文件、日志路径或未提供的执行日期。
后续文档提交不能替代上述实际实测代码提交；原冻结 449179e4 不变。

| Owner 报告项目 | 结果 |
| --- | --- |
| 原始离线包完整性 | 2554/2554 PASS |
| 两个补丁文件 Git Blob 来源及 SHA-256 | PASS |
| 新根首次原子创建、所有者、受保护 ACL、固定句柄检查 | PASS |
| 管理员 ROOT-only | ROOT_OK，PASS |
| 缺失配置 | MISSING_CONFIG_REJECTION = PASS |
| JBHH-Lab-User：非管理员、程序可读 | 应用 ROOT 拒绝 PASS |
| 首次本地读取人工确认输入 DENY | OSS_ACCEPTANCE_UNCONFIRMED，exit1，符合预期 |

这些结果仅覆盖安全根初始化、ROOT 检查、缺失配置拒绝、标准用户拒绝与首次人工确认拒绝。
开发环境 154/154 PASS 来自上一轮 Codex 的 Node 24.19.0 定向回归报告，本轮未重跑；
不能把合成 ACL/mock 结果当作 Windows 实机攻击或竞态验收。
真实 OSS 凭据未提供，虚拟机持续断网，没有执行经授权的真实 OSS 验收。
下文保留既有操作说明作追溯，不要求重复初始化或重复已通过测试。

## 第二道 Owner 授权拒绝：新增实机证据与下一步

WINDOWS 11 SECOND AUTHORIZATION DENIAL = PASS
TESTED CODE COMMIT = ecb0382f15effc5507f30636eb4caf9ac2488d8a
FULL B5-B2B OSS ACCEPTANCE = NOT COMPLETED

以下为 Owner 补充的 Windows 11 断网实验室实际执行结果，不是 Codex 独立复验：

- 固定根内纯合成 config.json 的 CONFIG HASH = PASS；SHA-256 为
  7B6D7981F3EBCAFF54C0BBF6EE3CA45DFA1ACC3BDAF74F3039C0652B716CC6AE。
- Run ID：1cdba5bc-86ba-4690-bfce-843698023a5f。
- CREDENTIAL FILES = ABSENT；read.json 和 write.json 均未创建。
- 首次本地读取确认成功，固定合成配置通过当前读取和校验流程，进入第二道 Owner 授权。
- 第二道确认输入 DENY，返回 OSS_ACCEPTANCE_UNCONFIRMED，ENTRY_EXIT_CODE = 1，符合预期。
- 虚拟机保持断网，没有执行获授权的真实 OSS 验收。

未另行提供或虚构截图、日志文件或独立执行记录。此结果不证明第二道授权成功后的路径已实测。
后续 docs-only 提交不属于上述 Windows 11 实测代码版本。

### 针对当前冻结源码的只读核对

仅核对 executeOssAcceptance/openEvidence、readOssAcceptanceFixed/Invoke-OssFixedRead 和直接相关测试：

1. authorizeOssAcceptance 成功返回后，立即再次调用固定 CONFIG 读取并执行 acceptanceConfig；
   二次读取/校验失败直接停止，不能继续创建证据或读取凭据。
2. 每次 CONFIG/ROOT/READ/WRITE 都重新进入原生固定入口。驱动器、父链 Pin、所有者/DACL、
   重解析点/路径一致性检查保持有效；配置内容通过同一已验证 FileStream 句柄读取，先检查文件 ACL。
   这些句柄只覆盖各自子进程操作，不宣称跨两次读取持有同一个文件句柄。
3. 二次配置对九个受控字段逐项严格比较；字段值变化或结构非法，在证据文件和凭据访问前拒绝。
   比较的是合法解析后的字段值，不是配置文件字节摘要；仅空白或字段顺序变化且值相同不视为变化。
   上述 Owner 配置 SHA-256 是本次测试材料标识，不是程序新增的运行时摘要绑定。
4. 配置一致后 openEvidence 先执行 ROOT 检查，再以 wx 排他创建同根
   oss-acceptance-1cdba5bc-86ba-4690-bfce-843698023a5f.jsonl。已有同名文件拒绝，不覆盖、不自动清理。
   先写入并 sync SESSION/AUTHORIZED 与 CREDENTIALS/STARTED，再读取 READ，然后 WRITE。
   授权许可仅保存在当前进程内存；本路径不写备份 operational store，也不执行备份/恢复/删除。
5. 两凭据文件均缺失时，首先 READ 打开失败；WRITE 尚未读取，实际联网桥接构造和 probes 尚未到达。
   正常证据 I/O 下会尝试记录 RESULT/UNCONFIRMED、failedStage=CREDENTIALS 并关闭文件，入口 exit1。
   证据写入/sync/关闭失败仍拒绝，可能留下部分 JSONL；不得把其存在或 SESSION/AUTHORIZED 当成功。
   通用 remoteMayContainObjects=true 是保守错误字段，不能在此路径中当作发生 OSS 请求的证据。
6. 源码顺序允许在严格受控的缺失凭据条件下做离线拒绝验证；缺失 WRITE 的验证另需安全的 synthetic
   READ 材料，不能用“两文件均缺失”声称 WRITE 缺失分支已实测。本轮不创建任何凭据。

### 已有自动化覆盖与实机缺口（本轮只读，未重跑）

backup/oss-acceptance.test.js 的既有用例覆盖：第二道错误确认不读凭据/不开证据/不请求；
成功 mock 会话的 CONFIG、CONFIG、ROOT、READ、WRITE 顺序；确认后配置字段改变时在证据/凭据前拒绝；
固定文件不可重定向；证据已存在、sync 失败、ACL/链接拒绝时不联网；默认禁网、许可单次使用和请求预算。
backup/oss-acceptance-root.test.js 覆盖合成所有者/DACL、重解析点、驱动器与只读受保护句柄。
历史开发回归为 154/154 PASS，来源见当前阶段，不作为本轮新执行或 Windows 11 竞争场景证据。
这两份现有测试未见专门模拟 READ/WRITE 凭据文件缺失的入口用例；不能把相邻失败用例当作该项已测。
第二道成功后的 Windows 原生重读、证据落盘、缺失 READ/WRITE 拒绝及持续 ACL/竞态行为仍需实机证据。

### 下一项最小测试的批准边界（本轮不执行）

建议 Owner 另行批准一次“第二道成功 → 配置重读 → 缺失 READ 拒绝”的断网实机测试。
批准必须明确允许内存许可及上述固定 JSONL 的排他创建、写入和保留，不能称为无本地副作用。
执行前须确认代码与合成配置未变、read.json/write.json 均不存在、预期证据文件不存在、
受保护父链保持有效、没有其他受信管理员并发创建凭据或修改配置/目录。现有同名证据只报告并停止。

预期只到缺失 READ 拒绝：OSS_ACCEPTANCE_UNCONFIRMED、exit1，允许保留不完整/拒绝证据；
不得出现探针阶段或 PROBES_PASSED。若任何凭据文件意外存在、配置摘要不符、范围不符或提前异常，
立即停止，不为推进测试补建凭据、不重试授权、不清理证据。本轮不提供或输入完整成功授权短语。

离线保证基于受控缺失 READ 在实际网络桥接/探针前使控制流停止；虚拟机仍需保持断网。
这不是操作系统级零 DNS/socket 尝试证明。若不能确保凭据持续缺失及受信账户条件，则不批准此入口测试。
后续配置变化、WRITE 缺失、凭据完整生命周期和竞争场景另行限定范围，不在本轮执行。

## 安全前提

- 干净的 Windows PowerShell 5.1 提升管理员、已核验代码和 Node 24.19.0。
  SYSTEM、Administrators、运行账户及其进程持续可信；ACL 不防御恶意管理员、内核、
  驱动器命名空间或具有备份/还原等特权的攻击者。虚拟机网络保持未连接。
- C: 是原生本地固定 NTFS 卷，原有根所有者、DACL、句柄与重解析检查必须通过。
  普通用户可以创建无关子目录，但不得具有根的 DELETE_CHILD、写属性/EA、写 DACL/所有者等权限。
- 新的两层目录必须从不存在状态开始。排他创建中同时指定受保护 DACL，不是先创建再改 ACL。
  已有目录、文件、junction、抢先创建或部分初始化均 STOP；不能自动接管、删除、修复或重试。
  从首次创建即排除非受信主体，才能排除它预先取得目标写入句柄的风险。
- 父链逐级固定句柄、检查后才能访问下一层，全部句柄保留到结束。
  私有目录仍只信任 SYSTEM/Administrators/受信提升运行账户，未知所有者/Allow ACE 拒绝。
  TrustedInstaller 仍只作为原获准系统祖先的所有者例外，不成为私有目录或 DACL 信任主体。

创建瞬间安全描述符及 ERROR_ALREADY_EXISTS 依据：
[Microsoft CreateDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createdirectoryw)。
安全证明来自严格父链及首次受保护创建，不假设句柄能阻断全部属性/EA 修改。

## 最小差异交付

不重建依赖包。Owner 将已有已校验实验室程序复制到全新复验目录，保留原副本。
只以同一候选提交中的 backup/oss-acceptance-root.ps1 和 backup/oss-acceptance-path.js
替换新副本中的两个文件。记录提交、git diff --name-only 和 Get-FileHash -Algorithm SHA256；
虚拟机逐文件比对，不匹配即停止。449179e4 原清单不能充当这两个新补丁文件的摘要。
目录没有文件 SHA-256；分别记录文件摘要及每层目录的所有者、DACL、重解析属性。
下文工作目录为新复验副本的 app，且两文件已完成来源及摘要核对。

## Owner 手工首次初始化（仅实验室管理员）

此步骤未被 Codex 执行。只创建两个新目录，不修改 C:\ 或 ProgramData，不创建任何配置/凭据。
Add-Type 可能使用管理员临时编译目录。定义以已核验源码在当前会话加载，不修改系统执行策略。
失败保留现场，不自动清理、接管或重跑。
部分创建或路径抢占需 Owner 独立处置，优先返回干净实验室检查点重新准备。

~~~powershell
$ErrorActionPreference='Stop'
# 先手工 Set-Location 到新副本 app，核对补丁 SHA-256。
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$definition=[IO.File]::ReadAllText((Join-Path (Get-Location) 'backup\oss-acceptance-root.ps1'))
. ([scriptblock]::Create($definition))
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if(!([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'ELEVATION_REQUIRED'}
$script:Operator=$identity.User.Value
$script:Pins=[Collections.Generic.List[IDisposable]]::new()
Initialize-Native
Add-Type -TypeDefinition (@(
 'using System; using System.Runtime.InteropServices;'
 'public static class JbhhLabCreateOnly {'
 ' [StructLayout(LayoutKind.Sequential)] public struct SA { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }'
 ' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]'
 ' [return: MarshalAs(UnmanagedType.Bool)] public static extern bool CreateDirectoryW(string path, ref SA security);'
 '}'
) -join [Environment]::NewLine)
$descriptor=[IntPtr]::Zero
try {
 if($script:Native.GetMethod('GetDriveTypeW').Invoke($null,@('C:\')) -ne 3){throw 'LOCAL_FIXED_DRIVE_REQUIRED'}
 $device=[Text.StringBuilder]::new(8192)
 if($script:Native.GetMethod('QueryDosDeviceW').Invoke($null,@('C:',$device,[uint32]8192)) -eq 0){throw 'DRIVE_QUERY_FAILED'}
 Check-Drive 3 ($device.ToString().Split([char]0)[0])
 $root=Pin 'C:\' $true
 Check-Acl (Read-PinnedDirectoryAcl $root) $false 'C:\'
 if(([IO.DriveInfo]::new('C:\')).DriveFormat -cne 'NTFS'){throw 'NTFS_REQUIRED'}
 $sd=[Security.AccessControl.DirectorySecurity]::new()
 $sd.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
 $bytes=$sd.GetSecurityDescriptorBinaryForm()
 $descriptor=[Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
 [Runtime.InteropServices.Marshal]::Copy($bytes,0,$descriptor,$bytes.Length)
 $sa=New-Object JbhhLabCreateOnly+SA
 $sa.length=[Runtime.InteropServices.Marshal]::SizeOf($sa)
 $sa.descriptor=$descriptor;$sa.inherit=$false
 foreach($path in @('C:\JbhhKtvSecure','C:\JbhhKtvSecure\oss-acceptance')) {
  if(![JbhhLabCreateOnly]::CreateDirectoryW($path,[ref]$sa)) {
   $errorCode=[Runtime.InteropServices.Marshal]::GetLastWin32Error()
   throw ('CREATE_ONLY_STOP_'+$errorCode)
  }
  $h=Pin $path $true
  $acl=Read-PinnedDirectoryAcl $h
  Check-Acl $acl $true $path
  $rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
  if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne 'S-1-5-32-544' -or !$acl.AreAccessRulesProtected -or $rules.Count -ne 2){throw 'CREATED_DESCRIPTOR_MISMATCH'}
  foreach($r in $rules) {
   if($r.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544') -or $r.IsInherited -or
      $r.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $r.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      $r.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or
      $r.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None){throw 'CREATED_DESCRIPTOR_MISMATCH'}
  }
 }
 [Console]::WriteLine('LAB_DIRECTORIES_CREATED_AND_PIN_CHECKED')
} finally {
 for($i=$script:Pins.Count-1;$i -ge 0;$i--){$script:Pins[$i].Dispose()}
 if($descriptor -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::FreeHGlobal($descriptor)}
}
~~~

预期：两目录无重解析点，所有者 BUILTIN\Administrators，DACL=P、继承关闭，
只有 SYSTEM:(OI)(CI)(F) 和 Administrators:(OI)(CI)(F)，无其他 ACE。
Owner 已报告首次创建与 ROOT 检查通过；该结论不扩展到尚未实测的配置/凭据或竞争场景。
将来 config.json/read.json/write.json 也须受保护文件 DACL、可信所有者；不能只依赖继承。
文件首次创建使用 CreateNew 并同时指定 FileSecurity，失败不覆盖已有文件。
证据固定为本根的 oss-acceptance-<UUID>.jsonl，排他创建并依赖持续受保护的父链。

## ROOT-only 与拒绝复验

管理员 PowerShell 5.1，工作目录为新副本 app，按离线包实际位置设置 $node：

~~~powershell
$node=(Resolve-Path '..\runtime\node.exe').Path
if((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash -cne '3602F2BB1A10F2CBAB4C36886218A33C1AB3DB87290E73B033C46C77147D0237'){throw 'NODE_HASH_MISMATCH'}
& $node --input-type=module -e "import {readOssAcceptanceFixed} from './backup/oss-acceptance-path.js'; await readOssAcceptanceFixed('ROOT'); console.log('ROOT_OK');"
if($LASTEXITCODE -ne 0){throw 'ROOT_RETEST_FAILED'}
~~~

预期 ROOT_OK、exit0；不读取配置/凭据、不创建证据、不执行 OSS。
保持三个 JSON 文件不存在，执行捕获式缺失配置探针：

~~~powershell
& $node --input-type=module -e "import {readOssAcceptanceFixed} from './backup/oss-acceptance-path.js'; try {await readOssAcceptanceFixed('CONFIG');process.exitCode=2;} catch(e) {console.log(e.code);process.exitCode=e.code==='OSS_ACCEPTANCE_ROOT_DENIED'?0:3;}"
if($LASTEXITCODE -ne 0){throw 'MISSING_CONFIG_DID_NOT_FAIL_CLOSED'}
~~~

预期 OSS_ACCEPTANCE_ROOT_DENIED，探针 exit0 表示已确认拒绝，不是配置读取成功。
再由标准账户 JBHH-Lab-User 在可读的新程序目录执行相同捕获式探针，把 CONFIG 改成 ROOT。
预期同样拒绝；若程序目录本身不可读，只算程序文件访问拒绝，不算应用 ROOT 门禁通过。
不授予标准账户安全根权限。不得对真实安全根执行 junction 竞态实验，只能在另行批准的隔离夹具中测。
完整人工入口仍只接受 --run-nonproduction，本地确认输入 DENY 即停止且无目标访问。
本轮不输入联网授权短语，不创建云凭据，不运行真实 OSS 验收。

## 未验证事项

Owner 报告的基础检查已通过，完整 B5-B2B OSS 验收仍未完成。剩余必要范围：

- 受保护配置及只读/写入凭据的完整实机创建、读取、修改/替换及拒绝生命周期。
- 第二次联网范围确认、配置重读及实际使用配置/凭据之间的完整授权绑定集成。
- 真实 OSS 请求、异常/未知结果、独立回读及结果验证；本轮未获联网授权。
- 尚无实机证据的 TOCTOU、目录替换竞争、既有危险句柄、运行期间有效权限与证据目录持续保护。
- 生产部署验收。

第二道确认 DENY 已由 Owner 报告通过，不再列作待测。下一项是上文明确限定的授权成功后缺失 READ
拒绝测试，必须先批准本地副作用及停止条件；本次文档收尾不执行。
合成 ACL、重解析点/句柄与 mock 回归不能代替上述实机证据。基础检查 PASS 不证明完整 TOCTOU
或持续保护已验收；断网不等于操作系统级零网络尝试。固定字符串也不是 TOCTOU 证明。
原冻结提交不变；未 merge/push/deploy，无生产备份/恢复/槽位释放或物理删除。
