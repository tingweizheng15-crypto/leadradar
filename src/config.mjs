import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {searchTerms} from './search-terms.mjs';
import {validateLocalization} from './localization.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.LEADRADAR_DATA_DIR || path.join(ROOT, 'runtime-data');
export function loadEnvFile(file = path.join(DATA_DIR, '.env')) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file,'utf8').split(/\r?\n/).flatMap(line=>{
    const m=line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/); if(!m)return [];
    let v=m[2]; if(/^['"]/.test(v))v=v.slice(1,v.lastIndexOf(v[0]));else v=v.replace(/\s+#.*$/,'').trim();
    return [[m[1],v]];
  }));
}
export function merge(a,b){const out=structuredClone(a);for(const [k,v] of Object.entries(b||{})){if(['__proto__','constructor','prototype'].includes(k))continue;out[k]=v&&typeof v==='object'&&!Array.isArray(v)?merge(out[k]||{},v):v;}return out;}
export function validateConfig(cfg){
  const terms=searchTerms(cfg);cfg.search.custom_keywords=terms;
  if(!Array.isArray(cfg.markets)||!cfg.markets.length)throw Error('请至少选择一个市场');
  if(!Array.isArray(cfg.products)||!cfg.products.length&&!terms.length)throw Error('请填写自定义搜索词，或至少选择一个预设产品');
  for(const [v,min,max,label] of [[cfg.search.max_queries_per_run,1,120,'搜索次数'],[cfg.search.results_per_query,1,10,'每次结果数'],[cfg.report.max_candidates_per_run,1,100,'候选上限'],[cfg.contacts.page_timeout_ms,1000,60000,'页面超时']])if(!Number.isInteger(v)||v<min||v>max)throw Error(`${label}应为 ${min}–${max} 的整数`);
  if(!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(cfg.schedule.daily))throw Error('定时时间格式应为 HH:MM:SS');
  new Intl.DateTimeFormat('en',{timeZone:cfg.schedule.timezone});
  if(!['serper','google_cse'].includes(cfg.search.provider))throw Error('请选择 Serper 或已有账号的 Google CSE；Bing 旧接口已退役');
  if(!['none','hunter'].includes(cfg.contacts.email_finder.provider))throw Error('当前版本支持已适配的 Hunter；旧 Apollo/Snov 适配已停用');
  if(cfg.proxy&&!/^https?:\/\//.test(cfg.proxy))throw Error('代理须为 http:// 或 https:// 地址');
  return validateLocalization(cfg);
}
export function loadConfig(){
  const defaults=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json'),'utf8'));
  const file=fs.existsSync(path.join(DATA_DIR,'config.json'))?path.join(DATA_DIR,'config.json'):path.join(ROOT,'config.json');
  const cfg=merge(defaults,fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{});
  const env={...loadEnvFile(path.join(ROOT,'.env')),...loadEnvFile(),...process.env};
  const mappings=[['SERPER_API_KEY',cfg.search.serper,'apiKey'],['GOOGLE_CSE_KEY',cfg.search.google_cse,'apiKey'],['GOOGLE_CSE_CX',cfg.search.google_cse,'cx'],['LLM_API_KEY',cfg.llm,'api_key'],['LLM_BASE_URL',cfg.llm,'base_url'],['LLM_MODEL',cfg.llm,'model'],['HUNTER_API_KEY',cfg.contacts.email_finder.hunter,'apiKey']];
  for(const [k,o,key] of mappings)if(env[k])o[key]=env[k];
  cfg.proxy=cfg.proxy||env.HTTPS_PROXY||env.HTTP_PROXY||''; cfg.chrome_path=cfg.chrome_path||env.CHROME_PATH||'';
  cfg.data_dir=DATA_DIR; return validateConfig(cfg);
}
export const llmReady=cfg=>Boolean(cfg.llm?.api_key&&cfg.llm?.model);
export const searchReady=cfg=>cfg.search.provider==='serper'?Boolean(cfg.search.serper?.apiKey):cfg.search.provider==='google_cse'?Boolean(cfg.search.google_cse?.apiKey&&cfg.search.google_cse?.cx):false;
export const emailFinderReady=cfg=>cfg.contacts.email_finder.provider==='hunter'&&Boolean(cfg.contacts.email_finder.hunter?.apiKey);
