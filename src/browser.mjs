/**
 * 浏览器登录态管理。
 *
 * Instagram / Facebook 未登录只会返回登录墙，抓不到任何主页数据。
 * 做法：给 Chrome 一个专属的 user-data-dir（data/chrome-profile），
 * 用户在里面手动登录一次，之后所有抓取都复用这份 cookie。
 *
 * 注意：同一个 user-data-dir 同时只能被一个 Chrome 实例占用，
 * 所以抓取时如果登录窗口还开着，会失败——调用方要提示用户先关掉。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "./config.mjs";
import { findChrome } from "./enrich.mjs";

const execFileP = promisify(execFile);

export const PLATFORMS = {
  instagram: { name: "Instagram", url: "https://www.instagram.com/" },
  tiktok: { name: "TikTok", url: "https://www.tiktok.com/" },
  facebook: { name: "Facebook", url: "https://www.facebook.com/" },
};

export function profileDir() {
  return path.join(ROOT, "data", "chrome-profile");
}

/** profile 目录里有没有登录过（有 Cookie/Default 目录即视为已初始化） */
export function profileState() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return { exists: false, loggedIn: false, dir };
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { /* 读不到就当空 */ }
  const hasDefault = entries.includes("Default");
  const cookieFile = path.join(dir, "Default", "Network", "Cookies");
  const hasCookie = fs.existsSync(cookieFile);
  return {
    exists: true,
    loggedIn: hasDefault && hasCookie,
    dir,
    sizeMB: +((dirSize(dir) / 1024 / 1024).toFixed(1)),
  };
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let items = [];
    try { items = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const fp = path.join(p, it.name);
      if (it.isDirectory()) walk(fp);
      else { try { total += fs.statSync(fp).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return total;
}

/** 打开有头 Chrome 让用户手动登录；登录后关掉窗口即可，cookie 会留在 profile 里 */
export function launchLogin(platform = "instagram") {
  const chrome = findChrome();
  if (!chrome) throw new Error("找不到 Chrome，请先安装 Chrome 或用 CHROME_PATH 指定路径");
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  // platform=all 时一次开三个标签页，省得来回点三次
  const keys = platform === "all" ? Object.keys(PLATFORMS) : [PLATFORMS[platform] ? platform : "instagram"];
  const urls = keys.map((k) => PLATFORMS[k].url);
  const child = spawn(chrome, [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--new-window",
    ...urls,
  ], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  return { ok: true, platform: keys.join("+"), url: urls[0], urls, profile: dir };
}

/**
 * headless 抓 DOM，复用登录态。
 * @param {string} url
 * @param {{budget?: number, timeout?: number, useProfile?: boolean}} opts
 */
export async function dumpDom(url, { budget = 15000, timeout = 70000, useProfile = true } = {}) {
  const chrome = findChrome();
  if (!chrome) throw new Error("找不到 Chrome");
  const args = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-sandbox"];
  if (useProfile) args.push(`--user-data-dir=${profileDir()}`);
  args.push(`--virtual-time-budget=${budget}`, "--dump-dom", url);
  try {
    const { stdout } = await execFileP(chrome, args, { maxBuffer: 80 * 1024 * 1024, timeout });
    return stdout || "";
  } catch (e) {
    const msg = String(e.message || e);
    if (/user data directory is already in use|ProcessSingleton|cannot create/i.test(msg)) {
      throw new Error("Chrome 登录窗口还开着，请先关闭它再抓取（同一个登录目录只能被一个窗口使用）");
    }
    throw e;
  }
}

/**
 * 直接读 Chrome 的 cookie 库判断登录态。
 *
 * 为什么不用「抓首页看有没有登录墙」来判断：
 *   1. 慢（每平台要起一次无头 Chrome，10-45 秒）
 *   2. 不准（Instagram 登录墙页面也含 "instagram"，Facebook 首页未登录也很大）
 * 读库只认那几个真正的会话 cookie，有就是有、没有就是没有，几百毫秒出结果。
 *
 * Cookie 值本身是 DPAPI 加密的，这里只读 name/host/expires，不解密。
 */
const SESSION_COOKIE = {
  instagram: { host: "instagram.com", names: ["sessionid"] },
  tiktok: { host: "tiktok.com", names: ["sessionid", "sessionid_ss"] },
  facebook: { host: "facebook.com", names: ["c_user"] },
};

/** Chrome 时间戳：1601-01-01 起的微秒数 */

function cookieDbPath() {
  const dir = profileDir();
  const candidates = [
    path.join(dir, "Default", "Network", "Cookies"),
    path.join(dir, "Default", "Cookies"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || "";
}

/**
 * @returns {Promise<null | {instagram:boolean, tiktok:boolean, facebook:boolean, total:number, error?:string}>}
 *   null 表示读不了库（Node 版本太低或无 node:sqlite），调用方应退回抓页面判断
 */
export async function loginStatus() {
  const src = cookieDbPath();
  if (!src) return { instagram: false, tiktok: false, facebook: false, total: 0 };
  // Chrome 开着时库被独占（Windows 下连 readFileSync 都是 EBUSY），先复制一份再读
  const tmp = path.join(os.tmpdir(), `lr-ck-${process.pid}-${Date.now()}.db`);
  try {
    let copied = false;
    for (let i = 0; i < 3 && !copied; i++) {
      try { fs.copyFileSync(src, tmp); copied = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (!copied) {
      // 拿不到就如实说：窗口还开着，别误报成"未登录"
      return { instagram: null, tiktok: null, facebook: null, total: 0, locked: true };
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    // expires_utc 是「1601 年起的微秒数」，量级 1.3e16，超过 JS 安全整数，
    // 直接 SELECT 会抛 RangeError。CAST 成 TEXT 再用 BigInt 比较，精度不受损。
    const rows = db.prepare("SELECT host_key, name, CAST(expires_utc AS TEXT) AS exp FROM cookies").all();
    db.close();
    const now = BigInt(Date.now() + 11644473600000) * 1000n;
    const alive = rows.filter((r) => {
      const exp = BigInt(String(r.exp || "0"));
      return exp === 0n || exp > now; // 0 = 会话 cookie，此刻有效
    });
    const out = { total: alive.length };
    for (const [key, rule] of Object.entries(SESSION_COOKIE)) {
      out[key] = alive.some(
        (r) => String(r.host_key || "").endsWith(rule.host) && rule.names.includes(r.name)
      );
    }
    return out;
  } catch (e) {
    return { instagram: false, tiktok: false, facebook: false, total: 0, error: String(e.message || e).slice(0, 120) };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败无所谓 */ }
  }
}

/** 检查某个平台是否还处于登录态：访问首页看有没有被踢到登录页 */
export async function checkLogin(platform) {
  const p = PLATFORMS[platform] || PLATFORMS.instagram;
  try {
    const html = await dumpDom(p.url, { budget: 8000, timeout: 45000 });
    const len = html.length;
    let ok = false;
    if (platform === "instagram") ok = !/创建账户或登录|Create an account or log in/i.test(html) && /instagram/i.test(html);
    else if (platform === "tiktok") ok = /tiktok/i.test(html) && len > 100000;
    else if (platform === "facebook") ok = !/log in|登录/i.test(html.slice(0, 3000)) || len > 200000;
    return { platform, ok, bytes: len };
  } catch (e) {
    return { platform, ok: false, error: String(e.message || e).slice(0, 160) };
  }
}
