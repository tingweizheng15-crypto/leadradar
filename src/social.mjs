import {fetchHtml,enrichSite,extractAll} from './enrich.mjs';
import {resolveProxy,safeUrl} from './net.mjs';
const reserved=new Set(['p','reel','reels','explore','accounts','stories','share','sharer','login','watch','groups','search','tag','video','videos','profile.php']);
export function parseSocialUrl(value){try{const u=safeUrl(value);const h=u.hostname.replace(/^(www|m)\./,'');const platform=({'instagram.com':'instagram','tiktok.com':'tiktok','facebook.com':'facebook'})[h]||'';const part=u.pathname.split('/').filter(Boolean)[0]||'';const handle=platform==='tiktok'?(part.startsWith('@')?part.slice(1):''):part;if(!platform||!handle||reserved.has(handle.toLowerCase())||!/^[-\w.]+$/.test(handle))return {platform:'',handle:''};return {platform,handle:handle.toLowerCase()};}catch{return {platform:'',handle:''};}}
export const isSocialUrl=url=>Boolean(parseSocialUrl(url).platform);
export function isSocialHost(value){try{return /(^|\.)(instagram\.com|tiktok\.com|facebook\.com)$/.test(new URL(value).hostname);}catch{return false;}}
export async function enrichSocial(cfg,url,{signal,fetcher=fetchHtml}={}){
 const {platform,handle}=parseSocialUrl(url);if(!platform)throw Error('不是有效品牌社媒主页');
 const profile=platform==='instagram'?`https://www.instagram.com/${handle}/embed/`:url;
 const html=await fetcher(profile,{proxy:resolveProxy(cfg),timeout:cfg.contacts.page_timeout_ms,signal});const data=extractAll(html,url);
 if(/log in|sign up/i.test(data.title)&&data.text.length<1500)throw Error('社媒主页需要登录，无法核实资料');
 const acc={...data,fetch_status:'ok',pages:[{url,text:data.text,fetched_at:new Date().toISOString()}],errors:[],social:[{platform,handle,url},...data.social]};
 for(const m of html.matchAll(/href=["']([^"']+)["']/gi)){
  try{let target=new URL(m[1].replace(/&amp;/g,'&'),url);if(/^(l\.instagram\.com|l\.facebook\.com)$/.test(target.hostname))target=new URL(target.searchParams.get('u'));safeUrl(target);if(isSocialHost(target)||/facebook|instagram|tiktok|meta\.com|cdn|google|apple|privacy|terms/.test(target.hostname+target.pathname))continue;
   const site=await enrichSite(cfg,target.href,{signal,fetcher});if(site.fetch_status!=='ok')continue;
   for(const k of ['emails','phones','social','signals','pages','errors'])acc[k].push(...site[k]);acc.website=target.href;acc.text+='\n'+site.text;break;
  }catch(e){if(signal?.aborted)throw e;}
 }
 return acc;
}
export function buildSocialQueries(cfg){const prod={compression_tights:'compression tights',running_singlet:'running singlet',running_shorts:'running shorts',quick_dry:'quick dry shirt'};return cfg.products.flatMap(p=>cfg.markets.flatMap(c=>['instagram','tiktok'].map(platform=>({q:`site:${platform}.com ${prod[p]||p} ${c}`,product:p,country:c,type:'brand',social:true}))));}
