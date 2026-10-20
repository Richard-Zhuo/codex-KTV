using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.ServiceProcess;

public sealed class KtvServiceHost : ServiceBase {
  private static IntPtr job;
  private readonly string node, entry, config;
  private Process child;
  private volatile bool stopping;
  public KtvServiceHost(string nodePath,string entryPath,string configPath) {
    node=FullFile(nodePath);entry=FullFile(entryPath);config=FullFile(configPath);
    ServiceName="JbhhKtv";CanStop=true;CanShutdown=true;AutoLog=false;
  }
  private static string FullFile(string path) {
    if(!Path.IsPathRooted(path)||path.IndexOfAny(new char[]{'"','\r','\n'})>=0||!File.Exists(path))throw new Exception("SERVICE_PATH_INVALID");
    return Path.GetFullPath(path);
  }
  protected override void OnStart(string[] args) {
    var info=new ProcessStartInfo(node,"\""+entry+"\" --config-file \""+config+"\"");
    info.WorkingDirectory=Path.GetDirectoryName(entry);
    info.UseShellExecute=false;info.CreateNoWindow=true;
    info.RedirectStandardInput=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
    foreach(var key in new string[]{"NODE_OPTIONS","NODE_TLS_REJECT_UNAUTHORIZED"})info.EnvironmentVariables.Remove(key);
    info.EnvironmentVariables["NODE_ENV"]="production";info.EnvironmentVariables["KTV_HTTP_ENV"]="production";info.EnvironmentVariables["KTV_DEPLOYMENT_ENV"]="production";
    child=new Process();child.StartInfo=info;child.EnableRaisingEvents=true;
    // Child writes its own safe Git-external JSON log. Never forward arbitrary stderr/config.
    child.OutputDataReceived+=(s,e)=>{};child.ErrorDataReceived+=(s,e)=>{};
    child.Exited+=(s,e)=>{if(!stopping)Environment.Exit(1);};
    child.Start();child.BeginOutputReadLine();child.BeginErrorReadLine();
  }
  protected override void OnStop() {
    stopping=true;
    if(child==null)return;
    try {if(!child.HasExited){child.StandardInput.WriteLine("STOP");child.StandardInput.Flush();if(!child.WaitForExit(20000)){child.Kill();child.WaitForExit(3000);}}}
    catch {try{if(!child.HasExited)child.Kill();}catch{}}
  }
  protected override void OnShutdown(){OnStop();base.OnShutdown();}
  [StructLayout(LayoutKind.Sequential)] private struct BasicLimits {
    public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorkingSet,MaxWorkingSet;public uint ActiveProcesses;public UIntPtr Affinity;public uint Priority,Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] private struct IoCounters {public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes;}
  [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits {public BasicLimits Basic;public IoCounters Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr handle,int kind,IntPtr value,uint length);
  [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr handle,IntPtr process);
  private static void OwnProcessTree() {
    job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception();
    var limits=new ExtendedLimits();limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE: no orphan Node after host crash.
    int size=Marshal.SizeOf(limits);IntPtr memory=Marshal.AllocHGlobal(size);
    try{Marshal.StructureToPtr(limits,memory,false);if(!SetInformationJobObject(job,9,memory,(uint)size)||!AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle))throw new Exception();}
    finally{Marshal.FreeHGlobal(memory);}
    // Keep the handle until OS process exit; children inherit job membership.
  }
  // One-shot child of the existing service, not a service registration or shell.
  // The service-side caller supplies only its SCM-bound paths. S4 is still
  // enforced by the original CLI inside this per-run kill-on-close Job.
  private static int BackupChild(string[] args) {
    if(args.Length!=11||args[1]!="--node"||args[3]!="--entry"||
       args[5]!="--config"||args[7]!="--output-dir"||args[9]!="--confirm")throw new Exception();
    string node=FullFile(args[2]),entry=FullFile(args[4]),runtimeConfig=FullFile(args[6]);
    if(Path.GetFileName(entry)!="start.js"||Path.GetFileName(Path.GetDirectoryName(entry))!="production")throw new Exception();
    string cli=FullFile(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(entry)),"backup","cli.js"));
    string config=FullFile(Path.Combine(Path.GetDirectoryName(runtimeConfig),"backup.json"));
    string output=args[8],confirmation=args[10];
    foreach(string value in new string[]{output,confirmation})
      if(value.IndexOfAny(new char[]{'"','\r','\n'})>=0)throw new Exception();
    if(!Path.IsPathRooted(output))throw new Exception();
    OwnProcessTree(); // Before any CLI descendant exists; inherits parent Job too.
    var info=new ProcessStartInfo(node,"\""+cli+"\" backup --config-file \""+config+
      "\" --output-dir \""+output+"\" --confirm \""+confirmation+"\"");
    info.UseShellExecute=false;info.CreateNoWindow=true;
    info.RedirectStandardOutput=true;info.RedirectStandardError=true;
    info.StandardOutputEncoding=Encoding.UTF8;info.StandardErrorEncoding=Encoding.UTF8;
    Console.OutputEncoding=new UTF8Encoding(false);
    info.EnvironmentVariables.Remove("NODE_OPTIONS");info.EnvironmentVariables.Remove("NODE_TLS_REJECT_UNAUTHORIZED");
    info.EnvironmentVariables["NODE_ENV"]="production";info.EnvironmentVariables["KTV_HTTP_ENV"]="production";info.EnvironmentVariables["KTV_DEPLOYMENT_ENV"]="production";
    var outputText=new StringBuilder();bool overflow=false;
    using(var process=new Process()) {
      process.StartInfo=info;
      process.OutputDataReceived+=(s,e)=>{if(e.Data==null)return;lock(outputText){
        if(outputText.Length+e.Data.Length+1>16384)overflow=true;else outputText.AppendLine(e.Data);}};
      process.ErrorDataReceived+=(s,e)=>{};
      process.Start();process.BeginOutputReadLine();process.BeginErrorReadLine();process.WaitForExit();
      if(process.ExitCode!=0||overflow)return 1;
      Console.Out.Write(outputText.ToString());return 0;
    }
  }
  public static int Main(string[] args) {
    try {
      if(args.Length>0&&args[0]=="--backup-child")return BackupChild(args);
      bool console=args.Length==7&&args[0]=="--console";int offset=console?1:0;
      if(args.Length!=offset+6||args[offset]!="--node"||args[offset+2]!="--entry"||args[offset+4]!="--config")throw new Exception();
      OwnProcessTree();
      var host=new KtvServiceHost(args[offset+1],args[offset+3],args[offset+5]);
      if(console){host.OnStart(new string[0]);Console.ReadLine();host.OnStop();}
      else ServiceBase.Run(host);
      return 0;
    }catch{Console.Error.WriteLine("{\"code\":\"SERVICE_HOST_FAILED\"}");return 1;}
  }
}
