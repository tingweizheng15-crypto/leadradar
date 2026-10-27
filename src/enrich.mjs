import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { ROOT, emailFinderReady } from "./config.mjs";
import { proxiedFetch, resolveProxy, safeUrl, redactError } from "./net.mjs";

const execFileP = promisify(execFile);

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
      ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return "";
}
const CHROME = findChrome();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|example\.com|sentry\.|wixpress\.com|@2x|@3x|no-?reply@|noreply@|placeholder|notifyboost|back-?in-?stock@|pre-?order@|wishlist|appspot|schema\.org|@domain|your@|you@|test@|sentry\.io/i;

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

export const emailDomain = (v) => (String(v).split("@")[1] || "").toLowerCase();

export async function fetchHtml(url, { timeout=8000,maxBytes=1500000,proxy='',signal,allowLocal=false }={}) {
  const res=await proxiedFetch({proxy},url,{signal,maxBytes,publicOnly:!allowLocal,headers:{'User-Agent':UA,Accept:'text/html,application/xhtml+xml'}},timeout);
  if(!res.ok)throw Error(`页面 HTTP ${res.status}`);
  const type=res.headers.get('content-type')||'';if(type&&!/html|text|xml/i.test(type))throw Error('页面不是文本');
  const text=await res.text();if(text.length<80)throw Error('页面内容不足');
  if(/<title[^>]*>\s*(just a moment|access denied|attention required|verify)/i.test(text))throw Error('页面要求浏览器验证');
  return text;
}

function cleanText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function uniq(arr) { return [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))]; }

export function extractEmails(html, pageUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)) {
    const v = m[0].toLowerCase().replace(/[.,]$/, "");
    if (seen.has(v) || JUNK_EMAIL.test(v)) continue;
    seen.add(v);
    out.push({ value: v, source: pageUrl, confidence: "official" });
  }
  return out;
}

function countDigits(s) { return (s.match(/\d/g) || []).length; }

export function extractPhones(html, pageUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<a[^>]+href=["'](tel:[^"']+)["'][^>]*>/gi)) {
    const v = m[1].replace(/^tel:/i, "").trim();
    if (seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, source: pageUrl, confidence: "official" });
  }
  const text = cleanText(html);
  for (const m of text.matchAll(/(?:\+\d[\d\s().\-]{6,15})/g)) {
    const v = m[0].replace(/\s+/g, " ").trim();
    const d = countDigits(v);
    if (d < 7 || d > 15 || seen.has(v)) continue;
    seen.add(v);
    out.push({ value: v, source: pageUrl, confidence: "official" });
  }
  return out.slice(0, 12);
}

const NOISE = new Set(["tr", "share", "sharer", "plugins", "plugin", "dialog", "login", "logout", "watch", "pages", "groups", "profile", "explore", "accounts", "reel", "intent", "home", "widgets", "search", "hashtag", "media", "static", "pslogin", "license", "en", "th", "t", "php", "id", "post", "sdk", "reels", "video"]);

export function classifySocial(url) {
  const u = url.replace(/\/+$/, "");
  const rules = [
    [/instagram\.com\/([a-zA-Z0-9_.]+)/, "instagram"],
    [/facebook\.com\/([a-zA-Z0-9_.]+)/, "facebook"],
    [/tiktok\.com\/@([a-zA-Z0-9_.]+)/, "tiktok"],
    [/linkedin\.com\/(company|school|in)\/([a-zA-Z0-9_.\-]+)/, "linkedin"],
    [/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)/, "x"],
    [/youtube\.com\/(?:@|channel\/|user\/)([a-zA-Z0-9_.\-]+)/, "youtube"],
    [/line\.me\/(?:ti\/p\/|R\/ti\/p\/)?([a-zA-Z0-9_.\-@]+)/, "line"],
    [/lin\.ee\/([a-zA-Z0-9]+)/, "line"],
    [/wa\.me\/([0-9]+)/, "whatsapp"],
    [/api\.whatsapp\.com\/send\?phone=([0-9]+)/, "whatsapp"],
    [/open\.kakao\.com\/([a-zA-Z0-9_.\-]+)/, "kakao"],
    [/plus\.kakao\.com\/([a-zA-Z0-9_.\-]+)/, "kakao"],
    [/pf\.kakao\.com\/([a-zA-Z0-9_.\-]+)/, "kakao"],
  ];
  for (const [re, platform] of rules) {
    const m = u.match(re);
    if (!m) continue;
    const handle = m[platform === "linkedin" ? 2 : 1];
    if (!handle || handle.length < 3 || NOISE.has(handle.toLowerCase()) || /\.php|\.js|\.css|\.png|\.jpg/.test(handle)) return null;
    return { platform, handle, url };
  }
  return null;
}

export function extractSocial(html) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (!c) return;
    const key = `${c.platform}:${c.handle}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  };
  for (const m of html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi)) add(classifySocial(m[1]));
  const re = /(?:https?:\/\/)?(?:www\.)?(instagram\.com\/[a-zA-Z0-9_.]+|facebook\.com\/[a-zA-Z0-9_.]+|tiktok\.com\/@[a-zA-Z0-9_.]+|linkedin\.com\/(?:company|school|in)\/[a-zA-Z0-9_.\-]+|(?:x\.com|twitter\.com)\/[a-zA-Z0-9_]+|youtube\.com\/(?:@|channel\/|user\/)[a-zA-Z0-9_.\-]+|lin\.ee\/[a-zA-Z0-9]+|wa\.me\/[0-9]+)/g;
  for (const m of html.matchAll(re)) add(classifySocial("https://" + m[0].replace(/^https?:\/\/(?:www\.)?/, "")));
  return out;
}

export function detectSignals(html) {
  const text = cleanText(html).toLowerCase();
  const sig = [];
  const rules = [
    [/private label|white label|custom logo|oem|odm|贴牌|代工|定制|주문제작|맞춤|รับผลิต|สั่งทำ|customiz|personaliz|bespoke|your brand|made to order/, "定制/OEM/贴牌需求"],
    [/wholesale|distributor|代理商|도매|ตัวแทนจำหน่าย|wholesale inquiry|제휴|수입/, "批发/分销"],
    [/new arrivals|new drop|coming soon|pre-order|上新|신상품|สินค้าใหม่/, "上新/预售"],
    [/compression|tight|legging|싱글렛|싱글릿|รัดกล้ามเนื้อ|กางเกงวิ่ง/, "压缩/紧身品类"],
    [/running|marathon|runner|วิ่ง|런닝|러닝/, "跑步品类"],
    [/contact|email|문의|ติดต่อ|contact us|get in touch/, "有联系入口"],
    [/factory|made in|manufactur|공장|โรงงาน/, "产地/工厂表述"],
  ];
  for (const [re, label] of rules) if (re.test(text)) sig.push(label);
  return uniq(sig);
}

export function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export function extractAll(html, pageUrl) {
  return {
    emails: extractEmails(html, pageUrl),
    phones: extractPhones(html, pageUrl),
    social: extractSocial(html),
    signals: detectSignals(html),
    title: extractTitle(html),
    text: cleanText(html).slice(0, 3000),
  };
}

export async function emailFinder(cfg,domain,signal){
 if(!emailFinderReady(cfg))return [];
 const h=cfg.contacts.email_finder.hunter;const url=new URL(h.endpoint);url.searchParams.set('domain',domain);url.searchParams.set('api_key',h.apiKey);
 const res=await proxiedFetch(cfg,url,{signal},cfg.search.timeout_ms);if(!res.ok)throw Error(`Hunter HTTP ${res.status}`);const j=await res.json();
 return (j.data?.emails||[]).filter(x=>x.value).map(x=>({value:x.value,source:'https://hunter.io',confidence:'candidate',verification:x.verification?.status||'unknown',type:x.type||''}));
}
export function contactUrls(html,base){
 const origin=new URL(base).origin;const links=[];
 for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
  try{const u=safeUrl(new URL(m[1].replace(/&amp;/g,'&'),base));if(u.origin===origin&&/contact|about|wholesale|문의|ติดต่อ|联系我们|联络/i.test(u.pathname+' '+cleanText(m[2])))links.push(u.href.split('#')[0]);}catch{}
 }
 return uniq([...links,...['/contact','/pages/contact','/about','/wholesale'].map(x=>new URL(x,origin).href)]);
}
export async function enrichSite(cfg,baseUrl,{signal,fetcher=fetchHtml}={}){
 const acc={emails:[],phones:[],social:[],signals:[],title:'',text:'',pages:[],errors:[],fetch_status:'failed',website:baseUrl};
 const origin=safeUrl(baseUrl).origin;let queue=uniq([baseUrl,origin+'/']);const seen=new Set();const maxPages=cfg.contacts.max_pages||4;
 while(queue.length&&seen.size<maxPages){
  signal?.throwIfAborted();const u=queue.shift();if(seen.has(u))continue;seen.add(u);
  try{
   const html=await fetcher(u,{timeout:cfg.contacts.page_timeout_ms,maxBytes:cfg.contacts.max_html_bytes,proxy:resolveProxy(cfg),signal,allowLocal:cfg.__allowLocalTests});
   const e=extractAll(html,u);const at=new Date().toISOString();acc.pages.push({url:u,text:cleanText(html).slice(0,12000),fetched_at:at});
   for(const k of ['emails','phones','social','signals'])acc[k].push(...e[k]);if(!acc.title)acc.title=e.title;
   acc.text=acc.pages.map(x=>x.text).join('\n').slice(0,18000);queue=uniq([...contactUrls(html,u),...queue]).filter(x=>!seen.has(x));
  }catch(e){if(signal?.aborted)throw e;acc.errors.push({url:u,error:redactError(e)});}
 }
 for(const k of ['emails','phones'])acc[k]=[...new Map(acc[k].map(x=>[x.value.toLowerCase(),{...x,confidence:'published',observed_at:new Date().toISOString()}])).values()];
 acc.social=[...new Map(acc.social.map(x=>[x.platform+':'+x.handle.toLowerCase(),x])).values()];acc.signals=uniq(acc.signals);
 if(acc.pages.length){acc.fetch_status='ok';if(!acc.emails.length&&emailFinderReady(cfg)){try{acc.emails.push(...await emailFinder(cfg,domainOf(baseUrl),signal));}catch(e){acc.errors.push({url:baseUrl,error:redactError(e)});}}}
 return acc;
}

