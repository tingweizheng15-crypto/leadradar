#!/usr/bin/env node
/**
 * LeadRadar Daily Runner
 * 每天抓取观察名单的公开页面，判断「今天是否真的更新」，并留下可核对的截图。
 *
 * 用法： node daily/run.mjs [--date YYYY-MM-DD]
 * 输出： daily/out/<date>/report.html | report.md | data.json | leads.csv | screenshots/*.png
 * 状态： daily/state/ledger.json
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from 'node:url';
import {stableContent, freshness as checkedFreshness} from '../src/monitor.mjs';

const execFileP = promisify(execFile);
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAILY = path.join(ROOT, "daily");
const STATE_DIR = path.join(DAILY, "state");
const OUT_ROOT = path.join(DAILY, "out");

const TZ_OFFSET_MIN = 480; // Asia/Shanghai UTC+8
function nowCN() { return new Date(Date.now() + TZ_OFFSET_MIN * 60000); }
function isoCN(d = nowCN()) { return d.toISOString().replace("Z", "+08:00"); }
function ymd(d = nowCN()) { return d.toISOString().slice(0, 10); }
function hhmm(d = nowCN()) { return d.toISOString().slice(11, 16); }

const argDate = (() => {
  const i = process.argv.indexOf("--date");
  return i > -1 ? process.argv[i + 1] : ymd();
})();
if(argDate!==ymd())throw Error('只能采集今天的页面；不能用历史日期标记当前内容。');

const cfg = JSON.parse(fs.readFileSync(path.join(DAILY, "sources.json"), "utf8"));
const ledgerPath = path.join(STATE_DIR, "ledger.json");
fs.mkdirSync(STATE_DIR, { recursive: true });
const hadLedger = fs.existsSync(ledgerPath) && fs.statSync(ledgerPath).size > 2;
const ledger = hadLedger ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : {};
const isBaseline = !hadLedger || Object.keys(ledger).length === 0;

const outDir = path.join(OUT_ROOT, argDate);
const shotDir = path.join(outDir, "screenshots");
fs.mkdirSync(shotDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function urlOf(s) {
  if (s.channel === "instagram") return `https://www.instagram.com/${s.handle}/embed/`;
  if (s.channel === "tiktok") return s.handle.startsWith("tag/")
    ? `https://www.tiktok.com/${s.handle}`
    : `https://www.tiktok.com/@${s.handle}`;
  return s.url;
}

function cleanText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meta(html, re) { const m = html.match(re); return m ? m[1].trim() : ""; }

function tokensOf(text) {
  const set = new Set();
  for (const w of text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(" ")) {
    if (w.length < 2) continue;
    let h = 5381;
    for (let i = 0; i < w.length; i++) h = ((h * 33) ^ w.charCodeAt(i)) >>> 0;
    set.add(h);
    if (set.size >= 8000) break;
  }
  return [...set];
}

function jaccard(a = [], b = []) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function parseCount(v) {
  if (!v) return null;
  const m = String(v).replace(/\s/g, "").match(/([\d.,]+)([KkMm万亿]?)/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ""));
  const u = m[2];
  if (u === "K" || u === "k") n *= 1e3;
  else if (u === "M" || u === "m") n *= 1e6;
  else if (u === "万") n *= 1e4;
  else if (u === "亿") n *= 1e8;
  return Math.round(n);
}

function extract(html, s) {
  const text = cleanText(html);
  const title = meta(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || s.name;
  const desc = meta(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i);

  // 发布日期：JSON-LD / meta / time 标签 / RSS
  const pub =
    meta(html, /"datePublished"\s*:\s*"([^"]+)"/i) ||
    meta(html, /property=["']article:published_time["'][^>]+content=["']([^"']+)/i) ||
    meta(html, /<time[^>]+datetime=["']([^"']+)/i) ||
    meta(html, /<pubDate>([^<]+)<\/pubDate>/i) ||
    "";

  // 社媒指标
  const followers =
    meta(text, /([\d.,]+\s*[KkMm万亿]?)\s*(?:followers|粉丝)/i) ||
    meta(text, /(?:followers|粉丝)\s*([\d.,]+\s*[KkMm万亿]?)/i);
  const posts = meta(text, /([\d.,]+\s*[KkMm]?)\s*(?:posts|帖子|作品)/i);
  const likes = meta(text, /([\d.,]+\s*[KkMm万亿]?)\s*(?:likes|赞)/i);

  // 业务信号（用于判断是否值得跟进）
  const sig = [];
  if (/private label|wholesale|oem|odm|distributor|代理商|ตัวแทนจำหน่าย|도매/i.test(text)) sig.push("批发/OEM 关键词");
  if (/new arrivals|new drop|coming soon|pre-order|上新|신상품|สินค้าใหม่/i.test(text)) sig.push("上新/预售");
  if (/restock|back in stock|재입고|กลับมาสต็อก/i.test(text)) sig.push("补货");
  if (/run club|marathon|race|마라톤|มาราธอน/i.test(text)) sig.push("赛事/跑团");
  if (/made in|factory|공장|โรงงาน/i.test(text)) sig.push("产地/工厂表述");

  // 动态计数（粉丝数、点赞数、浏览数）每次都变，先剔除再哈希，避免「每天都算变化」
  const stable = stableContent(text);
  const hash = crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
  const postNum = parseCount(posts);
  const tokens = tokensOf(stable);

  const missing = /找不到此账号|Sorry, this page isn|page isn.t available|该页面无法显示/i.test(text.slice(0, 4000));

  return { title, desc, text, pub, followers, posts, likes, signals: sig, hash, postNum, tokens, missing };
}

function freshness(pubISO, changed, firstSeenToday) {
  const now = Date.now();
  if (pubISO) {
    const t = Date.parse(pubISO);
    if (!Number.isNaN(t)) {
      const h = (now - t) / 36e5;
      if (h <= 2) return { tier: "T0", label: "2 小时内", basis: "来源发布时间", hours: +h.toFixed(1) };
      if (h <= 24) return { tier: "T1", label: "24 小时内", basis: "来源发布时间", hours: +h.toFixed(1) };
      if (h <= 72) return { tier: "T2", label: "3 天内", basis: "来源发布时间", hours: +h.toFixed(1) };
      return { tier: "T3", label: "超过 3 天", basis: "来源发布时间", hours: +h.toFixed(1) };
    }
  }
  if (changed) return { tier: "T1", label: "今日有变化", basis: "内容哈希与昨日不同", hours: null };
  if (firstSeenToday) return { tier: "T1", label: "今日首次纳入", basis: "观察名单新增", hours: null };
  return { tier: "T3", label: "无变化", basis: "内容哈希与上次一致", hours: null };
}

async function chromeDom(url, channel) {
  const budgets = [8000, 12000, 16000];
  let lastErr;
  for (let i = 0; i < budgets.length; i++) {
    try {
      const { stdout } = await execFileP(CHROME, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars",
        `--virtual-time-budget=${budgets[i]}`, "--dump-dom", url,
      ], { maxBuffer: 60 * 1024 * 1024, timeout: 60000 });
      const ok =
        stdout && stdout.length > 20000 &&
        (channel !== "instagram" || /(粉丝|followers|帖子|posts)/i.test(stdout)) &&
        (channel !== "tiktok" || /(粉丝|followers|作品|videos)/i.test(stdout));
      if (ok) return stdout;
      lastErr = new Error(`dom not ready (len=${stdout ? stdout.length : 0})`);
    } catch (e) { lastErr = e; }
    await sleep(1200);
  }
  throw lastErr;
}

async function chromeShot(url, file) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await execFileP(CHROME, [
        "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--window-size=1200,1150", "--virtual-time-budget=12000",
        `--screenshot=${file}`, url,
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 75000 });
      if (fs.existsSync(file) && fs.statSync(file).size > 5000) return true;
    } catch (e) { /* 重试一次 */ }
    await sleep(1200);
  }
  return false;
}

const results = [];
const startedAt = Date.now();

for (const s of cfg.watchlist) {
  const url = urlOf(s);
  const rec = {
    id: s.id, name: s.name, channel: s.channel, country: s.country, type: s.type,
    products: s.products, url, fetched_at: isoCN(), status: "ok", error: "",
    title: "", followers: "", posts: "", likes: "", signals: [], pub: "",
    hash: "", change: "unchanged", first_seen: "", screenshot: "", tier: "", tierLabel: "", basis: "",
  };
  try {
    const html = await chromeDom(url, s.channel);
    const e = extract(html, s);
    Object.assign(rec, {
      title: e.title, followers: e.followers, posts: e.posts, likes: e.likes,
      signals: e.signals, pub: e.pub, hash: e.hash, missing: e.missing,
    });
    if (e.missing) { rec.status = "missing"; }

    const prev = ledger[s.id];
    const isNew = !prev;
    const postsChanged = !!(prev && e.postNum != null && prev.last_posts != null && e.postNum > prev.last_posts);
    rec.postsChanged = postsChanged;
    rec.postDiff = postsChanged ? `${prev.last_posts} → ${e.postNum}` : "";
    const sim = prev?.last_tokens ? jaccard(prev.last_tokens, e.tokens) : 1;
    rec.similarity = +sim.toFixed(3);

    let contentChanged = false;
    let policy = "";
    if (s.channel === "instagram") {
      // IG 页面的粉丝数/点赞数一直在变，只有帖子数变化才算新增
      policy = "只看帖子数";
      contentChanged = false;
      rec.changeNote = postsChanged ? `帖子 ${rec.postDiff}` : "帖子数未变";
    } else if (s.channel === "tiktok") {
      if (s.type === "hashtag") {
        policy = "话题页为动态流，只做参考";
        rec.changeNote = "话题页每次加载内容不同，不计入新增";
      } else {
        policy = "只看作品数";
        rec.changeNote = postsChanged ? "作品数变化" : "作品数未变";
      }
    } else {
      policy = "词集合相似度阈值 0.96";
      contentChanged = !!prev && !!prev.last_tokens && sim < 0.96;
      rec.changeNote = contentChanged ? `内容相似度 ${rec.similarity}` : "内容基本一致";
    }

    const publicationChanged = !!prev && e.pub && e.pub !== prev.last_pub && Date.parse(e.pub) <= Date.now() && Date.now()-Date.parse(e.pub)<72*36e5;
    const changed = !!prev && !e.missing && (contentChanged || publicationChanged || (s.type !== "hashtag" && postsChanged));
    rec.change = isNew ? "new" : changed ? "changed" : "unchanged";
    rec.policy = policy;
    rec.first_seen = prev?.first_seen || argDate;

    const f = checkedFreshness(e.pub, changed, isNew);
    rec.tier = f.tier; rec.tierLabel = f.label; rec.basis = f.basis; rec.pubHours = f.hours;

    const file = path.join(shotDir, `${s.channel}-${s.id}.png`);
    try {
      rec.screenshot = (await chromeShot(url, file))
        ? "screenshots/" + path.basename(file)
        : "";
    } catch (e) {
      rec.screenshot = "";
      rec.shotError = String(e.message || e).slice(0, 120);
    }

    if(!e.missing) ledger[s.id] = {
      first_seen: rec.first_seen,
      last_hash: e.hash,
      last_posts: e.postNum ?? prev?.last_posts ?? null,
      last_pub: e.pub || prev?.last_pub || '',
      last_tokens: e.tokens,
      last_changed: changed || isNew ? argDate : prev?.last_changed || argDate,
      last_seen: argDate,
    };
  } catch (err) {
    rec.status = "error";
    rec.error = String(err.message || err).slice(0, 200);
  }
  results.push(rec);
  console.log(`${rec.status.padEnd(7)} ${rec.tier || "-"}  ${rec.change.padEnd(9)} ${s.channel.padEnd(9)} ${s.name}`);
  await sleep(300);
}

fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");

// 今日新增 = 首次纳入或内容变化，且新鲜度在 3 天内
const fresh = results.filter((r) => r.status === "ok" && ["T0", "T1", "T2"].includes(r.tier));
const todays = fresh.filter((r) => r.change !== "unchanged");
const unchanged = results.filter((r) => r.status === "ok" && r.change === "unchanged");
const errors = results.filter((r) => r.status !== "ok");

const stats = {
  date: argDate, generated_at: isoCN(), duration_s: +((Date.now() - startedAt) / 1000).toFixed(1),
  total: results.length, fresh: fresh.length, new_or_changed: todays.length,
  unchanged: unchanged.length, errors: errors.length, baseline: isBaseline,
  by_channel: results.reduce((a, r) => { a[r.channel] = (a[r.channel] || 0) + 1; return a; }, {}),
};

fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify({ stats, results }, null, 2), "utf8");

// ---------- CSV ----------
const head = ["公司", "渠道", "国家", "买家类型", "需求商品", "今日变化", "新鲜度", "判定依据", "发布时间", "粉丝数", "帖子数", "业务信号", "页面标题", "来源链接", "截图", "抓取时间"];
const csv = [head.join(",")].concat(results.map((r) => [
  r.name, r.channel, r.country, r.type, r.products, r.change, r.tierLabel, r.basis,
  r.pub, r.followers, r.posts, (r.signals || []).join(" / "), r.title, r.url, r.screenshot, r.fetched_at,
].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")));
fs.writeFileSync(path.join(outDir, "leads.csv"), "\ufeff" + csv.join("\r\n"), "utf8");

// ---------- Markdown ----------
const md = [];
md.push(`# 获客日报 ${argDate}`, "");
md.push(`生成时间：${isoCN()}　耗时：${stats.duration_s}s`, "");
md.push(`- 观察名单：${stats.total} 个来源（IG ${stats.by_channel.instagram || 0} / TikTok ${stats.by_channel.tiktok || 0} / 官网 ${stats.by_channel.website || 0}）`);
md.push(isBaseline ? `- 本次为基线建库：${stats.new_or_changed} 个来源首次纳入（不是「今天新增」，明天起按变化判定）` : `- 今日新增或变化：**${stats.new_or_changed}**`);
md.push(`- 无变化：${stats.unchanged}　异常：${stats.errors}`, "");
md.push("## 今日新增 / 变化", "");
md.push("| 公司 | 渠道 | 变化 | 新鲜度 | 依据 | 粉丝 | 信号 | 截图 |");
md.push("|---|---|---|---|---|---|---|---|");
for (const r of todays) {
  md.push(`| ${r.name} | ${r.channel} | ${r.change === "new" ? "首次纳入" : "内容变化"} | ${r.tierLabel} | ${r.basis} | ${r.followers || "—"} | ${(r.signals || []).join("、") || "—"} | ${r.screenshot ? "有" : "无"} |`);
}
md.push("", "## 无变化（不计入今日新增）", "");
for (const r of unchanged) md.push(`- ${r.name}（${r.channel}）— 哈希未变，${r.fetched_at}`);
if (errors.length) { md.push("", "## 异常", ""); for (const r of errors) md.push(`- ${r.name}（${r.channel}）：${r.status} ${r.error}`); }
fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n"), "utf8");

// ---------- HTML ----------
const brief = await (async () => {
  try {
    const p = path.join(outDir, "brief.json");
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
  } catch { return null; }
})();

const badge = (t) => t === "T0" ? "#be123c" : t === "T1" ? "#e11d48" : t === "T2" ? "#f59e0b" : "#94a3b8";
const card = (r, i) => `
  <div class="item">
    <div class="shot">${r.screenshot ? `<img src="${r.screenshot}" alt="${r.name}">` : `<div class="noshot">未截到图<br><span>${r.status === "error" ? "访问失败" : "页面不可渲染"}</span></div>`}</div>
    <div class="meta">
      <div class="top"><b>${r.name}</b><span class="ch">${r.channel}</span>
        <span class="tier" style="background:${badge(r.tier)}">${r.tier} ${r.tierLabel}</span></div>
      <div class="kv">${r.country} · ${r.type} · ${r.change === "new" ? "首次纳入" : r.change === "changed" ? (r.postsChanged ? `帖子数变化 ${r.postDiff}` : "页面内容有变化") : "无变化"}</div>
      <div class="kv">粉丝 ${r.followers || "—"}　帖子 ${r.posts || "—"}　赞 ${r.likes || "—"}</div>
      <div class="sig">${(r.signals || []).map((s) => `<span>${s}</span>`).join("") || "<span class='dim'>无明显信号</span>"}</div>
      <div class="kv dim">判定依据：${r.basis}　${r.policy || ""}${r.changeNote ? `（${r.changeNote}）` : ""}　抓取：${r.fetched_at}</div>
      <a class="link" href="${r.url}" target="_blank" rel="noopener">查看原页面 ↗</a>
    </div>
  </div>`;

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>获客日报 ${argDate}</title>
<style>
:root{--ink:#0f172a;--ink2:#475569;--ink3:#94a3b8;--line:#e6e9ef;--bg:#f5f6f8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:14px;line-height:1.6}
.wrap{max-width:1180px;margin:0 auto;padding:28px 24px 60px}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.5px}
.sub{color:var(--ink2);font-size:13px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.kpi .k{font-size:11px;color:var(--ink3)}.kpi .v{font-size:26px;font-weight:700;letter-spacing:-1px}
.kpi.hot .v{color:#e11d48}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px}
h2{font-size:14px;margin:0 0 12px}
.item{display:grid;grid-template-columns:300px 1fr;gap:16px;padding:14px 0;border-bottom:1px solid #f1f4f8}
.item:last-child{border-bottom:none}
.shot img{width:100%;border-radius:9px;border:1px solid var(--line);display:block}
.noshot{height:180px;display:grid;place-items:center;background:#f8fafc;border:1px dashed var(--line);border-radius:9px;color:var(--ink3);font-size:12px;text-align:center}
.noshot span{font-size:10px}
.top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px}
.top b{font-size:15px}
.ch{font-size:10px;background:#0f172a;color:#fff;padding:2px 7px;border-radius:4px;text-transform:uppercase}
.tier{font-size:10px;color:#fff;padding:2px 8px;border-radius:99px}
.kv{font-size:12px;color:var(--ink2);margin-top:3px}
.dim{color:var(--ink3)}
.sig{margin:7px 0}
.sig span{display:inline-block;font-size:10.5px;background:#fff1f4;color:#be123c;padding:2px 7px;border-radius:5px;margin:2px 4px 2px 0}
.link{font-size:12px;color:#be123c;text-decoration:none;display:inline-block;margin-top:6px}
.brief{background:#0f172a;color:#fff;border-radius:14px;padding:16px 18px;margin-bottom:16px}
.brief h3{margin:0 0 8px;font-size:13px;color:#fda4af}
.brief li{font-size:12.5px;color:#e2e8f0;margin-bottom:5px}
.foot{font-size:11px;color:var(--ink3);line-height:1.8;margin-top:8px}
@media(max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}.item{grid-template-columns:1fr}}
</style></head><body><div class="wrap">
<h1>获客日报 · ${argDate}</h1>
<div class="sub">生成于 ${isoCN()}　·　观察名单 ${stats.total} 个公开来源　·　耗时 ${stats.duration_s}s${isBaseline ? "　·　<b>本次为基线建库</b>" : ""}</div>

<div class="kpis">
  <div class="kpi hot"><div class="k">今日新增 / 变化</div><div class="v">${stats.new_or_changed}</div></div>
  <div class="kpi"><div class="k">新鲜数据（≤3天）</div><div class="v">${stats.fresh}</div></div>
  <div class="kpi"><div class="k">无变化</div><div class="v">${stats.unchanged}</div></div>
  <div class="kpi"><div class="k">异常来源</div><div class="v">${stats.errors}</div></div>
  <div class="kpi"><div class="k">截图留存</div><div class="v">${results.filter(r=>r.screenshot).length}</div></div>
</div>

${brief ? `<div class="brief"><h3>今日判断摘要</h3><ul>${brief.points.map(p=>`<li>${p}</li>`).join("")}</ul></div>` : ""}

<div class="card">
  <h2>${isBaseline ? "基线建库（首次纳入）" : "今日新增 / 变化"}（${todays.length}）</h2>
  ${todays.map(card).join("") || `<div class="dim" style="font-size:13px">${isBaseline ? "基线为空。" : "今日没有检测到新内容。"}所有来源哈希与上次一致——这本身就是结论：今天没有值得跟的新线索，不要为了交差重复发信。</div>`}
</div>

<div class="card">
  <h2>全部来源核对（${results.length}）— 每条都可点开截图比对</h2>
  <div class="foot" style="margin:-6px 0 10px">按「今日有变化 → 无变化 → 异常」排序。无变化的来源也保留截图，方便你确认系统确实抓到了页面，而不是漏抓。</div>
  ${[...results].sort((a,b)=> (b.change==="changed") - (a.change==="changed") || (a.status==="ok"?0:1)-(b.status==="ok"?0:1)).map(card).join("")}
</div>

${errors.length ? `<div class="card"><h2>异常（${errors.length}）</h2>
  <table style="width:100%;font-size:12px;border-collapse:collapse">
  ${errors.map(r=>`<tr><td style="padding:6px 0;width:180px"><b>${r.name}</b></td><td>${r.channel}</td><td style="color:#b91c1c">${r.status} ${r.error}</td></tr>`).join("")}
  </table></div>` : ""}

<div class="foot">
判定规则：优先使用页面自带的发布时间（JSON-LD / meta / time / RSS）；没有发布时间时，用「内容哈希是否与上一次不同」判定今日是否变化；两者都没有则记为无变化，不计入今日新增。<br>
截图核对：每条记录都保存了抓取时刻的页面截图与原链接；截图只覆盖无需登录即可访问的公开页面，登录后才可见的内容不做抓取。Instagram 的部分账号会弹出「注册以查看更多」浮层，属平台对未登录访问的默认行为，截图仍可证明页面与账号存在，细节请点原链接核对。<br>
本报告只做信息采集与判断，不发送任何消息。
</div>
</div></body></html>`;

const reportPath = path.join(outDir, "report.html");
if (fs.existsSync(reportPath)) {
  try { fs.copyFileSync(reportPath, path.join(outDir, `report-${hhmm().replace(/:/g, "")}.html`)); } catch {}
}
fs.writeFileSync(reportPath, html, "utf8");

console.log(`\n✔ ${argDate} 完成：新增/变化 ${stats.new_or_changed} / 新鲜 ${stats.fresh} / 无变化 ${stats.unchanged} / 异常 ${stats.errors}`);
console.log(`  ${path.join(outDir, "report.html")}`);
