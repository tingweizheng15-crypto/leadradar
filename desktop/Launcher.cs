using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using System.Drawing;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;

class LeadRadarLauncher {
 static string data, sessionFile; static Process worker; static NotifyIcon tray;
 static JavaScriptSerializer json = new JavaScriptSerializer();
 [STAThread] static int Main(string[] args) {
  bool smoke=Array.IndexOf(args,"--smoke-test")>=0;
  Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
  data=Environment.GetEnvironmentVariable("LEADRADAR_DATA_DIR");
  if(String.IsNullOrEmpty(data)) data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LeadRadar","data");
  Directory.CreateDirectory(data);sessionFile=Path.Combine(data,"desktop-session.json");
  bool created;using(var mutex=new Mutex(true,"Local\\LeadRadarDesktop-3",out created)) {
   if(!created) { for(int i=0;i<30;i++){var existing=Session();if(existing!=null&&Healthy(existing)){OpenBrowser(existing);return 0;}Thread.Sleep(500);}return 1; }
   try {
    var existing=Session();if(existing!=null&&Healthy(existing)){if(!smoke)OpenBrowser(existing);return 0;}
    string version=Assembly.GetExecutingAssembly().GetName().Version.ToString();
    string appRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LeadRadar","app",version);
    string ready=Path.Combine(appRoot,".ready");
    if(!File.Exists(ready)){
     Directory.CreateDirectory(appRoot);
     using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
     using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)){
      foreach(var entry in zip.Entries){string target=Path.GetFullPath(Path.Combine(appRoot,entry.FullName));if(!target.StartsWith(Path.GetFullPath(appRoot)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid package entry");if(entry.FullName.EndsWith("/")){Directory.CreateDirectory(target);continue;}Directory.CreateDirectory(Path.GetDirectoryName(target));using(var src=entry.Open())using(var dst=File.Create(target))src.CopyTo(dst);}
     }File.WriteAllText(ready,"LeadRadar 3.0");
    }
    var info=new ProcessStartInfo(Path.Combine(appRoot,"node.exe"),"\""+Path.Combine(appRoot,"app","server.mjs")+"\"");
    info.WorkingDirectory=Path.Combine(appRoot,"app");info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;info.RedirectStandardOutput=true;info.RedirectStandardError=true;info.StandardOutputEncoding=Encoding.UTF8;info.StandardErrorEncoding=Encoding.UTF8;info.EnvironmentVariables["LEADRADAR_DATA_DIR"]=data;
    worker=new Process();worker.StartInfo=info;worker.EnableRaisingEvents=true;worker.OutputDataReceived+=(s,e)=>WriteLog(e.Data);worker.ErrorDataReceived+=(s,e)=>WriteLog(e.Data);worker.Start();worker.BeginOutputReadLine();worker.BeginErrorReadLine();
    Dictionary<string,object> session=null;for(int i=0;i<100;i++){if(worker.HasExited)throw new Exception("后台启动失败，请查看 "+Path.Combine(data,"desktop.log"));var candidate=Session();if(candidate!=null&&Convert.ToInt32(candidate["pid"])==worker.Id&&Healthy(candidate)){session=candidate;break;}Thread.Sleep(200);}if(session==null)throw new Exception("后台启动超时");
    if(smoke){File.WriteAllText(Path.Combine(data,"exe-smoke-test.json"),json.Serialize(new {ok=true,version=version,pid=worker.Id,time=DateTime.UtcNow.ToString("o")}),Encoding.UTF8);Request(session,"shutdown",true);worker.WaitForExit(5000);return 0;}
    OpenBrowser(session);tray=new NotifyIcon();tray.Icon=SystemIcons.Application;tray.Text="LeadRadar 获客雷达";tray.Visible=true;var menu=new ContextMenuStrip();menu.Items.Add("打开获客工作台",null,(s,e)=>OpenBrowser(Session()));menu.Items.Add("打开数据文件夹",null,(s,e)=>Process.Start(new ProcessStartInfo(data){UseShellExecute=true}));menu.Items.Add("退出",null,(s,e)=>Application.Exit());tray.ContextMenuStrip=menu;tray.DoubleClick+=(s,e)=>OpenBrowser(Session());
    var timer=new System.Windows.Forms.Timer();timer.Interval=1000;timer.Tick+=(s,e)=>{if(worker.HasExited)Application.Exit();};timer.Start();Application.ApplicationExit+=(s,e)=>{try{if(!worker.HasExited){Request(Session(),"shutdown",true);if(!worker.WaitForExit(4000))worker.Kill();}}catch{}tray.Visible=false;tray.Dispose();};Application.Run();return 0;
   }catch(Exception ex){WriteLog(ex.ToString());if(!smoke)MessageBox.Show(ex.Message,"LeadRadar 启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);try{if(worker!=null&&!worker.HasExited)worker.Kill();}catch{}return 1;}
  }
 }
 static readonly object logLock=new object();
 static void WriteLog(string s){if(s==null)return;lock(logLock){try{File.AppendAllText(Path.Combine(data,"desktop.log"),DateTime.Now.ToString("s")+" "+s+Environment.NewLine,Encoding.UTF8);}catch{}}}
 static Dictionary<string,object> Session(){try{return json.Deserialize<Dictionary<string,object>>(File.ReadAllText(sessionFile));}catch{return null;}}
 static string Request(Dictionary<string,object> s,string route,bool post){if(s==null)throw new Exception("No session");var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+s["port"]+"/api/"+route);req.Proxy=null;req.Timeout=2000;req.Headers["Authorization"]="Bearer "+s["token"];if(post){req.Method="POST";req.ContentType="application/json";byte[] b=Encoding.UTF8.GetBytes("{}");req.ContentLength=b.Length;using(var stream=req.GetRequestStream())stream.Write(b,0,b.Length);}using(var res=req.GetResponse())using(var reader=new StreamReader(res.GetResponseStream()))return reader.ReadToEnd();}
 static bool Healthy(Dictionary<string,object> s){try{return Request(s,"health",false).Contains("\"ok\":true");}catch{return false;}}
 static void OpenBrowser(Dictionary<string,object> s){if(s!=null)Process.Start(new ProcessStartInfo((string)s["url"]){UseShellExecute=true});}
}
