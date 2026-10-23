# B5-B2B 固定安全根：Windows 11 断网实验室复验

只供 Owner 审核后手工执行。开发机和现有虚拟机副本未被本次修改。
固定根 C:\JbhhKtvSecure\oss-acceptance；没有旧 ProgramData 路径回退。
不放宽 ProgramData 的 WA/WEA 检查，不迁移凭据，不批准 OSS 联网。

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
不是只要计划设置严格 ACL 就算完成；以上首次创建结果及后续 ROOT 检查均须实机通过。
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

合成 ACL、重解析点/句柄和 mock 授权回归只证明代码路径与拒绝合同。
Windows 11 首次创建、完整根 ACL/有效权限、危险句柄、运行期间可信账户、证据目录持续保护及
应用集成仍须 Owner 实机验收。语法通过不等于初始化成功，断网不等于操作系统级零网络尝试。
固定字符串不是 TOCTOU 证明；完整保护依赖上述父链、首次创建、句柄与持续信任条件。
原冻结提交不变；未 merge/push/deploy，无生产备份/恢复/槽位释放或物理删除。
