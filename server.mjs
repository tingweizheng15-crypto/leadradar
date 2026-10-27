import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,DATA_DIR,loadConfig,validateConfig,searchReady,llmReady} from './src/config.mjs';
import {runPipeline,buildQueries} from './src/pipeline.mjs';
import {readStore,atomicJson,updateCompany} from './src/store.mjs';
import {closeConnections,redactError} from './src/net.mjs';
import {parseSearchTerms,searchTerms} from './src/search-terms.mjs';
import {MARKETS,topicsFor,normalizeLocalized,prepareLanguagePlan} from './src/localization.mjs';
const token=crypto.randomBytes(32).toString('hex');let busy=false,controller=null,lastResult=null;const logs=[];
const log=s=>{logs.push({at:new Date().toISOString(),text:s});if(logs.length>160)logs.shift();console.log(s);};
fs.mkdirSync(DATA_DIR,{recursive:true});
async function startRun(cfg=loadConfig()){if(busy)throw Error('已有任务正在运行');busy=true;controller=new AbortController();log(searchTerms(cfg).length?'开始自定义搜索：'+searchTerms(cfg).join('；'):'开始核验客户');try{lastResult=await runPipeline(cfg,{signal:controller.signal,onProgress:log});}catch(e){lastResult={error:redactError(e)};log('任务停止：'+redactError(e));}finally{busy=false;controller=null;}}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
async function body(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>32000)throw Error('请求内容过大');}return s?JSON.parse(s):{};}
function publicSettings(cfg){return {multilingual:cfg.search.multilingual!==false,localized_keywords:cfg.search.localized_keywords||{},language_markets:MARKETS,search_terms:searchTerms(cfg).join('\n'),markets:cfg.markets,products:cfg.products,proxy:cfg.proxy,queries:cfg.search.max_queries_per_run,candidates:cfg.report.max_candidates_per_run,schedule:cfg.schedule,search_ready:searchReady(cfg),llm_ready:llmReady(cfg),llm_base_url:cfg.llm.base_url,llm_model:cfg.llm.model,provider:cfg.search.provider,hunter_ready:Boolean(cfg.contacts.email_finder.hunter.apiKey),hunter_enabled:cfg.contacts.email_finder.provider==='hunter'};}
function persistConfig(cfg){const saved=structuredClone(cfg);delete saved.data_dir;atomicJson(path.join(DATA_DIR,'config.json'),saved);}
function applySearchInput(cfg,input){
 const before=JSON.stringify(topicsFor(cfg));if(Object.hasOwn(input,'search_terms'))cfg.search.custom_keywords=parseSearchTerms(input.search_terms);
 if(JSON.stringify(topicsFor(cfg))!==before)cfg.search.localized_keywords={};
 if(Object.hasOwn(input,'markets')){if(!Array.isArray(input.markets))throw Error('市场格式不正确');cfg.markets=input.markets;}
 if(Object.hasOwn(input,'multilingual'))cfg.search.multilingual=input.multilingual;
 if(Object.hasOwn(input,'localized_keywords'))cfg.search.localized_keywords=normalizeLocalized(input.localized_keywords,topicsFor(cfg));
 return validateConfig(cfg);
}
const server=http.createServer(async(req,res)=>{
 try{
  const address=server.address();const origin=`http://127.0.0.1:${address.port}`;
  if(req.headers.host!==`127.0.0.1:${address.port}`)return json(res,403,{error:'非法主机'});
  const u=new URL(req.url,origin);
  if(req.headers.origin&&req.headers.origin!==origin)return json(res,403,{error:'禁止跨站访问'});
  if(u.pathname.startsWith('/api/')&&req.headers.authorization!==`Bearer ${token}`)return json(res,401,{error:'请从桌面程序打开本界面'});
  if(req.method==='GET'&&u.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"});return res.end(fs.readFileSync(path.join(ROOT,'app/index.html')));}
  if(req.method==='GET'&&['/app.js','/app.css'].includes(u.pathname)){res.writeHead(200,{'Content-Type':u.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});return res.end(fs.readFileSync(path.join(ROOT,'app',u.pathname.slice(1))));}
  if(req.method==='GET'&&u.pathname==='/api/health')return json(res,200,{ok:true,version:'3.2.0',pid:process.pid});
  if(req.method==='GET'&&u.pathname==='/api/state'){const cfg=loadConfig();return json(res,200,{busy,logs,lastResult:lastResult?{stats:lastResult.stats,error:lastResult.error}:null,settings:publicSettings(cfg),...readStore(),data_dir:DATA_DIR});}
  if(req.method==='POST'&&u.pathname==='/api/keywords'){
   if(busy)return json(res,409,{error:'运行中不能更改搜索词'});const input=await body(req),cfg=applySearchInput(loadConfig(),input);persistConfig(cfg);return json(res,200,{ok:true,search_terms:searchTerms(cfg).join('\n')});
  }
  if(req.method==='POST'&&u.pathname==='/api/search-plan'){
   if(busy)return json(res,409,{error:'采集中请稍后预览'});const cfg=applySearchInput(loadConfig(),await body(req));const plan=await prepareLanguagePlan(cfg);const queries=buildQueries(cfg,plan);
   if(queries.length<plan.markets.length||cfg.search.max_queries_per_run<Math.max(plan.topics.length,plan.markets.length))plan.warnings.push('当前搜索预算较小，部分国家或词可能未覆盖；可在配置中增加搜索预算。');
   return json(res,200,{...plan,queries,total_queries:queries.length,budget:cfg.search.max_queries_per_run});
  }
  if(req.method==='POST'&&u.pathname==='/api/run'){
   if(busy)return json(res,409,{error:'已有任务正在运行'});const input=await body(req),cfg=applySearchInput(loadConfig(),input);
   if(searchTerms(cfg).length&&!searchReady(cfg))return json(res,400,{error:'自定义搜索需要搜索 API 密钥，请先在“配置与定时”填写 Serper API Key'});
   persistConfig(cfg);void startRun(cfg);return json(res,202,{started:true});
  }
  if(req.method==='POST'&&u.pathname==='/api/cancel'){controller?.abort(Error('用户取消'));return json(res,200,{ok:true});}
  if(req.method==='POST'&&u.pathname==='/api/settings'){
   if(busy)return json(res,409,{error:'运行中不能更改设置'});const input=await body(req);const cfg=loadConfig();const originalTopics=JSON.stringify(topicsFor(cfg));
   if(input.markets)cfg.markets=input.markets.filter(x=>['KR','TH','US','UK','ID','MY'].includes(x));if(input.products)cfg.products=input.products.filter(x=>['compression_tights','running_singlet','running_shorts','quick_dry'].includes(x));
   if(typeof input.proxy==='string')cfg.proxy=input.proxy.trim();if(input.serper_key?.trim()){cfg.search.provider='serper';cfg.search.serper.apiKey=input.serper_key.trim();}
   if(input.llm_key?.trim())cfg.llm.api_key=input.llm_key.trim();if(input.llm_base_url?.trim()){const u=new URL(input.llm_base_url);if(!['https:','http:'].includes(u.protocol))throw Error('模型地址无效');cfg.llm.base_url=input.llm_base_url.trim();}if(input.llm_model?.trim())cfg.llm.model=input.llm_model.trim();
   if(input.hunter_key?.trim())cfg.contacts.email_finder.hunter.apiKey=input.hunter_key.trim();cfg.contacts.email_finder.provider=input.hunter_enabled?'hunter':'none';
   if(input.queries!==undefined)cfg.search.max_queries_per_run=Number(input.queries);if(input.candidates!==undefined)cfg.report.max_candidates_per_run=Number(input.candidates);
   if(input.schedule){cfg.schedule.enabled=Boolean(input.schedule.enabled);cfg.schedule.daily=input.schedule.daily;cfg.schedule.timezone='Asia/Shanghai';}
   if(originalTopics!==JSON.stringify(topicsFor(cfg)))cfg.search.localized_keywords={};validateConfig(cfg);delete cfg.data_dir;atomicJson(path.join(DATA_DIR,'config.json'),cfg);return json(res,200,{ok:true});
  }
  if(req.method==='POST'&&u.pathname==='/api/company'){const b=await body(req);if(busy)return json(res,409,{error:'请等待采集完成再保存跟进'});return json(res,200,updateCompany(DATA_DIR,b.id,b));}
  if(req.method==='GET'&&u.pathname==='/api/report'){
   const run=readStore().runs.find(r=>r.id===u.searchParams.get('id'));const format=u.searchParams.get('format')||'html';const names={html:'report.html',csv:'leads.csv',json:'data.json',md:'report.md'};if(!run||!names[format])return json(res,404,{error:'报告不存在'});
   const file=path.resolve(run.report_dir,names[format]);if(!file.startsWith(path.resolve(DATA_DIR,'reports')+path.sep))return json(res,403,{error:'无效报告路径'});
   res.writeHead(200,{'Content-Type':({html:'text/html',csv:'text/csv',json:'application/json',md:'text/plain'})[format]+'; charset=utf-8','Content-Disposition':`attachment; filename="leadradar-${run.id}.${format}"`});return res.end(fs.readFileSync(file));
  }
  if(req.method==='POST'&&u.pathname==='/api/shutdown'){controller?.abort();json(res,200,{ok:true});setTimeout(()=>{closeConnections();server.close();process.exit(0);},100);return;}
  json(res,404,{error:'未找到'});
 }catch(e){json(res,400,{error:redactError(e)});}
});
server.listen(0,'127.0.0.1',()=>{const port=server.address().port;atomicJson(path.join(DATA_DIR,'desktop-session.json'),{pid:process.pid,port,token,url:`http://127.0.0.1:${port}/#${token}`});console.log('LeadRadar ready');});
let scheduleDay='';
const scheduleTimer=setInterval(()=>{
 try{const cfg=loadConfig();if(!cfg.schedule.enabled||busy)return;const values={};for(const p of new Intl.DateTimeFormat('en-CA',{timeZone:cfg.schedule.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()))values[p.type]=p.value;
  const day=`${values.year}-${values.month}-${values.day}`;const now=`${values.hour}:${values.minute}:${values.second}`;const marker=path.join(DATA_DIR,'schedule-state.json');if(fs.existsSync(marker)&&!scheduleDay)scheduleDay=JSON.parse(fs.readFileSync(marker,'utf8')).day||'';
  if(now>=cfg.schedule.daily&&scheduleDay!==day){scheduleDay=day;atomicJson(marker,{day});void startRun();}
 }catch(e){log('定时配置错误：'+redactError(e));}
},1000);scheduleTimer.unref();
process.on('SIGTERM',()=>{controller?.abort();closeConnections();server.close();process.exit(0);});
