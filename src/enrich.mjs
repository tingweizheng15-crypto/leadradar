import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";
import { proxiedFetch, resolveProxy } from "./net.mjs";

const execFileP = promisify(execFile);

export function findChrome() {
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
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return "";
}
export const CHROME = findChrome();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", euro: "€", pound: "£", yen: "¥" };

/** 解码 HTML 实体：标题里常见 &amp; &ndash; &#8211; 这类，直接进 CSV 会变成脏数据 */
export function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
function safeFromCode(code) {
  try { return String.fromCodePoint(code); } catch { return ""; }
}

const JUNK_EMAIL = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|example\.com|sentry\.|wixpress\.com|@2x|@3x|no-?reply@|noreply@|placeholder|notifyboost|back-?in-?stock@|pre-?order@|wishlist|appspot|schema\.org|@domain|your@|you@|test@|sentry\.io/i;

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); }
  catch { return ""; }
}

export const emailDomain = (v) => (String(v).split("@")[1] || "").toLowerCase();

export async function fetchHtml(url, { timeout = 8000, maxBytes = 1500000, useChrome = false, proxy = "" } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await proxiedFetch({ proxy }, url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" } }, timeout);
    const text = await res.text();
    clearTimeout(t);
    if (!res.ok || !text || text.length <= 300) throw new Error(`empty(${text ? text.length : 0})`);
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  } catch {
    if (!useChrome) return "";
    try {
      const { stdout } = await execFileP(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--virtual-time-budget=8000", "--dump-dom", url], { maxBuffer: 30 * 1024 * 1024, timeout: 30000 });
      if (stdout && stdout.length > 300) return stdout.length > maxBytes ? stdout.slice(0, maxBytes) : stdout;
    } catch { /* 忽略 */ }
    return "";
  }
}

function cleanText(html) {
  return decodeEntities(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim());
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

/** "+662-117-1300 09" 这种是「电话 + 营业时间」粘在一起，尾部时间片要切掉 */
function stripTrailingTime(v) {
  const m = v.match(/^(.*?)\s+(\d{1,2})(?::\d{2})?$/);
  if (m && countDigits(m[1]) >= 8) return m[1].trim();
  return v;
}

export function extractPhones(html, pageUrl) {
  const raw = [];
  for (const m of html.matchAll(/<a[^>]+href=["'](tel:[^"']+)["'][^>]*>/gi)) raw.push(m[1].replace(/^tel:/i, "").trim());
  const text = cleanText(html);
  for (const m of text.matchAll(/(?:\+\d[\d\s().\-]{6,15})/g)) raw.push(m[0].replace(/\s+/g, " ").trim());

  // 按「纯数字」去重：同一个号可能同时以 +6621171300 / +662-117-1300 / +662-117-1300 09 出现
  const byDigits = new Map();
  for (const v0 of raw) {
    const v = stripTrailingTime(v0);
    const d = (v.match(/\d/g) || []).join("");
    if (d.length < 7 || d.length > 15) continue;
    const prev = byDigits.get(d);
    // 同号保留写法更干净的那个（非数字字符更少）
    if (!prev || (v.match(/[^\d]/g) || []).length < (prev.match(/[^\d]/g) || []).length) byDigits.set(d, v);
  }
  return [...byDigits.values()].slice(0, 12).map((value) => ({ value, source: pageUrl, confidence: "official" }));
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
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
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

// 邮箱查找服务同样要走代理：国内直连 api.hunter.io / api.snov.io 经常超时，
// 而操作台的「测试 key」走代理、流水线走直连，就会出现「测通了跑不通」的假象。
async function finderJson(cfg, url, opts = {}) {
  const ctrl = new AbortController();
  const timeout = cfg.search.timeout_ms || 15000;
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await proxiedFetch(cfg, url, { ...opts, signal: ctrl.signal }, timeout);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

async function hunter(cfg, domain) {
  const h = cfg.contacts.email_finder.hunter;
  const url = `${h.endpoint}?domain=${encodeURIComponent(domain)}&api_key=${encodeURIComponent(h.apiKey)}`;
  const data = await finderJson(cfg, url);
  return (data.data?.emails || []).map((e) => ({ value: e.value, source: "hunter", confidence: "candidate", type: e.type || "" }));
}

async function snov(cfg, domain) {
  const s = cfg.contacts.email_finder.snov;
  const url = `${s.endpoint}?domain=${encodeURIComponent(domain)}&userId=${encodeURIComponent(s.userId)}&secret=${encodeURIComponent(s.secret)}`;
  const data = await finderJson(cfg, url);
  return Object.values(data.emails || {}).map((e) => ({ value: e.email, source: "snov", confidence: "candidate", type: e.type || "" }));
}

async function apollo(cfg, domain) {
  const a = cfg.contacts.email_finder.apollo;
  const data = await finderJson(cfg, a.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": a.apiKey },
    body: JSON.stringify({ q_organization_domains: domain, page: 1, per_page: 10 }),
  });
  return (data.people || []).map((p) => ({ value: p.email, source: "apollo", confidence: "candidate", name: p.name, title: p.title })).filter((e) => e.value);
}

export async function emailFinder(cfg, domain) {
  const p = cfg.contacts.email_finder.provider;
  if (!domain) return [];
  try {
    if (p === "hunter") return await hunter(cfg, domain);
    if (p === "snov") return await snov(cfg, domain);
    if (p === "apollo") return await apollo(cfg, domain);
  } catch (e) {
    return [{ value: "", source: p, confidence: "candidate", error: String(e.message || e).slice(0, 100) }];
  }
  return [];
}

export async function enrichSite(cfg, baseUrl) {
  const host = domainOf(baseUrl);
  const acc = { emails: [], phones: [], social: [], signals: [], title: "", text: "" };
  const seen = new Set();
  const pages = cfg.contacts.pages_to_try || [""];
  const pageTimeout = cfg.contacts.page_timeout_ms ?? 8000;
  const maxBytes = cfg.contacts.max_html_bytes ?? 1500000;
  const useChrome = !!cfg.contacts.use_chrome_fallback;
  for (const p of pages) {
    if (acc.emails.length && acc.phones.length && acc.social.length) break;
    let u;
    try {
      u = p ? new URL((p.startsWith("http") ? p : `${baseUrl.replace(/\/+$/, "")}/${p}`)).toString() : baseUrl;
    } catch { continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    const html = await fetchHtml(u, { timeout: pageTimeout, maxBytes, useChrome, proxy: resolveProxy(cfg) });
    if (!html) continue;
    const e = extractAll(html, u);
    for (const k of ["emails", "phones", "social"]) acc[k].push(...e[k]);
    acc.signals.push(...e.signals);
    if (!acc.title) acc.title = e.title;
    if (!acc.text) acc.text = e.text;
  }
  const rawEmails = uniq(acc.emails.map((e) => e.value)).map((v) => ({ value: v, source: host, confidence: "official" }));
  const sameDomain = rawEmails.filter((e) => emailDomain(e.value) === host);
  acc.emails = sameDomain.length ? sameDomain : rawEmails;
  acc.phones = uniq(acc.phones.map((e) => e.value)).map((v) => ({ value: v, source: host, confidence: "official" }));
  acc.social = [...new Map(acc.social.map((s) => [`${s.platform}:${s.handle}`, s])).values()];
  acc.signals = uniq(acc.signals);

  let found = acc.emails;
  const ef = await emailFinder(cfg, host);
  if (Array.isArray(ef)) {
    for (const item of ef) {
      if (!item || !item.value) continue;
      if (!acc.emails.some((e) => e.value.toLowerCase() === item.value.toLowerCase())) found.push(item);
    }
  }
  acc.emails = found;
  return acc;
}
