#!/usr/bin/env node
/**
 * LeadRadar 环境体检：一条命令说清「现在能跑到什么程度」。
 * node doctor.mjs          只做本地检查，不花任何 API 额度
 * node doctor.mjs --live   额外发一条真实搜索请求，验证 key 与代理是否真的通（消耗 1 次额度）
 */
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { loadConfig, loadEnvFile, ROOT, searchReady, llmReady, emailFinderReady } from "./src/config.mjs";
import { smtpConfig } from "./src/mailer.mjs";
import { findChrome } from "./src/enrich.mjs";
import { providerName, search } from "./src/search.mjs";
import { callLLM, parseJson } from "./src/llm.mjs";
import { jobsOf, parseHms, nextRunEpoch, fmt } from "./src/schedule.mjs";

const live = process.argv.includes("--live");
const rows = [];
const add = (level, name, detail) => rows.push({ level, name, detail });
const ok = (n, d) => add("ok", n, d);
const warn = (n, d) => add("warn", n, d);
const bad = (n, d) => add("bad", n, d);

function tcp(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}

// 1. Node
const major = Number(process.versions.node.split(".")[0]);
major >= 18 ? ok("Node.js", `v${process.versions.node}`) : bad("Node.js", `v${process.versions.node}，需要 ≥ 18`);

// 2. 配置来源
const cfgFile = path.join(ROOT, "config.json");
const envFile = path.join(ROOT, ".env");
if (fs.existsSync(cfgFile)) ok("config.json", "存在（本地真实配置）");
else warn("config.json", "未创建，当前读取 config.example.json；改定时/阈值前先复制一份");
if (fs.existsSync(envFile)) {
  const n = Object.keys(loadEnvFile()).length;
  ok(".env", `存在，${n} 个键`);
} else warn(".env", "未创建（复制 .env.example 为 .env 再填 key）");

// 3. 证书 / 密钥
const cfg = loadConfig();
if (searchReady(cfg)) ok("搜索 key", `${providerName(cfg)} 已配置`);
else warn("搜索 key", "未配置 → 只能跑本地样本库（10 条种子），拿不到新客户");

if (llmReady(cfg)) ok("大模型", `${cfg.llm.model} @ ${cfg.llm.base_url}`);
else warn("大模型", "未配置 → 无 AI 判断与开发信草稿，仅规则评分");

if (emailFinderReady(cfg)) ok("邮箱查找", `${cfg.contacts.email_finder.provider} 已配置`);
else warn("邮箱查找", "未配置（可选）→ 只挖官网公开邮箱");

// 发信邮箱只做本地判断：真正的登录测试在操作台里点（要真连 SMTP）
const smtp = smtpConfig({ ...process.env, ...loadEnvFile() });
if (smtp.ready) ok("发信邮箱", `${smtp.user} @ ${smtp.host}:${smtp.port}（配置完整，未做登录测试）`);
else warn("发信邮箱", "未登录（可选）→ 报告照常出，只是不能发测试信/验证邮箱");

// 4. Chrome
const chrome = findChrome();
chrome ? ok("Chrome", chrome) : bad("Chrome", "未找到 → 每日采集（截图）不可用");

// 5. 代理
const proxy = cfg.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
if (!proxy) warn("代理", "未配置 → 官网可抓，Instagram / TikTok 大概率不通");
else {
  let pu;
  try { pu = new URL(proxy); } catch { pu = null; }
  if (!pu) bad("代理", `地址格式不对：${proxy}`);
  else {
    const reachable = await tcp(pu.hostname, Number(pu.port) || 80, 1500);
    reachable ? ok("代理", `${proxy} 可连接`) : bad("代理", `${proxy} 连不上 —— 检查代理软件是否在跑、端口对不对`);
  }
}

// 6. 观察名单
const srcPath = path.join(ROOT, "daily", "sources.json");
if (fs.existsSync(srcPath)) {
  try {
    const w = JSON.parse(fs.readFileSync(srcPath, "utf8")).watchlist || [];
    const by = w.reduce((a, s) => { a[s.channel] = (a[s.channel] || 0) + 1; return a; }, {});
    ok("观察名单", `${w.length} 个来源（IG ${by.instagram || 0} / TikTok ${by.tiktok || 0} / 官网 ${by.website || 0}）`);
  } catch (e) { bad("观察名单", `解析失败：${e.message}`); }
} else bad("观察名单", "daily/sources.json 不存在");

// 7. 写权限
try {
  const p = path.join(ROOT, ".write-test");
  fs.writeFileSync(p, "x"); fs.unlinkSync(p);
  ok("写权限", "项目目录可写（报告能落盘）");
} catch (e) { bad("写权限", `项目目录不可写：${e.message}`); }

// 8. 定时
for (const j of jobsOf(cfg)) {
  const next = nextRunEpoch(parseHms(j.time), j.tz);
  ok("定时 · " + j.name, `${j.enabled ? "启用" : "停用"}，每天 ${j.time}（${j.tz}），下次 ${fmt(next, j.tz)}`);
}

// 9. 真实联网验证（可选）
if (live) {
  if (!searchReady(cfg)) warn("联网实测 · 搜索", "跳过：搜索 key 未配置");
  else {
    try {
      const r = await search(cfg, "running compression tights brand Korea", 3);
      ok("联网实测 · 搜索", `返回 ${r ? r.length : 0} 条结果（消耗 1 次额度）`);
    } catch (e) { bad("联网实测 · 搜索", String(e.message || e).slice(0, 160)); }
  }

  if (!llmReady(cfg)) warn("联网实测 · 大模型", "跳过：大模型 key 未配置");
  else {
    try {
      // 按流水线真实用法测：要求返回 JSON，这样才能暴露「思考吃光 token → 正文为空」
      const t0 = Date.now();
      const out = await callLLM(cfg, [
        { role: "system", content: '只输出一个 JSON 对象，不要任何其他文字：{"ok":true,"note":"连通性测试"}' },
        { role: "user", content: "测试" },
      ], { maxTokens: 200, json: true });
      const j = parseJson(out);
      if (!j) bad("联网实测 · 大模型", `返回不是合法 JSON：${String(out).replace(/\s+/g, " ").slice(0, 120)}`);
      else ok("联网实测 · 大模型", `${cfg.llm.model} 返回合法 JSON（${Date.now() - t0}ms，token 预算 ${cfg.llm.max_tokens}）`);
    } catch (e) { bad("联网实测 · 大模型", String(e.message || e).slice(0, 260)); }
  }
}

const icon = { ok: "✔", warn: "!", bad: "✕" };
const label = { ok: "OK  ", warn: "注意", bad: "缺失" };
const dw = (s) => [...String(s)].reduce((a, ch) => a + (/[\u2e80-\u9fff\uff00-\uffef\u3000]/.test(ch) ? 2 : 1), 0);
const padW = (s, total) => s + " ".repeat(Math.max(1, total - dw(s)));
console.log("\nLeadRadar 环境体检" + (live ? "（含联网实测）" : "（仅本地检查）"));
console.log("─".repeat(70));
for (const r of rows) console.log(`${icon[r.level]} ${label[r.level]}  ${padW(r.name, 22)}${r.detail}`);
console.log("─".repeat(70));

const bads = rows.filter((r) => r.level === "bad").length;
const warns = rows.filter((r) => r.level === "warn").length;
const canPipeline = searchReady(cfg) && llmReady(cfg);
console.log(`结论：${bads} 项缺失 / ${warns} 项待配`);
console.log(`  获客流水线：${canPipeline ? "完整模式（真实搜索 + AI 判断 + 开发信）" : searchReady(cfg) ? "半自动模式（真实搜索，无 AI）" : "降级模式（本地样本库，拿不到新客户）"}`);
console.log(`  每日采集：${chrome ? "可用（Chrome 就绪）" : "不可用（缺 Chrome）"}`);
console.log("");
