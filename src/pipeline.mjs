import fs from "node:fs";
import path from "node:path";
import { loadConfig, searchReady, emailFinderReady, llmReady, ROOT } from "./config.mjs";
import { search, providerName } from "./search.mjs";
import { enrichSite, domainOf } from "./enrich.mjs";
import { scoreLead, dedupeByDomain, recompute, TYPES } from "./score.mjs";
import { analyzeLead } from "./llm.mjs";
import { enrichSocial, isSocialUrl, buildSocialQueries, parseSocialUrl } from "./social.mjs";
import { buildQueries } from "./query.mjs";
import { writeReport, notify, ymd } from "./report.mjs";

export { buildQueries };


function countryOf(text) {
  const m = { KR: /韩国|Korea|서울|首尔|Seoul/i, TH: /泰国|Thailand|Bangkok|曼谷/i, US: /美国|USA|United States/i, UK: /英国|UK|United Kingdom/i, ID: /印尼|Indonesia|Jakarta|雅加达/i, MY: /马来|Malaysia|Kuala Lumpur|吉隆坡/i };
  for (const [k, re] of Object.entries(m)) if (re.test(text)) return k;
  return "";
}

function tldCountry(url) {
  const h = domainOf(url);
  if (!h) return "";
  if (/\.kr$/.test(h)) return "KR";
  if (/\.(co\.)?th$/.test(h)) return "TH";
  if (/\.(co\.)?id$/.test(h)) return "ID";
  if (/\.my$/.test(h)) return "MY";
  if (/\.(co\.)?uk$/.test(h)) return "UK";
  return "";
}

// 平台站 / 目录站 / 登录墙站点：自动流水线一律不碰。
// linkedin 是刻意排除的——个人主页在登录墙后，自动抓取既违反条款也拿不到可用信息；
// LinkedIn 只在 lead-radar/social-sourcing.html 里当人工找人工具用，两条链路不混。
const NOISE_RE = /(^|\.)(alibaba|aliexpress|made-in-china|globalsources|tradeindia|indiamart|dhgate|amazon|ebay|etsy|shopee|lazada|tokopedia|walmart|yellowpages|yelp|manta|kompass|europages|importyeti|panjiva|reddit|quora|pinterest|wikipedia|linkedin|twitter|youtube|google|bing)\./i;

function isNoiseUrl(url) {
  const h = domainOf(url);
  return !h || NOISE_RE.test(h);
}

function seedLeads(cfg) {
  const seeds = [];
  const seen = new Set();

  const srcPath = path.join(ROOT, "daily", "sources.json");
  if (fs.existsSync(srcPath)) {
    const src = JSON.parse(fs.readFileSync(srcPath, "utf8"));
    for (const s of src.watchlist || []) {
      if (s.channel !== "website") continue;
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      seeds.push({ name: s.name, url: s.url, country: s.country, type: s.type, products: (s.products || "").split(";"), evidence: "directory" });
    }
  }

  const wmPath = path.join(ROOT, "wm-report.json");
  if (fs.existsSync(wmPath)) {
    const wm = JSON.parse(fs.readFileSync(wmPath, "utf8"));
    const sec = (wm.sections || []).find((s) => (s.heading || "").includes("官网"));
    for (const row of sec?.table?.rows || []) {
      const name = row[0];
      const site = row[1];
      const url = typeof site === "object" ? site.url : (typeof site === "string" && /^https?:/.test(site) ? site : "");
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const country = countryOf(`${name} ${row[2] || ""} ${row[3] || ""}`);
      seeds.push({ name: String(name).split("（")[0].trim(), url, country, type: "", products: cfg.products, evidence: "news" });
    }
  }
  return seeds;
}

export async function discover(cfg) {
  if (searchReady(cfg)) {
    const candidates = [];
    const seen = new Set();
    const failures = [];
    const plan = buildQueries(cfg);
    const queries = plan.queries.slice();
    if (cfg.search.include_social !== false) queries.push(...buildSocialQueries(cfg));
    // 全局截断：社媒检索式也是要花钱的 API 调用，必须一起吃进预算
    const max = cfg.search.max_queries_per_run || 30;
    const planned = queries.slice(0, max);
    if (queries.length > planned.length) {
      console.log(`  [预算] 检索式 ${plan.generated} 条${plan.custom ? `（含自定义 ${plan.custom} 条）` : ""} + 社媒 ${queries.length - plan.queries.length} 条，按 max_queries_per_run=${max} 截断到 ${planned.length} 条`);
    }
    for (const q of planned) {
      try {
        const results = await search(cfg, q.q, cfg.search.results_per_query);
        for (const r of results || []) {
          if (isNoiseUrl(r.url)) continue;
          const dom = isSocialUrl(r.url) ? `${parseSocialUrl(r.url).platform}:${parseSocialUrl(r.url).handle}` : domainOf(r.url);
          if (!dom || seen.has(dom)) continue;
          seen.add(dom);
          const tld = tldCountry(r.url);
          let country, countrySource;
          if (tld) { country = tld; countrySource = "tld"; }
          else {
            const kw = countryOf(`${r.title || ""} ${r.snippet || ""}`);
            if (kw) { country = kw; countrySource = "keyword"; }
            else { country = q.country; countrySource = "query_guess"; }
          }
          candidates.push({ name: r.title, url: r.url, snippet: r.snippet, domain: dom, country, countrySource, type: q.type, products: [q.product], evidence: isSocialUrl(r.url) ? "social" : "search" });
        }
      } catch (e) {
        // 单条查询失败继续，但必须留下证据——否则 key 失效会产出一份「0 候选」的漂亮日报
        failures.push(`${q.q} → ${String(e.message || e).slice(0, 90)}`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    return { candidates, source: providerName(cfg), search: true, queries: planned.length, failed: failures.length, failures };
  }
  const seeds = seedLeads(cfg);
  return { candidates: seeds, source: "本地样本库（未配置搜索 key，仅官网/社媒公开信息）", search: false, queries: 0, failed: 0, failures: [] };
}

export async function runPipeline(cfg, opts = {}) {
  const startedAt = Date.now();
  const warnings = [];
  const emailFinder = emailFinderReady(cfg) ? cfg.contacts.email_finder.provider : "none";

  if (!searchReady(cfg)) warnings.push("未配置搜索 API key：当前使用本地样本库的官网/社媒抓取联系方式。填好 config.json 或 .env 中的 key 后即为真实全网搜索。");
  if (!emailFinderReady(cfg) && cfg.contacts.email_finder.provider !== "none") warnings.push("邮箱查找 API 未配置 key，仅使用官网公开邮箱。");
  if (!llmReady(cfg)) warnings.push("未配置大模型 key：当前为规则评分，无 AI 判断与开发信草稿。填 LLM_API_KEY 后自动启用。");

  const d = await discover(cfg);
  const { candidates, source } = d;
  if (d.failed && d.queries && d.failed >= d.queries) {
    warnings.push(`搜索 ${d.failed}/${d.queries} 条全部失败：报告为空不代表没有客户，先检查 API key / 余额 / 代理。首条错误：${d.failures[0]}`);
  } else if (d.failed) {
    warnings.push(`搜索 ${d.failed}/${d.queries} 条失败（少部分查询被跳过，结果可能不全）：${d.failures.slice(0, 3).join("；")}`);
  }
  if (d.search && !candidates.length) warnings.push("搜索已就绪但 0 条候选：多为检索式太窄或结果被噪声域名过滤，建议放宽市场/商品组合。");
  const max = cfg.report.max_candidates_per_run;
  const leads = [];

  // 超时兜底：一定要 clearTimeout，否则每个候选都会留一个 45s 的空定时器，
  // 全部跑完后进程还要多挂 40 多秒才退出（定时器下一次排程会被拖后）。
  const withTimeout = (p, ms, fallback) => {
    let timer;
    const guard = new Promise((r) => { timer = setTimeout(() => r(fallback), ms); });
    return Promise.race([p, guard]).finally(() => clearTimeout(timer));
  };

  const aiFailures = [];

  for (const c of candidates.slice(0, max)) {
    try {
      const social = isSocialUrl(c.url);
      const en = await withTimeout(social ? enrichSocial(cfg, c.url) : enrichSite(cfg, c.url), 45000, null);
      const lead = {
        name: en?.title ? en.title.slice(0, 60) : c.name,
        url: c.url,
        domain: c.domain || domainOf(c.url),
        country: c.country || countryOf(c.name + " " + (c.snippet || "")),
        countrySource: c.countrySource || "",
        type: c.type,
        products: c.products || cfg.products,
        evidence: c.evidence || (social ? "social" : "search"),
        emails: en?.emails || [],
        phones: en?.phones || [],
        social: en?.social || [],
        signals: en?.signals || [],
        text: en?.text || "",
        snippet: c.snippet || "",
        fetched_at: new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00"),
      };
      scoreLead(lead, cfg);

      if (llmReady(cfg)) {
        const ai = await analyzeLead(cfg, lead);
        if (ai && !ai.parse_error && !ai.error && ai.is_buyer !== undefined) {
          lead.ai = ai;
          if (Number.isFinite(Number(ai.oem_need))) lead.scores.oem = Math.max(0, Math.min(13, Number(ai.oem_need)));
          if (ai.buyer_type && TYPES[ai.buyer_type]) {
            lead.type = ai.buyer_type;
            lead.typeLabel = TYPES[ai.buyer_type].label;
            lead.scores.role = TYPES[ai.buyer_type].role;
          }
          if (ai.is_buyer === false) lead.scores.product = Math.min(lead.scores.product, 5);
          lead.ai_fit = ai.fit || "";
          lead.draft = ai.draft || "";
          lead.contact_hint = ai.contact_hint || "";
          lead.language = ai.language || "";
          recompute(lead);
        } else {
          // AI 失败不能静默：否则用户只会看到「没有开发信」，却不知道是地址/模型/余额错了
          const why = ai?.error || (ai?.parse_error ? "返回内容不是合法 JSON" : "空响应");
          aiFailures.push(`${lead.name || lead.url}：${String(why).slice(0, 260)}`);
        }
      }

      leads.push(lead);
      console.log(`  [${lead.total}] ${lead.name}　邮箱${lead.emails.length} 电话${lead.phones.length} 社媒${lead.social.length}${lead.draft ? "　AI✓" : ""}`);
    } catch (e) {
      warnings.push(`${c.name || c.url}：抓取失败 ${String(e.message || e).slice(0, 80)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const deduped = dedupeByDomain(leads);
  const kept = deduped.filter((l) => l.total >= (cfg.scoring.min_score ?? 60));
  kept.sort((a, b) => b.total - a.total);

  if (aiFailures.length) {
    warnings.push(`大模型 ${aiFailures.length} 条调用失败，本次没有 AI 判断与开发信。首条原因：${aiFailures[0]}`);
  }

  const stats = {
    date: opts.date || ymd(),
    generated_at: new Date(Date.now() + 8 * 3600e3).toISOString().replace("Z", "+08:00"),
    duration_s: +((Date.now() - startedAt) / 1000).toFixed(1),
    source,
    search_ready: searchReady(cfg),
    search_queries: d.queries || 0,
    search_failed: d.failed || 0,
    email_finder: emailFinder,
    candidates: candidates.length,
    leads: kept.length,
    qualified: kept.filter((l) => l.status === "qualified").length,
    review: kept.filter((l) => l.status === "review").length,
    with_email: kept.filter((l) => (l.emails || []).length).length,
    with_phone: kept.filter((l) => (l.phones || []).length).length,
  };

  const { outDir, reportPath } = writeReport({ stats, leads: kept, cfg, warnings });
  return { stats, outDir, reportPath, warnings };
}
