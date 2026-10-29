#!/usr/bin/env node
/**
 * LeadRadar 操作台（本地）
 *   node console/server.mjs          默认 http://127.0.0.1:7788
 * 只监听 127.0.0.1，不对外暴露；所有命令都在项目目录内执行。
 */
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadEnvFile, ROOT, searchReady, llmReady, emailFinderReady } from "../src/config.mjs";
import { proxiedFetch } from "../src/net.mjs";
import { providerName, search } from "../src/search.mjs";
import { findChrome } from "../src/enrich.mjs";
import { jobsOf, parseHms, nextRunEpoch, fmt } from "../src/schedule.mjs";
import { jobCommand, IS_SEA } from "../src/runner.mjs";
import { buildQueries, allocateQueries, effectiveTerms, DEFAULTS } from "../src/query.mjs";
import { buildSocialQueries } from "../src/social.mjs";
import { seenStats, loadSeen } from "../src/store.mjs";
import { isNoiseUrl } from "../src/pipeline.mjs";
import { isSocialUrl, parseSocialUrl } from "../src/social.mjs";
import { PLATFORMS, profileState, launchLogin, checkLogin, loginStatus, dumpDom } from "../src/browser.mjs";
import { fetchProfile } from "../src/socialfetch.mjs";
import { translateKeywords } from "../src/translate.mjs";
import {
  MAIL_PRESETS, MAIL_GUIDES, FINDER_PROVIDERS, finderProvider, mailPreset, guideFor,
  smtpConfig, smtpLogin, verifyAddresses, sendMail, testFinder, guessSmtpHost,
} from "../src/mailer.mjs";
import { googleCreds, googleStatus, buildAuthUrl, completeAuth, withGmailAuth } from "../src/googleoauth.mjs";

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

const ENV_KEYS = [
  "SEARCH_PROVIDER", "SERPER_API_KEY", "BING_API_KEY", "GOOGLE_CSE_KEY", "GOOGLE_CSE_CX",
  "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "LLM_MAX_TOKENS",
  "HUNTER_API_KEY", "APOLLO_API_KEY", "SNOV_USER_ID", "SNOV_SECRET", "EMAIL_FINDER_PROVIDER",
  "SMTP_USER", "SMTP_PASS", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_FROM", "SMTP_NAME",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_ACCOUNT_EMAIL",
  "CHROME_PATH", "HTTPS_PROXY",
];
// 这些不是秘密，页面要回显真实值（否则用户不知道自己当前用的是哪个 provider / 模型）
const PLAIN_KEYS = new Set([
  "SEARCH_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "HTTPS_PROXY", "CHROME_PATH",
  "EMAIL_FINDER_PROVIDER", "SMTP_USER", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_FROM", "SMTP_NAME",
  "GOOGLE_CLIENT_ID", "GOOGLE_ACCOUNT_EMAIL",
]);
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
  const env = mailEnv();
  const proxy = cfg.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  const sm = smtpConfig(env);
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
    mail: {
      finderProvider: cfg.contacts.email_finder.provider || "none",
      finderReady: emailFinderReady(cfg),
      smtpReady: sm.ready,
      smtpUser: sm.user,
      google: googleStatus(env),
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

function maskOf(v) {
  const s = String(v || "");
  if (!s) return "";
  return s.length <= 8 ? MASK : s.slice(0, 4) + MASK + s.slice(-2);
}

function maskEnv() {
  const env = loadEnvFile();
  const out = {};
  for (const k of ENV_KEYS) {
    const v = env[k] || "";
    out[k] = !v ? "" : PLAIN_KEYS.has(k) ? v : maskOf(v);
  }
  return out;
}

function saveEnv(updates) {
  const p = path.join(ROOT, ".env");
  const lines = fs.existsSync(p) ? fs.readFileSync(p, "utf8").split(/\r?\n/) : [];
  // 文件末尾的空行先去掉，否则每保存一次就多一行空白
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
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

function removeEnvKeys(keys) {
  const p = path.join(ROOT, ".env");
  if (!fs.existsSync(p)) return [];
  const before = fs.readFileSync(p, "utf8").split(/\r?\n/);
  const after = before.filter((l) => !keys.some((k) => l.trim().startsWith(k + "=")));
  if (after.length !== before.length) {
    fs.writeFileSync(p, after.join("\n").replace(/\n+$/, "") + "\n", "utf8");
  }
  return keys.filter((k) => before.some((l) => l.trim().startsWith(k + "=")));
}

const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

/* ---------------- 代理自检 ---------------- */

// 常见本地代理端口：Clash(7897/7890)、V2Ray(10809/10808)、SS(1080)、其他(8889/8080…)
const PROXY_PORTS = [7897, 7890, 10809, 10808, 1080, 8889, 8080, 4780, 6152, 20171, 8888];

function tcpAlive(port, host = "127.0.0.1", ms = 450) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (ok) => { if (done) return; done = true; try { s.destroy(); } catch { /* ignore */ } resolve(ok); };
    s.once("connect", () => fin(true));
    s.once("error", () => fin(false));
    s.setTimeout(ms, () => fin(false));
  });
}

async function proxyWorks(port) {
  try {
    // __noDirect：检测时必须真的走这个端口，不能靠「直连能通」蒙混过关
    const r = await proxiedFetch({ proxy: `http://127.0.0.1:${port}` }, "https://www.google.com/generate_204", { __noDirect: true }, 6000);
    return r.status >= 200 && r.status < 400;
  } catch { return false; }
}

const ALLOWED_EXT = new Set([".html", ".md", ".csv", ".json", ".png", ".txt", ".log"]);

/* ---------------- 邮箱配置 ---------------- */

// 登录/测试结果只放内存：重启后要重新点一次「登录测试」，避免拿着过期的结论骗自己
let lastSmtpLogin = null;
let lastFinderTest = null;

const FINDER_ENV = {
  hunterKey: "HUNTER_API_KEY",
  apolloKey: "APOLLO_API_KEY",
  snovUserId: "SNOV_USER_ID",
  snovSecret: "SNOV_SECRET",
};

function mailEnv() {
  // .env 优先：页面写进去的值必须立刻生效，不能被系统环境变量盖掉
  return { ...process.env, ...loadEnvFile() };
}

function finderCreds(cfg) {
  const ef = cfg.contacts.email_finder || {};
  return {
    apiKey: ef[ef.provider]?.apiKey || "",
    userId: ef.snov?.userId || "",
    secret: ef.snov?.secret || "",
  };
}

function smtpPayload(env) {
  const sm = smtpConfig(env);
  const preset = sm.user ? mailPreset(sm.user) : null;
  const g = googleStatus(env);
  const isGmail = /@(gmail|googlemail)\.com$/i.test(sm.user || "");
  const oauthReady = isGmail && g.authorized;
  return {
    user: sm.user,
    host: sm.host,
    port: sm.port,
    secure: sm.secure,
    from: sm.from,
    name: sm.name,
    passSet: !!sm.pass,
    // 有 OAuth 时不需要密码也算就绪
    ready: !!sm.user && !!sm.host && (!!sm.pass || oauthReady),
    oauth: { isGmail, ready: oauthReady, configured: g.configured, authorized: g.authorized, email: g.email },
    preset: preset ? { domain: preset.domain, hint: preset.hint, web: preset.web, guessed: !!preset.guessed, guide: preset.guide || "other" } : null,
  };
}

function mailStatePayload() {
  const cfg = loadConfig();
  const env = mailEnv();
  return {
    ok: true,
    finder: {
      provider: cfg.contacts.email_finder.provider || "none",
      ready: emailFinderReady(cfg),
      providers: FINDER_PROVIDERS,
      keys: {
        HUNTER_API_KEY: maskOf(env.HUNTER_API_KEY),
        APOLLO_API_KEY: maskOf(env.APOLLO_API_KEY),
        SNOV_USER_ID: env.SNOV_USER_ID || "",
        SNOV_SECRET: maskOf(env.SNOV_SECRET),
      },
      lastTest: lastFinderTest,
    },
    smtp: smtpPayload(env),
    lastLogin: lastSmtpLogin,
    presets: MAIL_PRESETS,
    guides: MAIL_GUIDES,
    google: {
      ...googleStatus(env),
      clientId: env.GOOGLE_CLIENT_ID || "",
      hasSecret: !!env.GOOGLE_CLIENT_SECRET,
    },
  };
}

/** 已保存的发信配置（含 Gmail OAuth 令牌），发信/验证都用它 */
async function smtpForSend() {
  const env = mailEnv();
  const base = smtpConfig(env);
  const g = googleStatus(env);
  const gmail = /@(gmail|googlemail)\.com$/i.test(base.user || "");
  if (!base.user || !base.host || (!base.pass && !(gmail && g.authorized))) {
    const err = new Error("还没登录邮箱：填邮箱 + 授权码（Gmail 可以直接点「用 Google 账号授权」），先点「登录测试」");
    err.code = "NOT_READY";
    throw err;
  }
  return await withGmailAuth(loadConfig(), base, env);
}

/** 把「表单上的发信配置」解析成可用的 SMTP 参数：留空的字段回落到已保存的值 */
function resolveSmtpInput(body, env) {
  const cur = smtpConfig(env);
  const user = cleanStr(body.user, 120) || cur.user;
  const preset = user ? mailPreset(user) : null;
  const pass = String(body.pass ?? "").trim() || cur.pass;
  const host = cleanStr(body.host, 120) || cur.host || preset?.host || "";
  const port = Number(body.port) || cur.port || preset?.port || 465;
  const mode = String(body.secure ?? "").toLowerCase();
  const secure = mode === "ssl" || mode === "1" || mode === "true" ? true
    : mode === "starttls" || mode === "0" || mode === "false" ? false
      : port === 465;
  return {
    user, pass, host, port, secure,
    from: user,
    name: cleanStr(body.name, 60) || cur.name,
  };
}

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

    // 代理软件端口经常变，让工具自己找一遍：先看端口开着，再用它访问 Google 验证真能出去
    if (url.pathname === "/api/proxy/detect" && req.method === "POST") {
      const alive = (await Promise.all(PROXY_PORTS.map(async (p) => ((await tcpAlive(p)) ? p : 0)))).filter(Boolean);
      const checked = await Promise.all(alive.map(async (p) => ({ port: p, ok: await proxyWorks(p) })));
      const working = checked.filter((x) => x.ok).map((x) => x.port);
      return send(res, 200, "application/json", JSON.stringify({
        ok: true,
        candidates: alive,
        working,
        suggested: working[0] ? `http://127.0.0.1:${working[0]}` : "",
        note: working.length
          ? "找到一个能访问 Google 的代理，已填好"
          : (alive.length
            ? "端口开着，但都出不去（代理软件没开规则 / 没连上节点）"
            : "没发现本地代理端口。先打开你的代理软件（Clash / V2Ray 等），再点一次"),
      }));
    }

    // ---------- 邮箱：查找服务 + 发信邮箱 ----------
    if (url.pathname === "/api/mail/state" && req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(mailStatePayload()));
    }

    // ---------- Gmail OAuth（不依赖应用密码） ----------
    if (url.pathname === "/api/mail/google/status" && req.method === "GET") {
      const env = mailEnv();
      return send(res, 200, "application/json", JSON.stringify({
        ok: true,
        ...googleStatus(env),
        clientId: env.GOOGLE_CLIENT_ID || "",
        hasSecret: !!env.GOOGLE_CLIENT_SECRET,
      }));
    }

    if (url.pathname === "/api/mail/google/config" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const updates = {};
      const cid = cleanStr(body.clientId, 240);
      const sec = String(body.clientSecret ?? "").trim();
      if (cid) updates.GOOGLE_CLIENT_ID = cid;
      if (sec && !sec.includes(MASK)) updates.GOOGLE_CLIENT_SECRET = sec;
      const applied = saveEnv(updates);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, applied, ...googleStatus(mailEnv()) }));
    }

    if (url.pathname === "/api/mail/google/start" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const c = googleCreds(mailEnv());
        if (!c.clientId || !c.clientSecret) {
          return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "先把 Client ID 和 Client Secret 填上（点「看怎么建」有逐步引导）" }));
        }
        // 桌面应用的 loopback 回调，Google 不校验端口，直接用操作台自己的地址
        const redirectUri = `http://127.0.0.1:${PORT}/oauth2/callback`;
        const { url: authUrl } = buildAuthUrl(c, redirectUri, cleanStr(body.email, 120));
        return send(res, 200, "application/json", JSON.stringify({ ok: true, authUrl, redirectUri }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    if (url.pathname === "/api/mail/google/revoke" && req.method === "POST") {
      const removed = removeEnvKeys(["GOOGLE_REFRESH_TOKEN", "GOOGLE_ACCOUNT_EMAIL"]);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, removed, ...googleStatus(mailEnv()) }));
    }

    // Google 授权完成后浏览器跳回这里
    if (url.pathname === "/oauth2/callback" && req.method === "GET") {
      const err = url.searchParams.get("error") || "";
      const code = url.searchParams.get("code") || "";
      const state = url.searchParams.get("state") || "";
      const page = (title, msg, ok) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f6f8;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#0f172a}
.c{background:#fff;border:1px solid #e6e9ef;border-radius:16px;padding:34px 38px;max-width:470px;box-shadow:0 8px 30px rgba(15,23,42,.06);text-align:center}
.i{font-size:34px;line-height:1}.t{font-size:17px;font-weight:700;margin:12px 0 8px}.m{font-size:13px;color:#475569;line-height:1.8;word-break:break-word}
.b{margin-top:18px;font-size:11.5px;color:#94a3b8;line-height:1.7}</style>
<div class="c"><div class="i">${ok ? "✅" : "⚠️"}</div><div class="t">${escHtml(title)}</div><div class="m">${escHtml(msg)}</div>
<div class="b">${ok ? "这个页面会自动关闭；没关就手动关掉，回操作台继续" : "回操作台重试；如果是 Client 配置问题，点「看怎么建」检查一遍"}</div></div>
${ok ? "<script>setTimeout(()=>window.close(),1600)<\/script>" : ""}</html>`;
      if (err) return send(res, 200, "text/html; charset=utf-8", page("授权被取消", `Google 返回：${err}`, false));
      if (!code) return send(res, 200, "text/html; charset=utf-8", page("没拿到授权码", "地址里没有 code，可能被浏览器插件改写了", false));
      try {
        const cfg = loadConfig();
        const r = await completeAuth(cfg, googleCreds(mailEnv()), { code, state });
        saveEnv({ GOOGLE_REFRESH_TOKEN: r.refreshToken, GOOGLE_ACCOUNT_EMAIL: r.email });
        return send(res, 200, "text/html; charset=utf-8", page("授权成功", `${r.email || "Gmail 账号"} 已连接，回操作台点「登录测试」`, true));
      } catch (e) {
        return send(res, 200, "text/html; charset=utf-8", page("授权失败", String(e.message || e), false));
      }
    }

    if (url.pathname === "/api/mail/finder" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const updates = {};
        if (["none", "hunter", "apollo", "snov"].includes(body.provider)) updates.EMAIL_FINDER_PROVIDER = body.provider;
        for (const [k, envKey] of Object.entries(FINDER_ENV)) {
          const v = String(body[k] ?? "").trim();
          if (v && !v.includes(MASK)) updates[envKey] = v;
        }
        const applied = saveEnv(updates);
        const cfg = loadConfig();
        const provider = cfg.contacts.email_finder.provider || "none";
        let test = null;
        if (body.test && provider !== "none") {
          test = await testFinder(cfg, provider, finderCreds(cfg));
          lastFinderTest = { ...test, provider, at: Date.now() };
        }
        return send(res, 200, "application/json", JSON.stringify({
          ok: true, applied, provider, ready: emailFinderReady(cfg), test, state: mailStatePayload(),
        }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    if (url.pathname === "/api/mail/finder/test" && req.method === "POST") {
      try {
        const cfg = loadConfig();
        const provider = cfg.contacts.email_finder.provider || "none";
        if (provider === "none") {
          return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "先在上面选一个邮箱查找服务再测试" }));
        }
        const test = await testFinder(cfg, provider, finderCreds(cfg));
        lastFinderTest = { ...test, provider, at: Date.now() };
        return send(res, 200, "application/json", JSON.stringify({ ok: true, provider, test }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    // 打开服务商后台：登录一次，key 就在账号页里
    if (url.pathname === "/api/mail/finder/login" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const p = finderProvider(body.provider || loadConfig().contacts.email_finder.provider);
      if (!p.console) return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "这个服务没有后台页面" }));
      openBrowser(p.console);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, url: p.console, note: "已用默认浏览器打开，登录后把 key 复制回来" }));
    }

    // 登录后从页面上把 key 读回来（只有 Hunter 的 API 页是静态渲染，能读）
    if (url.pathname === "/api/mail/finder/grab" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const key = body.provider || loadConfig().contacts.email_finder.provider;
        const p = finderProvider(key);
        if (p.key !== "hunter") {
          return send(res, 200, "application/json", JSON.stringify({ ok: false, error: `${p.name} 的 key 页是动态加载的，读不回来，手动复制一下更快` }));
        }
        const html = await dumpDom(p.grabUrl, { budget: 8000, timeout: 60000 });
        const found = [...new Set(html.match(new RegExp(p.pattern, "g")) || [])].slice(0, 5);
        return send(res, 200, "application/json", JSON.stringify({
          ok: true,
          url: p.grabUrl,
          candidates: found,
          hint: found.length ? "找到候选 key，确认后点保存" : "页面里没抓到 key：多半是登录态不在这份 Chrome 里（要在本工具打开的窗口里登录），或页面还没加载完。手动复制更快。",
        }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    // 用户不知道服务器地址时：按域名并发探测常见 SMTP 地址，只读 220 问候，不发账号
    if (url.pathname === "/api/mail/guess" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const r = await guessSmtpHost(body.email || "");
        return send(res, 200, "application/json", JSON.stringify(r));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 200) }));
      }
    }

    // 这一步该怎么操作（授权码在哪、点哪里）
    if (url.pathname === "/api/mail/guide" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      return send(res, 200, "application/json", JSON.stringify({ ok: true, guide: guideFor(body.email || "") }));
    }

    // 登录测试：真连 SMTP、真 AUTH；成功才写入 .env
    if (url.pathname === "/api/mail/smtp/login" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const env = mailEnv();
        const sm = await withGmailAuth(loadConfig(), resolveSmtpInput(body, env), env);
        const r = await smtpLogin(sm);
        if (!r.ok) {
          lastSmtpLogin = { ok: false, at: Date.now(), error: r.error, steps: r.steps || [] };
          return send(res, 200, "application/json", JSON.stringify({
            ok: false, error: r.error, steps: r.steps || [], host: sm.host, port: sm.port, secure: sm.secure,
          }));
        }
        const applied = saveEnv({
          SMTP_USER: sm.user,
          SMTP_PASS: sm.pass,
          SMTP_HOST: sm.host,
          SMTP_PORT: String(sm.port),
          SMTP_SECURE: sm.secure ? "1" : "0",
          SMTP_FROM: sm.from,
          SMTP_NAME: sm.name,
        });
        lastSmtpLogin = { ok: true, at: Date.now(), user: sm.user, host: sm.host, steps: r.steps, auth: r.auth, ms: r.ms };
        return send(res, 200, "application/json", JSON.stringify({
          ok: true, steps: r.steps, auth: r.auth, ms: r.ms, saved: applied, smtp: smtpPayload(mailEnv()),
        }));
      } catch (e) {
        const msg = String(e.message || e).slice(0, 240);
        lastSmtpLogin = { ok: false, at: Date.now(), error: msg };
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: msg, code: e.code || null }));
      }
    }

    if (url.pathname === "/api/mail/smtp/save" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const sm = resolveSmtpInput(body, mailEnv());
      if (!sm.user || !sm.host) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: "邮箱地址和服务器地址都不能空" }));
      }
      const applied = saveEnv({
        SMTP_USER: sm.user,
        SMTP_PASS: sm.pass,
        SMTP_HOST: sm.host,
        SMTP_PORT: String(sm.port),
        SMTP_SECURE: sm.secure ? "1" : "0",
        SMTP_FROM: sm.from,
        SMTP_NAME: sm.name,
      });
      return send(res, 200, "application/json", JSON.stringify({ ok: true, applied, smtp: smtpPayload(mailEnv()) }));
    }

    if (url.pathname === "/api/mail/smtp/send" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const sm = await smtpForSend();
        const to = cleanStr(body.to, 120) || sm.user;
        const r = await sendMail(sm, {
          to,
          subject: cleanStr(body.subject, 120) || "LeadRadar 测试邮件",
          text: String(body.text || "").trim() || [
            "这是一封来自 LeadRadar 的测试邮件。",
            "",
            `发信账号：${sm.user}`,
            `时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
            "",
            "收到它说明 SMTP 登录、发信链路都通了，后面报告里的开发信草稿可以直接用这个账号发。",
          ].join("\n"),
        });
        return send(res, 200, "application/json", JSON.stringify({ ok: true, to: r.to, reply: r.reply }));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 240) }));
      }
    }

    if (url.pathname === "/api/mail/verify" && req.method === "POST") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}");
        const sm = await smtpForSend();
        const list = Array.isArray(body.emails) ? body.emails : String(body.text || body.emails || "").split(/[\s,;]+/);
        const r = await verifyAddresses(sm, list);
        return send(res, 200, "application/json", JSON.stringify(r));
      } catch (e) {
        return send(res, 200, "application/json", JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 240) }));
      }
    }


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
