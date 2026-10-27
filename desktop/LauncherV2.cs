using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

class LeadRadarLauncher {
 const string WindowTitle="LeadRadar 获客雷达 · 启动中心";
 static string data,sessionFile;static Process worker;static NotifyIcon tray;static Form window;
 static Label status,detail;static Button openButton,copyButton;static bool exiting=false,ownsWorker=false;
 static JavaScriptSerializer json=new JavaScriptSerializer();static Dictionary<string,object> currentSession;
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr FindWindow(string className,string title);
 [DllImport("user32.dll")]static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr hwnd);
 [STAThread]static int Main(string[] args){
  bool smoke=Array.IndexOf(args,"--smoke-test")>=0;
  data=Environment.GetEnvironmentVariable("LEADRADAR_DATA_DIR");if(String.IsNullOrEmpty(data))data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LeadRadar","data");
  Directory.CreateDirectory(data);sessionFile=Path.Combine(data,"desktop-session.json");
  Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
  string scope;using(var sha=SHA256.Create())scope=BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(data).ToLowerInvariant()))).Replace("-","").Substring(0,16);
  bool created;using(var mutex=new Mutex(true,"Local\\LeadRadarDesktop-3-"+scope,out created)){
   if(!created){
    IntPtr existing=FindWindow(null,WindowTitle);if(existing!=IntPtr.Zero){ShowWindow(existing,9);SetForegroundWindow(existing);}
    for(int i=0;i<30;i++){var s=Session();if(s!=null&&Healthy(s)){if(!smoke){try{OpenWorkstation(s);}catch(Exception e){MessageBox.Show("后台已经启动，但工作台窗口没有打开。请在启动中心点击“打开工作台”。\n"+e.Message,"LeadRadar");}}return 0;}Thread.Sleep(300);}
    if(!smoke)MessageBox.Show("另一个 LeadRadar 正在启动，请查看任务栏中的启动中心。","LeadRadar");return 1;
   }
   if(smoke){try{currentSession=StartBackend();File.WriteAllText(Path.Combine(data,"exe-smoke-test.json"),json.Serialize(new {ok=true,version=Assembly.GetExecutingAssembly().GetName().Version.ToString(),pid=currentSession["pid"],time=DateTime.UtcNow.ToString("o")}),Encoding.UTF8);StopWorker();return 0;}catch(Exception e){WriteLog(e.ToString());StopWorker();return 1;}}
   window=CreateWindow();
   window.Shown+=async(s,e)=>{try{currentSession=await Task.Run(()=>StartBackend());SetStatus("程序已就绪","工作台将以独立窗口打开。您也可以使用下方按钮重新打开。");openButton.Enabled=true;copyButton.Enabled=true;try{OpenWorkstation(currentSession);}catch(Exception ex){SetStatus("后台已启动，工作台未打开",ex.Message+"\n请点击“复制访问地址”，在浏览器中粘贴打开。");}}catch(Exception ex){WriteLog(ex.ToString());SetStatus("启动失败",ex.Message+"\n请点击“查看启动日志”核对原因。");}};
   Application.ApplicationExit+=(s,e)=>{exiting=true;StopWorker();if(tray!=null){tray.Visible=false;tray.Dispose();}};
   Application.Run(window);return 0;
  }
 }
 static Form CreateWindow(){
  var form=new Form{Text=WindowTitle,ClientSize=new Size(650,410),StartPosition=FormStartPosition.CenterScreen,FormBorderStyle=FormBorderStyle.FixedSingle,MaximizeBox=false,BackColor=Color.FromArgb(246,248,252),Font=new Font("Microsoft YaHei UI",10),AutoScaleMode=AutoScaleMode.Dpi};
  var title=new Label{Text="LeadRadar 获客雷达",Font=new Font("Microsoft YaHei UI",22,FontStyle.Bold),ForeColor=Color.FromArgb(21,35,60),Location=new Point(30,24),AutoSize=true};form.Controls.Add(title);
  form.Controls.Add(new Label{Text="桌面版 3.2.0  ·  真实数据工作台",Location=new Point(33,76),AutoSize=true,ForeColor=Color.FromArgb(100,112,135)});
  status=new Label{Text="正在启动，请稍候…",Font=new Font("Microsoft YaHei UI",13,FontStyle.Bold),ForeColor=Color.FromArgb(214,35,79),Location=new Point(32,125),Size=new Size(585,32)};form.Controls.Add(status);
  detail=new Label{Text="首次启动需要解压运行时，通常需要几秒钟。",Location=new Point(33,168),Size=new Size(580,60),ForeColor=Color.FromArgb(80,94,116)};form.Controls.Add(detail);
  openButton=new Button{Text="打开工作台",Enabled=false,Location=new Point(32,246),Size=new Size(172,43),BackColor=Color.FromArgb(220,35,80),ForeColor=Color.White,FlatStyle=FlatStyle.Flat};openButton.FlatAppearance.BorderSize=0;openButton.Click+=(s,e)=>{try{OpenWorkstation(currentSession);}catch(Exception ex){SetStatus("工作台窗口未打开",ex.Message);}};form.Controls.Add(openButton);
  copyButton=new Button{Text="复制访问地址",Enabled=false,Location=new Point(216,246),Size=new Size(172,43)};copyButton.Click+=(s,e)=>{if(currentSession!=null){Clipboard.SetText((string)currentSession["url"]);SetStatus("地址已复制","在浏览器地址栏粘贴，即可进入本机工作台。");}};form.Controls.Add(copyButton);
  var logButton=new Button{Text="查看启动日志",Location=new Point(400,246),Size=new Size(204,43)};logButton.Click+=(s,e)=>{var file=Path.Combine(data,"desktop.log");if(!File.Exists(file))File.WriteAllText(file,"LeadRadar 启动日志\r\n");Process.Start(new ProcessStartInfo("notepad.exe","\""+file+"\""){UseShellExecute=true});};form.Controls.Add(logButton);
  var folderButton=new Button{Text="打开数据目录",Location=new Point(32,305),Size=new Size(172,36)};folderButton.Click+=(s,e)=>Process.Start(new ProcessStartInfo(data){UseShellExecute=true});form.Controls.Add(folderButton);
  var quitButton=new Button{Text="退出程序",Location=new Point(216,305),Size=new Size(172,36)};quitButton.Click+=(s,e)=>{exiting=true;Application.Exit();};form.Controls.Add(quitButton);
  form.Controls.Add(new Label{Text="关闭本窗口会收起到右下角托盘；点击“退出程序”可停止后台。",Location=new Point(32,367),Size=new Size(585,22),Font=new Font("Microsoft YaHei UI",9),ForeColor=Color.FromArgb(115,125,145)});
  tray=new NotifyIcon{Icon=SystemIcons.Application,Text="LeadRadar 获客雷达",Visible=true};var menu=new ContextMenuStrip();menu.Items.Add("显示启动中心",null,(s,e)=>{form.Show();form.WindowState=FormWindowState.Normal;form.Activate();});menu.Items.Add("打开工作台",null,(s,e)=>{if(currentSession!=null)try{OpenWorkstation(currentSession);}catch(Exception ex){form.Show();SetStatus("无法打开工作台",ex.Message);}});menu.Items.Add("退出程序",null,(s,e)=>{exiting=true;Application.Exit();});tray.ContextMenuStrip=menu;tray.DoubleClick+=(s,e)=>{form.Show();form.WindowState=FormWindowState.Normal;form.Activate();};
  form.FormClosing+=(s,e)=>{if(!exiting&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;form.Hide();}};
  var timer=new System.Windows.Forms.Timer{Interval=2000};timer.Tick+=(s,e)=>{if(worker!=null&&ownsWorker&&worker.HasExited){openButton.Enabled=false;SetStatus("后台已停止","请退出程序后重新双击桌面图标；异常信息可在启动日志查看。");}};timer.Start();return form;
 }
 static void SetStatus(string heading,string message){status.Text=heading;detail.Text=message;}
 static Dictionary<string,object> StartBackend(){
  var existing=Session();if(existing!=null&&Healthy(existing)){WriteLog("复用已运行的后台");return existing;}
  string version=Assembly.GetExecutingAssembly().GetName().Version.ToString();string appRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"LeadRadar","app",version);string ready=Path.Combine(appRoot,".ready");
  if(!File.Exists(ready)){Directory.CreateDirectory(appRoot);using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))using(var zip=new ZipArchive(stream,ZipArchiveMode.Read)){foreach(var entry in zip.Entries){string target=Path.GetFullPath(Path.Combine(appRoot,entry.FullName));if(!target.StartsWith(Path.GetFullPath(appRoot)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid package entry");if(entry.FullName.EndsWith("/")){Directory.CreateDirectory(target);continue;}Directory.CreateDirectory(Path.GetDirectoryName(target));using(var src=entry.Open())using(var dst=File.Create(target))src.CopyTo(dst);}}File.WriteAllText(ready,"LeadRadar 3.2.0");}
  var info=new ProcessStartInfo(Path.Combine(appRoot,"node.exe"),"\""+Path.Combine(appRoot,"app","server.mjs")+"\""){WorkingDirectory=Path.Combine(appRoot,"app"),UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};info.EnvironmentVariables["LEADRADAR_DATA_DIR"]=data;
  worker=new Process{StartInfo=info,EnableRaisingEvents=true};worker.OutputDataReceived+=(s,e)=>WriteLog(e.Data);worker.ErrorDataReceived+=(s,e)=>WriteLog(e.Data);worker.Start();ownsWorker=true;worker.BeginOutputReadLine();worker.BeginErrorReadLine();
  for(int i=0;i<100;i++){if(worker.HasExited)throw new Exception("后台启动失败，请查看启动日志。");var candidate=Session();if(candidate!=null&&Convert.ToInt32(candidate["pid"])==worker.Id&&Healthy(candidate))return candidate;Thread.Sleep(200);}throw new Exception("后台启动超过20秒，请查看启动日志。");
 }
 static readonly object logLock=new object();static void WriteLog(string s){if(s==null)return;lock(logLock){try{File.AppendAllText(Path.Combine(data,"desktop.log"),DateTime.Now.ToString("s")+" "+s+Environment.NewLine,Encoding.UTF8);}catch{}}}
 static Dictionary<string,object> Session(){try{return json.Deserialize<Dictionary<string,object>>(File.ReadAllText(sessionFile));}catch{return null;}}
 static string Request(Dictionary<string,object> s,string route,bool post){if(s==null)throw new Exception("No session");var req=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+s["port"]+"/api/"+route);req.Proxy=null;req.Timeout=2000;req.Headers["Authorization"]="Bearer "+s["token"];if(post){req.Method="POST";req.ContentType="application/json";byte[] b=Encoding.UTF8.GetBytes("{}");req.ContentLength=b.Length;using(var stream=req.GetRequestStream())stream.Write(b,0,b.Length);}using(var res=req.GetResponse())using(var reader=new StreamReader(res.GetResponseStream()))return reader.ReadToEnd();}
 static bool Healthy(Dictionary<string,object> s){try{return Request(s,"health",false).Contains("\"ok\":true");}catch{return false;}}
 static void StopWorker(){try{if(ownsWorker&&worker!=null&&!worker.HasExited){Request(Session(),"shutdown",true);if(!worker.WaitForExit(4000))worker.Kill();}}catch{}}
 static void OpenWorkstation(Dictionary<string,object> s){
  if(s==null)throw new Exception("后台尚未就绪");string url=(string)s["url"];
  var paths=new[]{Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),"Microsoft","Edge","Application","msedge.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Microsoft","Edge","Application","msedge.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),"Google","Chrome","Application","chrome.exe"),Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Google","Chrome","Application","chrome.exe")};
  foreach(string browser in paths){if(File.Exists(browser)){Process.Start(new ProcessStartInfo(browser,"--app=\""+url+"\" --new-window --no-first-run"){UseShellExecute=false,CreateNoWindow=true});WriteLog("工作台应用窗口已请求打开");return;}}
  Process.Start(new ProcessStartInfo(url){UseShellExecute=true});WriteLog("已请求默认浏览器打开工作台");
 }
}
