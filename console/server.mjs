#!/usr/bin/env node
/**
 * LeadRadar 操作台（本地）
 *   node console/server.mjs          默认 http://127.0.0.1:7788
 * 只监听 127.0.0.1，不对外暴露；所有命令都在项目目录内执行。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadEnvFile, ROOT, searchReady, llmReady, emailFinderReady } from "../src/config.mjs";
import { providerName, search } from "../src/search.mjs";
import { findChrome } from "../src/enrich.mjs";
import { jobsOf, parseHms, nextRunEpoch, fmt } from "../src/schedule.mjs";
import { jobCommand, IS_SEA } from "../src/runner.mjs";
import { buildQueries, allocateQueries, effectiveTerms, DEFAULTS } from "../src/query.mjs";
import { buildSocialQueries } from "../src/social.mjs";
import { seenStats, loadSeen } from "../src/store.mjs";
import { isNoiseUrl } from "../src/pipeline.mjs";
import { isSocialUrl, parseSocialUrl } from "../src/social.mjs";
import { PLATFORMS, profileState, launchLogin, checkLogin, loginStatus } from "../src/browser.mjs";
import { fetchProfile } from "../src/socialfetch.mjs";
import { translateKeywords } from "../src/translate.mjs";

/** 操作台预览要用和流水线完全一致的预算分配，否则显示的条数是假的 */
function queryPlan(cfg) {
  const plan = buildQueries(cfg, { full: true });
  const social = cfg.search.include_social !== false ? buildSocialQueries(cfg) : [];
  const alloc = allocateQueries(plan.queries, social, cfg.search.max_queries_per_run || 30, {
    socialRatio: cfg.search.social_ratio,
  });
  return { plan, alloc };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";
const PORT = Number(process.env.LR_PORT || 7788);

const KINDS = {
  pipeline: { script: "run.mjs", label: "获客流水线", args: [] },
  daily: { script: "daily/run.mjs", label: "每日采集", args: [] },
  doctor: { script: "doctor.mjs", label: "环境体检", args: [] },
  doctorLive: { script: "doctor.mjs", label: "联网实测", args: ["--live"] },
  next: { script: "scheduler.mjs", label: "下次运行时间", args: ["--next"] },
  scheduler: { script: "scheduler.mjs", label: "定时器（常驻）", args: [], longRunning: true },
};

const ENV_KEYS = ["SEARCH_PROVIDER", "SERPER_API_KEY", "BING_API_KEY", "GOOGLE_CSE_KEY", "GOOGLE_CSE_CX", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_MAX_TOKENS", "HUNTER_API_KEY", "APOLLO_API_KEY", "SNOV_USER_ID", "SNOV_SECRET", "CHROME_PATH", "HTTPS_PROXY"];
// 这些不是秘密，页面要回显真实值（否则用户不知道自己当前用的是哪个 provider / 模型）
const PLAIN_KEYS = new Set(["SEARCH_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "HTTPS_PROXY", "CHROME_PATH"]);
const MASK = "••••••";

let jobSeq = 0;
const jobs = new Map();
let lastJobId = null;

function runningJob() {
  for (const j of jobs.values()) if (j.status === "running") return j;
  return null;
}

function startJob(kind, opts = {}) {
  const def = KINDS[kind];
  if (!def) throw new Error("未知任务类型");
  const busy = runningJob();
  if (busy && !def.longRunning) throw new Error(`已有任务在跑：${busy.label}`);

  const id = ++jobSeq;
  const job = {
    id, kind, label: def.label + (opts.ignoreDedupe ? "（忽略去重）" : ""), status: "running",
    startedAt: Date.now(), endedAt: null, code: null, lines: [],
    ignoreDedupe: !!opts.ignoreDedupe,
  };
  jobs.set(id, job);
  lastJobId = id;
  while (jobs.size > 20) jobs.delete([...jobs.keys()][0]);

  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  // 只对本次任务生效，不写进配置：忘记关掉也不会让每天的定时任务天天重发老面孔
  if (opts.ignoreDedupe) env.LR_IGNORE_DEDUPE = "1";
  const jc = jobCommand(kind);
  const child = spawn(jc.cmd, jc.args, {
    cwd: ROOT,
    env,
    windowsHide: true,
  });
  job.child = child;

  const push = (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.lines.push(line);
      if (job.lines.length > 3000) job.lines.shift();
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "failed";
    job.code = code;
    job.endedAt = Date.now();
    job.child = null;
  });
  child.on("error", (e) => {
    job.lines.push("启动失败：" + e.message);
    job.status = "failed";
    job.endedAt = Date.now();
  });
  return job;
}

function stopJob() {
  const job = runningJob();
  if (!job) return false;
  try { job.child?.kill(); } catch { /* ignore */ }
  job.status = "stopped";
  job.endedAt = Date.now();
  return true;
}

function listReports() {
  const roots = [
    { kind: "获客日报", dir: path.join(ROOT, "out") },
    { kind: "每日采集", dir: path.join(ROOT, "daily", "out") },
  ];
  const out = [];
  for (const { kind, dir } of roots) {
    if (!fs.existsSync(dir)) continue;
    for (const day of fs.readdirSync(dir)) {
      const rp = path.join(dir, day, "report.html");
      if (!fs.existsSync(rp)) continue;
      const st = fs.statSync(rp);
      const shots = fs.existsSync(path.join(dir, day, "screenshots")) ? fs.readdirSync(path.join(dir, day, "screenshots")).length : 0;
      out.push({
        kind, date: day,
        rel: path.relative(ROOT, rp).replace(/\\/g, "/"),
        mtime: st.mtime.getTime(), shots,
      });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function countSources() {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(ROOT, "daily", "sources.json"), "utf8")).watchlist || [];
    return w.reduce((a, s) => { a[s.channel] = (a[s.channel] || 0) + 1; return a; }, {});
  } catch { return {}; }
}

function statusPayload() {
  const cfg = loadConfig();
  const env = loadEnvFile();
  const proxy = cfg.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const jobsList = jobsOf(cfg).map((j) => {
    const next = nextRunEpoch(parseHms(j.time), j.tz);
    return { key: j.key, name: j.name, time: j.time, enabled: j.enabled, tz: j.tz, nextText: fmt(next, j.tz), nextInMs: next - Date.now() };
  });
  const job = lastJobId ? jobs.get(lastJobId) : null;
  return {
    packaged: IS_SEA,
    autoSchedule: process.env.LR_AUTOSCHED === "1",
    keys: {
      search: searchReady(cfg), searchProvider: searchReady(cfg) ? providerName(cfg) : "未配置",
      llm: llmReady(cfg), llmModel: llmReady(cfg) ? cfg.llm.model : "未配置",
      emailFinder: emailFinderReady(cfg),
    },
    chrome: findChrome() || "",
    proxy,
    files: { config: fs.existsSync(path.join(ROOT, "config.json")), env: fs.existsSync(path.join(ROOT, ".env")) },
    envKeys: Object.keys(env).length,
    schedules: jobsList,
    sources: countSources(),
    reports: listReports().slice(0, 8),
    running: runningJob() ? { id: runningJob().id, label: runningJob().label, kind: runningJob().kind } : null,
    job: job ? { id: job.id, kind: job.kind, label: job.label, status: job.status, code: job.code, lines: job.lines.length, startedAt: job.startedAt, endedAt: job.endedAt } : null,
  };
}

function maskEnv() {
  const env = loadEnvFile();
  const out = {};
  for (const k of ENV_KEYS) {
    const v = env[k] || "";
    out[k] = !v ? "" : PLAIN_KEYS.has(k) ? v : (v.length <= 8 ? MASK : v.slice(0, 4) + MASK + v.slice(-2));
  }
  return out;
}

function saveEnv(updates) {
  const p = path.join(ROOT, ".env");
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : [];
  const applied = [];
  for (const [k, raw] of Object.entries(updates)) {
    if (!ENV_KEYS.includes(k)) continue;
    const v = String(raw ?? "").trim();
    if (!v || v.includes(MASK)) continue;          // 空值 / 掩码占位：不动原值
    const idx = lines.findIndex((l) => l.trim().startsWith(k + "="));
    if (idx > -1) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
    applied.push(k);
  }
  if (applied.length) {
    const body = lines.filter((l, i) => l !== "" || i < lines.length - 1).join("\n");
    fs.writeFileSync(p, body.endsWith("\n") ? body : body + "\n", "utf8");
  }
  return applied;
}

const ALLOWED_EXT = new Set([".html", ".md", ".csv", ".json", ".png", ".txt", ".log"]);

/* ---------------- 检索词配置 ---------------- */

const TERM_KEYS = ["product_terms", "country_terms", "buyer_terms"];
const MAX_Q = 200;

function readWritableConfig() {
  const cfgPath = path.join(ROOT, "config.json");
  const exPath = path.join(ROOT, "config.example.json");
  const src = fs.existsSync(cfgPath) ? cfgPath : exPath;
  return JSON.parse(fs.readFileSync(src, "utf8"));
}

function cleanStr(v, max = 160) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeQueriesPatch(body) {
  const out = {};
  for (const key of TERM_KEYS) {
    const src = body[key];
    if (!src || typeof src !== "object") continue;
    const allowed = Object.keys(DEFAULTS[key] || {});
    const map = {};
    for (const k of allowed) {
      const v = cleanStr(src[k]);
      if (v) map[k] = v;          // 空值 = 用回默认词
    }
    out[key] = map;
  }
  if (Array.isArray(body.query_templates)) {
    out.query_templates = body.query_templates.map((t) => cleanStr(t, 200)).filter(Boolean).slice(0, 10);
  }
  if (Array.isArray(body.custom_queries)) {
    out.custom_queries = body.custom_queries.map((t) => cleanStr(t, 200)).filter(Boolean).slice(0, 100);
  }
  if (body.custom_mode === "append" || body.custom_mode === "replace") out.custom_mode = body.custom_mode;
  if (body.max_queries_per_run != null) {
    out.max_queries_per_run = Math.min(MAX_Q, Math.max(1, Number(body.max_queries_per_run) || 30));
  }
  return out;
}

function saveQueries(patch, reset = false) {
  const cfg = readWritableConfig();
  cfg.search = cfg.search || {};
  if (reset) {
    // 恢复默认 = 把这张卡片控制的字段全部丢掉，回到内置词表 + 上限 30
    for (const k of [...TERM_KEYS, "query_templates", "custom_queries", "custom_mode", "max_queries_per_run"]) delete cfg.search[k];
    cfg.search.max_queries_per_run = 30;
  } else {
    for (const [k, v] of Object.entries(patch)) cfg.search[k] = v;
  }
  fs.writeFileSync(path.join(ROOT, "config.json"), JSON.stringify(cfg, null, 2), "utf8");
  return cfg;
}


function serveFile(res, rel) {
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) return send(res, 403, "text/plain; charset=utf-8", "forbidden");
  if (!ALLOWED_EXT.has(path.extname(abs).toLowerCase())) return send(res, 403, "text/plain; charset=utf-8", "forbidden type");
  if (!fs.existsSync(abs)) return send(res, 404, "text/plain; charset=utf-8", "not found");
  const ext = path.extname(abs).toLowerCase();
  const type = ext === ".html" ? "text/html; charset=utf-8"
    : ext === ".png" ? "image/png"
      : ext === ".json" ? "application/json; charset=utf-8"
        : "text/plain; charset=utf-8";
  res.writeHead(200, { "Content-Type": type + (ext === ".png" ? "" : "") });
  fs.createReadStream(abs).pipe(res);
}

function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const remote = req.socket.remoteAddress || "";
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) return send(res, 403, "text/plain; charset=utf-8", "local only");

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const ui = path.join(__dirname, "ui.html");
      return send(res, 200, "text/html; charset=utf-8", fs.readFileSync(ui, "utf8"));
    }
    if (url.pathname === "/api/status") return send(res, 200, "application/json", JSON.stringify(statusPayload()));
    if (url.pathname === "/api/reports") return send(res, 200, "application/json", JSON.stringify(listReports()));
    if (url.pathname === "/api/env" && req.method === "GET") return send(res, 200, "application/json", JSON.stringify(maskEnv()));

    // ---------- 社媒登录态 ----------
    if (url.pathname === "/api/social/status" && req.method === "GET") {
      const login = await loginStatus();
      return send(res, 200, "application/json", JSON.stringify({
        profile: profileState(),
        login,
        platforms: Object.entries(PLATFORMS).map(([k, v]) => ({ key: k, name: v.name, url: v.url, loggedIn: login ? !!login[k] : null })),
      }));
    }

    if (url.pathname === "/api/social/login" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = launchLogin(body.platform || "instagram");
        return send(res, 200, "application/json", JSON.stringify(r));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    if (url.pathname === "/api/social/check" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const list = body.platforms || Object.keys(PLATFORMS);
        const out = [];
        for (const p of list) out.push(await checkLogin(p));
        return send(res, 200, "application/json", JSON.stringify({ ok: true, results: out, profile: profileState() }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    if (url.pathname === "/api/social/fetch" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const platform = String(body.platform || "").toLowerCase();
        const handle = String(body.handle || "").replace(/^@/, "").trim();
        if (!platform || !handle) return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "需要 platform 和 handle" }));
        const r = await fetchProfile(platform, handle);
        return send(res, 200, "application/json", JSON.stringify(r));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    // 试跑检索词：只看搜到谁，不抓官网、不写报告、不进去重库
    if (url.pathname === "/api/queries/preview" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const cfg = loadConfig();
        if (!searchReady(cfg)) {
          return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "搜索 key 未配置，试跑只对真实搜索有效" }));
        }
        const raw = (Array.isArray(body.queries) ? body.queries : []).map((s) => String(s || "").trim()).filter(Boolean);
        const limit = Math.min(10, Math.max(1, Number(body.limit) || 5));
        // 借用 buildQueries 的国家/产品识别，保证 gl 参数和正式跑一致
        const tmpCfg = { ...cfg, search: { ...cfg.search, custom_queries: raw, custom_mode: "replace", query_templates: [] } };
        const plan = buildQueries(tmpCfg, { full: true });
        const list = plan.queries.slice(0, limit);
        if (!list.length) return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "没有可试跑的检索式" }));
        const seenMap = loadSeen() || {};
        const items = [];
        for (const it of list) {
          const rows = await search(cfg, it.q, cfg.search.results_per_query, { country: it.country });
          items.push({
            q: it.q,
            country: it.country || "",
            results: (rows || []).map((r) => {
              let host = "";
              try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { /* 坏 URL 当空 */ }
              // 和正式跑用同一套判定：平台/噪声域名丢弃；社媒帖子页（无账号名）也丢；
              // 社媒主页按 platform:handle 记，才算可用线索
              const sp = isSocialUrl(r.url) ? parseSocialUrl(r.url) : null;
              const kind = isNoiseUrl(r.url) ? "noise"
                : (sp && (!sp.platform || !sp.handle)) ? "social-home"
                : sp ? "social"
                : "site";
              const key = kind === "social" ? `${sp.platform}:${sp.handle}` : host;
              return {
                domain: host,
                label: kind === "social" ? `${sp.platform}:${sp.handle}` : host,
                title: String(r.title || "").slice(0, 70),
                kind,
                seen: Object.prototype.hasOwnProperty.call(seenMap, key)
                  || Object.prototype.hasOwnProperty.call(seenMap, host)
                  || Object.prototype.hasOwnProperty.call(seenMap, `www.${host}`),
              };
            }),
          });
          await new Promise((r) => setTimeout(r, 150));
        }
        const kept = items.reduce((n, x) => n + x.results.filter((r) => (r.kind === "site" || r.kind === "social") && !r.seen).length, 0);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, items, kept, spent: items.length, seenTotal: seenStats().total }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    // 中文关键词 → 目标国家本地语检索词
    if (url.pathname === "/api/queries/translate" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const cfg = loadConfig();
        const r = await translateKeywords(cfg, body.chinese || "", body.markets || cfg.markets);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
      }
    }

    if (url.pathname === "/api/queries" && req.method === "GET") {
      const cfg = loadConfig();
      const { plan, alloc } = queryPlan(cfg);
      return send(res, 200, "application/json", JSON.stringify({
        terms: effectiveTerms(cfg),
        defaults: DEFAULTS,
        preview: alloc.queries.slice(0, 15),
        count: alloc.queries.length,
        generated: alloc.bodyTotal + alloc.socialTotal,
        truncated: Math.max(0, alloc.bodyTotal + alloc.socialTotal - alloc.queries.length),
        custom: plan.custom,
        mode: plan.mode,
        budget: alloc.budget,
        bodyCount: alloc.bodyCount,
        socialCount: alloc.socialCount,
        bodyTotal: alloc.bodyTotal,
        socialTotal: alloc.socialTotal,
        seen: seenStats().total,
      }));
    }

    if (url.pathname === "/api/queries" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.reset === true) saveQueries({}, true);
      else saveQueries(normalizeQueriesPatch(body));
      const cfg = loadConfig();
      const { plan, alloc } = queryPlan(cfg);
      return send(res, 200, "application/json", JSON.stringify({
        ok: true,
        terms: effectiveTerms(cfg),
        preview: alloc.queries.slice(0, 15),
        count: alloc.queries.length,
        generated: alloc.bodyTotal + alloc.socialTotal,
        truncated: Math.max(0, alloc.bodyTotal + alloc.socialTotal - alloc.queries.length),
        custom: plan.custom,
        mode: plan.mode,
        budget: alloc.budget,
        bodyCount: alloc.bodyCount,
        socialCount: alloc.socialCount,
        bodyTotal: alloc.bodyTotal,
        socialTotal: alloc.socialTotal,
        seen: seenStats().total,
      }));
    }

    if (url.pathname === "/api/job" && req.method === "GET") {
      const id = Number(url.searchParams.get("id") || lastJobId || 0);
      const job = jobs.get(id);
      if (!job) return send(res, 200, "application/json", JSON.stringify({ id: 0, status: "idle", lines: [] }));
      return send(res, 200, "application/json", JSON.stringify({
        id: job.id, kind: job.kind, label: job.label, status: job.status, code: job.code,
        startedAt: job.startedAt, endedAt: job.endedAt, lines: job.lines,
      }));
    }

    if (url.pathname === "/api/run" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        const job = startJob(body.kind, { ignoreDedupe: !!body.ignoreDedupe });
        return send(res, 200, "application/json", JSON.stringify({ ok: true, id: job.id }));
      } catch (e) {
        return send(res, 409, "application/json", JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
      return send(res, 200, "application/json", JSON.stringify({ ok: stopJob() }));
    }

    if (url.pathname === "/api/env" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const applied = saveEnv(body);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, applied }));
    }

    if (url.pathname === "/view") {
      return serveFile(res, url.searchParams.get("p") || "");
    }

    return send(res, 404, "text/plain; charset=utf-8", "not found");
  } catch (e) {
    return send(res, 500, "text/plain; charset=utf-8", String(e.message || e));
  }
});

server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  const url = `http://${HOST}:${PORT}`;
  console.log("");
  console.log(IS_SEA ? "LeadRadar 已启动，关闭此窗口即停止服务" : "LeadRadar 操作台已启动");
  console.log(`地址：${url}`);
  console.log(`数据目录：${ROOT}`);
  console.log(`搜索 key：${searchReady(cfg) ? "已配置" : "未配置（点击页面顶部提示去填写）"}　大模型：${llmReady(cfg) ? "已配置" : "未配置"}　Chrome：${findChrome() ? "就绪" : "缺失"}`);
  console.log("");
  if (process.env.LR_OPEN === "1") openBrowser(url + "#setup");

  // EXE 模式下内置定时器：窗口开着就按 09:30 / 10:00 自动跑，关窗口即停
  if (process.env.LR_AUTOSCHED === "1") {
    console.log("已启动内置定时器（09:30 每日采集 / 10:00 获客流水线），关闭窗口即停止。");
    console.log("");
    import(pathToFileURL(path.join(ROOT, "scheduler.mjs")).href)
      .catch((e) => console.error("定时器启动失败：" + (e.message || e)));
  }
});

function openBrowser(url) {
  try {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}
