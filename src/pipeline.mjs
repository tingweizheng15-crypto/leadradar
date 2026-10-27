import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {searchReady,llmReady,emailFinderReady,ROOT,DATA_DIR} from './config.mjs';
import {search,providerName} from './search.mjs';
import {enrichSite,domainOf} from './enrich.mjs';
import {enrichSocial,isSocialUrl,isSocialHost,parseSocialUrl} from './social.mjs';
import {factsFromPages,countryOf} from './facts.mjs';
import {scoreLead,recompute} from './score.mjs';
import {analyzeLead} from './llm.mjs';
import {writeReport,ymd} from './report.mjs';
import {acquireLock,saveRun} from './store.mjs';
import {safeUrl,redactError} from './net.mjs';
import {searchTerms,customProduct} from './search-terms.mjs';
import {basicLanguagePlan,prepareLanguagePlan,queriesForPlan,evidenceVariants} from './localization.mjs';
export const PRODUCT_QUERY={compression_tights:'compression tights',running_singlet:'running singlet',running_shorts:'running shorts',quick_dry:'quick dry shirt'};
const countries={KR:'Korea',TH:'Thailand',US:'USA',UK:'United Kingdom',ID:'Indonesia',MY:'Malaysia'};
export function buildQueries(cfg,plan=basicLanguagePlan(cfg)){return queriesForPlan(cfg,plan);}
function seedLeads(cfg){const src=JSON.parse(fs.readFileSync(path.join(ROOT,'daily/sources.json'),'utf8'));return src.watchlist.filter(s=>s.channel==='website'&&cfg.markets.includes(s.country)).map(s=>({name:s.name,url:s.url,domain:domainOf(s.url),country:s.country,countrySource:'seed',discovered_for:(s.products||'').split(';'),sources:[{url:s.url,type:'seed'}]}));}
function allowed(url){try{const u=safeUrl(url);if(isSocialHost(u)&&!isSocialUrl(u))return false;return !/(^|\.)(alibaba|aliexpress|amazon|ebay|etsy|reddit|quora|pinterest|wikipedia|google|bing)\./i.test(u.hostname);}catch{return false;}}
async function mapLimit(items,limit,fn){let cursor=0;const out=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i],i);}}));return out;}
export async function discover(cfg,{searcher=search,onProgress=()=>{},signal,translator}={}){
 if(searchTerms(cfg).length&&!searchReady(cfg))throw Error('自定义搜索需要搜索 API 密钥，请先在“配置与定时”填写 Serper API Key');
 if(!searchReady(cfg))return {candidates:seedLeads(cfg),source:'种子官网核验（不是全网搜索）',search:false,queries:[],errors:[]};
 onProgress('准备六国多语言搜索词…');const languagePlan=await prepareLanguagePlan(cfg,{signal,translator});const queries=buildQueries(cfg,languagePlan),map=new Map(),errors=[];let succeeded=0;
 for(const warning of languagePlan.warnings)onProgress(warning);
 // Serial queries keep rate/cost predictable; site enrichment uses bounded concurrency.
 for(let i=0;i<queries.length;i++){signal?.throwIfAborted();const q=queries[i];onProgress(`搜索 ${i+1}/${queries.length} · ${q.q}`);
  try{const rs=await searcher(cfg,q.q,cfg.search.results_per_query,{country:q.country,gl:q.gl,hl:q.hl,language:q.language,signal});succeeded++;
   for(const r of rs||[]){if(!allowed(r.url))continue;const social=parseSocialUrl(r.url);const key=social.platform?social.platform+':'+social.handle:domainOf(r.url);const old=map.get(key);const source={url:r.url,query:q.q,country:q.country,language:q.language,original_keyword:q.keyword,localized_keyword:q.localized_keyword,snippet:r.snippet||''};
    if(old){old.discovered_for=[...new Set([...old.discovered_for,q.product])];old.sources.push(source);continue;}
    map.set(key,{name:r.title||key,url:r.url,domain:key,snippet:r.snippet||'',country:countryOf((r.title||'')+' '+(r.snippet||'')),countrySource:'search_hint',discovered_for:[q.product],query_country:q.country,sources:[source]});
   }
  }catch(e){if(signal?.aborted)throw e;errors.push({query:q.q,error:redactError(e)});if(/HTTP (401|403)/.test(e.message))break;}
 }
 // Round-robin candidate groups so the first market cannot fill the entire enrichment budget.
 const groups=cfg.markets.map(c=>[...map.values()].filter(x=>x.query_country===c));const candidates=[];while(groups.some(g=>g.length))for(const g of groups)if(g.length)candidates.push(g.shift());
 return {candidates,source:providerName(cfg),search:true,queries,succeeded,errors,languagePlan};
}
function verifiedCountry(c,pages){const host=domainOf(c.url);const tld=Object.entries({KR:'.kr',TH:'.th',UK:'.uk',ID:'.id',MY:'.my'}).find(([,t])=>host.endsWith(t))?.[0];if(tld)return {country:tld,countrySource:'tld'};const country=countryOf(pages.map(x=>x.text).join(' '));return {country:country||c.country||'',countrySource:country?'page':'unverified'};}
export async function runPipeline(cfg,opts={}){
 const dir=cfg.data_dir||DATA_DIR;const unlock=acquireLock(dir);const started=Date.now();const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex');const progress=opts.onProgress||(()=>{});const warnings=[];
 try{
  const services=opts.services||{};const discovery=await discover(cfg,{searcher:services.search||search,onProgress:progress,signal:opts.signal,translator:services.translate});
  warnings.push(...(discovery.languagePlan?.warnings||[]));
  if(!discovery.search)warnings.push('没有搜索密钥：本次只核验内置官网，不代表发现了新客户。');
  if(!llmReady(cfg))warnings.push('未启用 AI，使用可追溯的规则评分。');
  warnings.push(...discovery.errors.map(e=>`搜索失败：${e.error}（${e.query}）`));
  const selected=discovery.candidates.slice(0,cfg.report.max_candidates_per_run);let completed=0;
  const records=await mapLimit(selected,3,async c=>{
   const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(Error('单个客户处理超时')),60000);const signal=opts.signal?AbortSignal.any([ctrl.signal,opts.signal]):ctrl.signal;
   let en;try{const fn=services.enrich||(isSocialUrl(c.url)?enrichSocial:enrichSite);en=await fn(cfg,c.url,{signal});}catch(e){if(opts.signal?.aborted)throw e;en={fetch_status:'failed',pages:[],errors:[{url:c.url,error:redactError(e)}]};}finally{clearTimeout(timeout);}
   const localizedTopics=discovery.languagePlan?.topics.map(topic=>({...topic,variants:evidenceVariants(discovery.languagePlan,topic.product)}))||[];
   const lead={...c,...en,...factsFromPages(en.pages||[],{searchTerms:searchTerms(cfg),localizedTopics}),...verifiedCountry(c,en.pages||[]),url:en.website||c.url,domain:en.website?domainOf(en.website):c.domain,emails:en.emails||[],phones:en.phones||[],social:en.social||[],signals:en.signals||[],evidence:en.fetch_status==='ok'?'official':'none',name:en.title||c.name,fetched_at:new Date().toISOString()};
   scoreLead(lead,cfg);
   if(lead.fetch_status==='ok'&&llmReady(cfg)&&lead.overlap.length){const ai=await (services.analyze||analyzeLead)(cfg,lead);if(ai?.error||ai?.parse_error)warnings.push(`${lead.name}：AI 失败，保留规则判断`);else if(ai){lead.ai=ai;lead.ai_fit=ai.fit||'';lead.contact_hint=ai.contact_hint||'';lead.language=ai.language||'';recompute(lead);if(lead.status==='qualified'&&ai.is_buyer===true)lead.draft=ai.draft||'';}}
   if(lead.fetch_status!=='ok')warnings.push(`${c.name}：采集失败，资料状态为未知`);
   completed++;progress(`核验 ${completed}/${selected.length} · ${lead.name} · ${lead.statusLabel} ${lead.total}分`);return lead;
  });
  const kept=records.filter(l=>['qualified','review'].includes(l.status)&&l.total>=cfg.scoring.min_score).sort((a,b)=>b.total-a.total);
  const fetched=records.filter(l=>l.fetch_status==='ok').length;const status=discovery.search&&discovery.succeeded===0?'failed':selected.length&&fetched===0?'failed':discovery.errors.length||fetched<records.length?'partial':'success';
  const stats={id,date:opts.date||ymd(),generated_at:new Date().toISOString(),status,duration_s:+((Date.now()-started)/1000).toFixed(1),source:discovery.source,mode:discovery.search?'search':'seed',search_terms:searchTerms(cfg),search_ready:searchReady(cfg),queries_planned:discovery.queries.length,queries_succeeded:discovery.succeeded||0,queries_failed:discovery.errors.length,email_finder:emailFinderReady(cfg)?'hunter':'none',candidates:discovery.candidates.length,processed:records.length,fetched,leads:kept.length,qualified:kept.filter(l=>l.status==='qualified').length,review:kept.filter(l=>l.status==='review').length,rejected:records.filter(l=>l.status==='rejected').length,incomplete:records.filter(l=>l.status==='incomplete').length,with_email:kept.filter(l=>l.emails.length).length,with_phone:kept.filter(l=>l.phones.length).length};
  stats.search_languages=discovery.languagePlan?.markets.map(m=>({country:m.country,language:m.language,code:m.code,keywords:m.keywords.map(k=>({original:k.keyword,localized:k.localized,source:k.source}))}))||[];
  stats.search_queries=discovery.queries.map(q=>({query:q.q,country:q.country,language:q.language,gl:q.gl,hl:q.hl}));
  const paths=writeReport({stats,leads:kept,records,cfg,warnings});stats.new_companies=saveRun(cfg,records,{...stats,report_dir:paths.outDir,warnings});
  progress(`完成 · ${status} · 可开发 ${stats.qualified} · 待复核 ${stats.review} · 资料不足 ${stats.incomplete}`);return {stats,...paths,warnings,records};
 }finally{unlock();}
}
