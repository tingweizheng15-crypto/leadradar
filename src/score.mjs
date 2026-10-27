import {targetProducts} from './search-terms.mjs';
export const PRODUCTS={compression_tights:'压缩裤',running_singlet:'跑步背心',running_shorts:'跑步短裤',quick_dry:'速干衣'};
export const COUNTRIES={KR:'韩国',TH:'泰国',US:'美国',UK:'英国',ID:'印尼',MY:'马来西亚'};
export const TYPES={brand:{label:'自有品牌',role:20},distributor:{label:'进口分销',role:19},retail:{label:'专业零售',role:17},event:{label:'赛事/跑团',role:15},manufacturer:{label:'制造商',role:0},unknown:{label:'角色待核验',role:0}};
export const statusLabel=s=>({qualified:'可开发',review:'待复核',rejected:'已排除',incomplete:'资料不足',conflict:'判断冲突'})[s]||s;
export const statusOf=n=>n>=80?'qualified':n>=60?'review':'incomplete';
export function recompute(lead){
 lead.total=Math.min(100,Math.max(0,Math.round(Object.values(lead.scores||{}).reduce((a,b)=>a+b,0))));
 if(lead.fetch_status!=='ok')lead.status='incomplete';
 else if(lead.ai?.is_buyer===false||lead.type==='manufacturer')lead.status='rejected';
 else if(lead.ai?.conflict)lead.status='conflict';
 else if(!lead.overlap?.length||lead.type==='unknown')lead.status='incomplete';
 else lead.status=statusOf(lead.total);
 if(lead.status!=='qualified')lead.draft='';lead.statusLabel=statusLabel(lead.status);return lead;
}
export function scoreLead(lead,cfg){
 lead.type=lead.verified_type||'unknown';lead.typeLabel=TYPES[lead.type]?.label||'待核验';
 const targets=targetProducts(cfg);lead.overlap=(lead.verified_products||[]).filter(x=>targets.includes(x));lead.products=lead.verified_products||[];
 const ok=lead.fetch_status==='ok';const n=lead.overlap.length;
 lead.scores={product:ok?(n>=3?25:n===2?20:n===1?15:0):0,role:ok?(TYPES[lead.type]?.role||0):0,geo:ok&&cfg.markets.includes(lead.country)&&['tld','page'].includes(lead.countrySource)?10:0,readiness:ok?Math.min(12,3+(lead.social?.length?3:0)+(lead.emails?.length||lead.phones?.length?6:0)):0,activity:Math.min(10,(lead.events||[]).filter(x=>x.published_at&&Date.now()-Date.parse(x.published_at)>=0&&Date.now()-Date.parse(x.published_at)<30*86400e3).length*5),oem:ok&&lead.seeks_supplier?13:0,evidence:ok&&lead.evidence_items?.length?10:0};
 lead.score_version='3.0-evidence';lead.oem=lead.scores.oem;return recompute(lead);
}
export function dedupeByDomain(leads){const m=new Map();for(const l of leads){const key=l.domain||l.url;if(!m.has(key)){m.set(key,l);continue;}const old=m.get(key);for(const k of ['emails','phones','social','evidence_items','pages'])old[k]=[...new Map([...(old[k]||[]),...(l[k]||[])].map(x=>[JSON.stringify(x),x])).values()];old.verified_products=[...new Set([...(old.verified_products||[]),...(l.verified_products||[])])];}return [...m.values()];}
