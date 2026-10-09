import {createHash} from 'node:crypto';
export const SEVERITY=Object.freeze({INFO:'INFO',WARN:'WARN',ERROR:'ERROR',CRITICAL:'CRITICAL'});
const definitions={
 PROCESS_STARTED:['INFO','服务已启动','检查系统状态'],PROCESS_STOPPING:['INFO','服务正在停止','等待服务恢复'],
 PROCESS_FAILURE:['ERROR','服务曾异常退出','核对原操作结果，勿重复录入'],PROCESS_CRASH_LOOP:['CRITICAL','服务连续异常退出','暂停重复重启并联系技术'],
 READINESS_LOST:['ERROR','系统暂不可营业写入','等待服务器恢复'],READINESS_RESTORED:['INFO','系统已恢复就绪','重新读取服务器状态'],
 DATABASE_UNAVAILABLE:['CRITICAL','数据库连接中断，业务写入及设备控制暂停','等待恢复，不离线补写'],
 DATABASE_RESTORED:['INFO','数据库连接已恢复','重新读取服务器状态'],
 RECOVERY_IN_PROGRESS:['CRITICAL','系统处于恢复维护状态','停止写入，等待验证和明确恢复'],
 RECOVERY_READY_FOR_RESUME:['WARN','恢复验证完成，等待授权恢复','由技术执行明确 resume'],
 RECOVERY_RESUMED:['INFO','恢复维护已结束','重新登录并读取状态'],
 BACKUP_SUCCESS:['INFO','备份已验证成功','核对备份时效'],BACKUP_FAILURE:['ERROR','备份失败，恢复风险窗口扩大','保留最后成功备份，勿自动恢复'],
 BACKUP_OVERDUE:['CRITICAL','没有符合时效要求的成功备份','联系老板核对备份计划'],BACKUP_POLICY_MISSING:['ERROR','生产备份策略未配置','完成备份策略后再投产'],
 DEVICE_OFFLINE:['WARN','房间设备持续离线','检查物理通电与网络，等待原流程'],
 DEVICE_UNKNOWN:['ERROR','设备控制结果不确定','禁止重发开关；只查询并联系技术'],
 DEVICE_VERIFYING:['WARN','设备结果仍待验证','等待原流程，不新建操作'],
 DEVICE_FAILED:['ERROR','设备流程失败','核对设备证据后联系技术'],
 PROVIDER_AUTH_FAILURE:['ERROR','设备服务认证失败','联系技术核对认证，勿重复登录探测'],
 PROVIDER_RESTORED:['INFO','设备服务认证已恢复','检查原设备流程'],
 AUTH_RATE_LIMITED:['WARN','登录尝试触发限流','核对异常来源，勿公开账号资料'],
 AUTH_REPEATED_FAILURES:['WARN','短时间出现多次登录失败','核对账号或来源是否异常'],
 TLS_EXPIRING:['WARN','HTTPS 证书接近有效期','提前安排更新证书，勿跳过校验'],
 DISK_CAPACITY_LOW:['ERROR','运行目录可用空间不足','联系技术处理，勿删除业务数据'],
 DIRECTORY_UNWRITABLE:['ERROR','运行目录不可写','联系技术核对磁盘与权限'],
 LOG_WRITE_FAILURE:['CRITICAL','安全日志写入失败','查看服务输出并联系技术'],
 UNCAUGHT_EXCEPTION:['CRITICAL','服务发生未处理异常','等待受控重启，核对原操作结果'],
 UNHANDLED_REJECTION:['CRITICAL','服务发生未处理异步异常','等待受控重启，核对原操作结果'],
 DATA_INVARIANT_FAILURE:['CRITICAL','业务数据校验不一致','暂停写入；保留证据，禁止自动修复'],
 MONITORING_FAILURE:['ERROR','监控持久化或采集异常','查看服务输出并联系技术'],
 ALERT_DELIVERY_FAILED:['ERROR','告警发送失败','查看本地 incident 并核对告警配置'],
 ALERT_CHANNEL_MISSING:['ERROR','真实告警渠道尚未配置','由老板决定通知渠道与接收人']
};
export const EVENTS=Object.freeze(Object.fromEntries(Object.entries(definitions).map(([code,[severity,message,action]])=>[code,Object.freeze({severity,message,action,runbook:code})])));
export const hash=value=>createHash('sha256').update(String(value)).digest('hex');
export function safeContext(input={},secrets=[]){
 const out={};
 for(const key of ['requestId','principalId','operationKey','workflowId','roomId','component','category']){
  const value=input[key];if(typeof value!=='string'||!value||value.length>128||secrets.some(s=>s&&value.includes(s)))continue;
  if(key==='operationKey'){out[key]=/^[a-f0-9-]{36}$/i.test(value)?value:hash(value);continue;}
  if(/^[A-Za-z0-9_.:-]+$/.test(value))out[key]=value;
 }
 return out;
}
export function operationalEvent(eventType,context={},now=Date.now(),secrets=[]){
 const definition=EVENTS[eventType];if(!definition)throw Error('OPERATIONAL_EVENT_INVALID');
 return {timestamp:new Date(now).toISOString(),severity:definition.severity,eventType,code:eventType,...safeContext(context,secrets),message:definition.message,action:definition.action,runbook:definition.runbook};
}
