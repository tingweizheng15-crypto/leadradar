/**
 * 邮件模块（零依赖）
 *
 *   1. SMTP 登录自检：真的连上去、真的 AUTH，而不是只看填没填
 *   2. 收件人验证：用登录态发 RCPT TO，判断邮箱是否真实存在（含 catch-all 识别）
 *   3. 发送邮件：测试信 / 后续的开发信
 *   4. 邮箱查找服务（Hunter / Apollo / Snov）的连通性与额度自检
 *
 * 为什么自己写 SMTP：项目零依赖，且要打包成单文件 EXE（Node SEA）。
 * SEA 里 require 磁盘上的第三方模块会失败，nodemailer 只能塞进 blob，得不偿失。
 * 这里只实现真正用到的几条命令（EHLO / STARTTLS / AUTH / MAIL / RCPT / DATA），
 * 够用、可控、出错信息也能翻译成人话。
 */
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import crypto from "node:crypto";
import { proxiedFetch } from "./net.mjs";

const CRLF = "\r\n";
const T = 15000;

/* ------------------------------------------------------------------ *
 * 常见邮箱服务商预设
 * ------------------------------------------------------------------ */

export const MAIL_PRESETS = {
  "qq.com": { host: "smtp.qq.com", port: 465, secure: true, web: "https://mail.qq.com", hint: "QQ 邮箱要填「授权码」：设置 → 账号 → 开启 POP3/SMTP 服务 → 生成授权码" },
  "foxmail.com": { host: "smtp.qq.com", port: 465, secure: true, web: "https://mail.qq.com", hint: "Foxmail 邮箱同样用 QQ 的授权码" },
  "vip.qq.com": { host: "smtp.qq.com", port: 465, secure: true, web: "https://mail.qq.com", hint: "QQ 邮箱要填授权码，不是登录密码" },
  "163.com": { host: "smtp.163.com", port: 465, secure: true, web: "https://mail.163.com", hint: "163 要填「客户端授权密码」：设置 → POP3/SMTP/IMAP → 开启并生成" },
  "126.com": { host: "smtp.126.com", port: 465, secure: true, web: "https://mail.126.com", hint: "126 要填客户端授权密码，并先开启 SMTP 服务" },
  "yeah.net": { host: "smtp.yeah.net", port: 465, secure: true, web: "https://mail.yeah.net", hint: "网易邮箱要填客户端授权密码" },
  "sina.com": { host: "smtp.sina.com", port: 465, secure: true, web: "https://mail.sina.com.cn", hint: "新浪邮箱要在设置里开启 SMTP 服务" },
  "sina.cn": { host: "smtp.sina.com", port: 465, secure: true, web: "https://mail.sina.com.cn", hint: "新浪邮箱要在设置里开启 SMTP 服务" },
  "sohu.com": { host: "smtp.sohu.com", port: 465, secure: true, web: "https://mail.sohu.com", hint: "搜狐邮箱要开启 SMTP 服务" },
  "139.com": { host: "smtp.139.com", port: 465, secure: true, web: "https://mail.10086.cn", hint: "移动 139 邮箱要开启 SMTP 并用授权码" },
  "189.cn": { host: "smtp.189.cn", port: 465, secure: true, web: "https://webmail30.189.cn", hint: "电信 189 邮箱要开启 SMTP" },
  "aliyun.com": { host: "smtp.aliyun.com", port: 465, secure: true, web: "https://mail.aliyun.com", hint: "阿里邮箱要开启 SMTP 并用客户端密码" },
  "gmail.com": { host: "smtp.gmail.com", port: 465, secure: true, web: "https://mail.google.com", hint: "Gmail 必须用「应用专用密码」（先开两步验证），普通密码会被拒" },
  "googlemail.com": { host: "smtp.gmail.com", port: 465, secure: true, web: "https://mail.google.com", hint: "Gmail 必须用应用专用密码" },
  "outlook.com": { host: "smtp-mail.outlook.com", port: 587, secure: false, web: "https://outlook.live.com", hint: "Outlook 个人邮箱走 587 STARTTLS；开了两步验证要用应用密码" },
  "hotmail.com": { host: "smtp-mail.outlook.com", port: 587, secure: false, web: "https://outlook.live.com", hint: "Outlook 个人邮箱走 587 STARTTLS" },
  "live.com": { host: "smtp-mail.outlook.com", port: 587, secure: false, web: "https://outlook.live.com", hint: "Outlook 个人邮箱走 587 STARTTLS" },
  "msn.com": { host: "smtp-mail.outlook.com", port: 587, secure: false, web: "https://outlook.live.com", hint: "Outlook 个人邮箱走 587 STARTTLS" },
  "icloud.com": { host: "smtp.mail.me.com", port: 587, secure: false, web: "https://www.icloud.com/mail", hint: "iCloud 要用 App 专用密码" },
  "me.com": { host: "smtp.mail.me.com", port: 587, secure: false, web: "https://www.icloud.com/mail", hint: "iCloud 要用 App 专用密码" },
  "mac.com": { host: "smtp.mail.me.com", port: 587, secure: false, web: "https://www.icloud.com/mail", hint: "iCloud 要用 App 专用密码" },
  "yahoo.com": { host: "smtp.mail.yahoo.com", port: 465, secure: true, web: "https://mail.yahoo.com", hint: "Yahoo 要先生成 App Password" },
  "yandex.com": { host: "smtp.yandex.com", port: 465, secure: true, web: "https://mail.yandex.com", hint: "Yandex 要在设置里开启 SMTP 并用应用密码" },
  "zoho.com": { host: "smtp.zoho.com", port: 465, secure: true, web: "https://mail.zoho.com", hint: "Zoho 要用应用专用密码" },
};

/** 按邮箱域名猜服务商；猜不出来按 smtp.<域名>:465 兜底，让用户自己改 */
export function mailPreset(email) {
  const domain = String(email || "").split("@")[1]?.trim().toLowerCase() || "";
  if (!domain) return null;
  if (MAIL_PRESETS[domain]) return { domain, guessed: false, ...MAIL_PRESETS[domain] };
  return {
    domain,
    host: `smtp.${domain}`,
    port: 465,
    secure: true,
    guessed: true,
    web: `https://mail.${domain}`,
    hint: "域名认不出来，按 smtp.<域名>:465 猜的；企业邮请改成服务商地址（腾讯企业邮 smtp.exmail.qq.com / 阿里企业邮 smtp.qiye.aliyun.com / 网易企业邮 smtp.qiye.163.com）",
  };
}

/* ------------------------------------------------------------------ *
 * 邮箱查找服务（找客户邮箱）
 * ------------------------------------------------------------------ */

export const FINDER_PROVIDERS = [
  {
    key: "none",
    name: "不启用（只挖官网公开邮箱）",
    console: "",
    grabUrl: "",
    fields: [],
    note: "官网 / 关于页 / 联系页里公开的邮箱照样能抓到，只是覆盖率低一些，而且完全免费。",
  },
  {
    key: "hunter",
    name: "Hunter.io",
    console: "https://hunter.io/api_keys",
    grabUrl: "https://hunter.io/api_keys",
    pattern: "[a-f0-9]{40}",
    fields: [{ name: "hunterKey", env: "HUNTER_API_KEY", label: "API key", placeholder: "40 位十六进制，登录后 hunter.io/api_keys 页面上" }],
    note: "免费档每月 25 次搜索；每抓一个官网域名消耗 1 次。key 在登录后的 API 页面。",
  },
  {
    key: "apollo",
    name: "Apollo.io",
    console: "https://app.apollo.io/#/settings/integrations/api",
    grabUrl: "https://app.apollo.io/#/settings/integrations/api",
    pattern: "[A-Za-z0-9_-]{16,64}",
    fields: [{ name: "apolloKey", env: "APOLLO_API_KEY", label: "API key", placeholder: "Settings → Integrations → API Keys" }],
    note: "免费档额度有限；key 在 Settings → Integrations → API Keys。",
  },
  {
    key: "snov",
    name: "Snov.io",
    console: "https://app.snov.io/account/api",
    grabUrl: "https://app.snov.io/account/api",
    pattern: "[A-Za-z0-9]{8,64}",
    fields: [
      { name: "snovUserId", env: "SNOV_USER_ID", label: "User ID", placeholder: "API 页面里的 User ID" },
      { name: "snovSecret", env: "SNOV_SECRET", label: "Secret", placeholder: "API 页面里的 Secret" },
    ],
    note: "两段式凭证：User ID + Secret 都要填，缺一个就用不了。",
  },
];

export function finderProvider(key) {
  return FINDER_PROVIDERS.find((p) => p.key === key) || FINDER_PROVIDERS[0];
}

/* ------------------------------------------------------------------ *
 * SMTP 会话
 * ------------------------------------------------------------------ */

class Smtp {
  constructor(socket, timeout = T) {
    this.socket = socket;
    this.timeout = timeout;
    this.buffer = "";
    this.waiter = null;
    this.dead = null;
    socket.setEncoding("utf8");
    socket.on("data", (d) => {
      this.buffer += d;
      this.pump();
    });
    socket.on("error", (e) => this.kill(e));
    socket.on("timeout", () => this.kill(new Error("服务器响应超时（端口可能被防火墙挡了）")));
    socket.on("close", () => this.kill(new Error("连接被服务器关闭")));
  }

  kill(err) {
    this.dead = this.dead || err;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w.reject(this.dead);
    }
  }

  /** 从缓冲区里取一条完整响应（支持 250-xxx 多行） */
  take() {
    let pos = 0;
    const lines = [];
    while (true) {
      const i = this.buffer.indexOf(CRLF, pos);
      if (i === -1) return null;
      const line = this.buffer.slice(pos, i);
      if (!/^\d{3}[ -]/.test(line)) { pos = i + 2; continue; }
      lines.push(line);
      pos = i + 2;
      if (line[3] === " ") {
        this.buffer = this.buffer.slice(pos);
        return { code: Number(line.slice(0, 3)), text: lines.map((l) => l.slice(4)).join("\n"), lines };
      }
    }
  }

  pump() {
    if (!this.waiter) return;
    const r = this.take();
    if (!r) return;
    const w = this.waiter;
    this.waiter = null;
    w.resolve(r);
  }

  next(timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(this.dead);
      const r = this.take();
      if (r) return resolve(r);
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error("等待服务器响应超时"));
      }, timeout);
      this.waiter = {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  async cmd(line, timeout) {
    const p = this.next(timeout);
    if (line != null) this.socket.write(line + CRLF);
    return p;
  }

  /** 升级 TLS 前把旧 socket 的监听摘掉，否则数据会被两边同时消费 */
  detach() {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket.removeAllListeners("timeout");
  }

  async quit() {
    try { await this.cmd("QUIT", 4000); } catch { /* 服务器已经断开就算了 */ }
    try { this.detach(); this.socket.destroy(); } catch { /* ignore */ }
  }

  destroy() {
    try { this.detach(); this.socket.destroy(); } catch { /* ignore */ }
  }
}

function rawsocket(host, port, secure, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: !/^(1|true|yes)$/i.test(process.env.LR_TLS_INSECURE || "") }, () => resolve(s))
      : net.connect({ host, port }, () => resolve(s));
    s.once("error", (e) => reject(new Error(connHint(host, port, e))));
    s.setTimeout(timeout, () => s.destroy(new Error("连接超时（15 秒没连上）")));
  });
}

function connHint(host, port, err) {
  const raw = String(err?.message || err);
  const code = err?.code || "";
  if (code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/i.test(raw)) {
    return `域名解析失败：${host}。服务器地址可能写错了（企业邮要填服务商地址）`;
  }
  if (code === "ECONNREFUSED") return `${host}:${port} 拒绝连接：端口不对，或服务商没开 SMTP 服务`;
  if (code === "ETIMEDOUT" || /timeout/i.test(raw)) {
    return `${host}:${port} 连接超时：换 465/587 试试；海外邮箱（Gmail/Outlook）可能需要代理，本工具暂不支持 SMTP 走代理`;
  }
  if (/certificate|self signed|SELF_SIGNED/i.test(raw)) {
    return `TLS 证书校验失败：${host}。自建邮件服务器可设环境变量 LR_TLS_INSECURE=1 跳过校验`;
  }
  return `${host}:${port} 连接失败：${raw}`;
}

function authHint(host) {
  const h = String(host || "").toLowerCase();
  if (/smtp\.qq\.com|exmail\.qq\.com/.test(h)) return "QQ / 腾讯邮箱要用「授权码」或「客户端专用密码」，不是网页登录密码";
  if (/163\.com|126\.com|yeah\.net|qiye\.163/.test(h)) return "网易邮箱要用「客户端授权密码」，并确认已开启 SMTP 服务";
  if (/gmail|googlemail/.test(h)) return "Gmail 需要「应用专用密码」（先在 Google 账号里开两步验证）";
  if (/outlook|office365|hotmail|live\.com/.test(h)) return "Outlook 一般需要应用密码；企业版还要管理员开启 SMTP AUTH";
  if (/aliyun/.test(h)) return "阿里邮箱要用客户端密码，并确认已开启 SMTP";
  return "多数邮箱需要「授权码 / 应用专用密码」，不是网页登录密码";
}

function ehloName() {
  // 有些服务器（尤其网易）会检查 EHLO 参数，用机器名最稳；localhost 也普遍接受
  return String(os.hostname() || "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
}

function capsOf(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[A-Z][A-Z0-9-]*/.test(l));
}

function authMethods(text) {
  const line = String(text || "").split("\n").find((l) => /^AUTH[ =]/i.test(l)) || "";
  return line.replace(/^AUTH[ =]/i, "").split(/\s+/).filter(Boolean).map((s) => s.toUpperCase());
}

async function openSession(cfg, steps = []) {
  const host = cfg.host;
  const port = Number(cfg.port) || 465;
  const secure = cfg.secure !== false;
  const t0 = Date.now();

  let sock = null;
  let smtp = null;
  try {
    sock = await rawsocket(host, port, secure);
    smtp = new Smtp(sock);

    const greet = await smtp.next(12000);
    if (greet.code !== 220) {
      throw new Error(`服务器没返回 220 问候（${greet.code}）：${greet.text.slice(0, 120)}`);
    }
    steps.push({ k: "连接", v: `${host}:${port}${secure ? " · SSL" : ""} → 220 ${greet.text.split("\n").pop().slice(0, 60)}` });

    let ehlo = await smtp.cmd(`EHLO ${ehloName()}`);
    steps.push({ k: "握手", v: `EHLO → ${ehlo.code}${capsOf(ehlo.text).length ? "　" + capsOf(ehlo.text).slice(0, 6).join(" ") : ""}` });

    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      const r = await smtp.cmd("STARTTLS");
      if (r.code === 220) {
        smtp.detach();
        sock = await new Promise((resolve, reject) => {
          const s = tls.connect({ socket: sock, servername: host, rejectUnauthorized: !/^(1|true|yes)$/i.test(process.env.LR_TLS_INSECURE || "") }, () => resolve(s));
          s.once("error", (e) => reject(new Error(`STARTTLS 加密失败：${e.message}`)));
        });
        smtp = new Smtp(sock);
        ehlo = await smtp.cmd(`EHLO ${ehloName()}`);
        steps.push({ k: "加密", v: `STARTTLS 已升级 → ${ehlo.code}` });
      }
    }

    const methods = authMethods(ehlo.text);
    const user = cfg.user;
    const pass = cfg.pass;
    let authOk = false;
    let usedMethod = "";

    if (!methods.length || methods.includes("PLAIN")) {
      const token = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
      const r = await smtp.cmd(`AUTH PLAIN ${token}`);
      if (r.code === 235) { authOk = true; usedMethod = "PLAIN"; }
      else if (r.code === 504 || r.code === 501) { /* 不支持，落到 LOGIN */ }
      else if (r.code === 535) throw authError(host, r);
      else throw new Error(`AUTH PLAIN 失败（${r.code}）：${r.text.slice(0, 120)}`);
    }

    if (!authOk) {
      let r = await smtp.cmd("AUTH LOGIN");
      if (r.code !== 334) {
        if (r.code === 535) throw authError(host, r);
        throw new Error(`服务器不支持 AUTH LOGIN（${r.code}）：${r.text.slice(0, 120)}`);
      }
      r = await smtp.cmd(Buffer.from(user, "utf8").toString("base64"));
      if (r.code !== 334) throw new Error(`发送账号被拒（${r.code}）：${r.text.slice(0, 120)}`);
      r = await smtp.cmd(Buffer.from(pass, "utf8").toString("base64"));
      if (r.code !== 235) {
        if (r.code === 535) throw authError(host, r);
        throw new Error(`登录失败（${r.code}）：${r.text.slice(0, 120)}`);
      }
      authOk = true;
      usedMethod = "LOGIN";
    }

    steps.push({ k: "登录", v: `AUTH ${usedMethod} → 235 认证成功` });
    smtp.authMethod = usedMethod;
    smtp.caps = capsOf(ehlo.text);
    smtp.steps = steps;
    smtp.ms = Date.now() - t0;
    return smtp;
  } catch (e) {
    // 失败必须把 socket 收掉，否则每点一次「登录测试」就漏一个连接
    smtp?.destroy();
    throw e;
  }
}

function authError(host, r) {
  const e = new Error(`账号或密码/授权码不对（535）。${authHint(host)}`);
  e.code = 535;
  e.raw = r?.text || "";
  return e;
}

/* ------------------------------------------------------------------ *
 * 对外：登录自检
 * ------------------------------------------------------------------ */

export async function smtpLogin(cfg) {
  const steps = [];
  if (!cfg.user) return { ok: false, error: "邮箱地址没填", steps };
  if (!cfg.pass) return { ok: false, error: "密码 / 授权码没填", steps };
  if (!cfg.host) return { ok: false, error: "SMTP 服务器地址没填", steps };
  let smtp;
  try {
    smtp = await openSession(cfg, steps);
    return {
      ok: true,
      steps,
      auth: smtp.authMethod,
      ms: smtp.ms,
      caps: smtp.caps || [],
      user: cfg.user,
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure !== false,
    };
  } catch (e) {
    // 不抛异常：UI 要能看到「走到哪一步失败的」，抛了就只剩一句错误
    return { ok: false, error: String(e?.message || e), code: e?.code || null, steps };
  } finally {
    if (smtp) await smtp.quit();
  }
}

/* ------------------------------------------------------------------ *
 * 对外：验证收件人是否真实存在
 * ------------------------------------------------------------------ */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function rcptVerdict(r) {
  const text = String(r.text || "");
  if (r.code === 250 || r.code === 251) return "ok";
  if (/relay|5\.7\.|not permitted|access denied|policy/i.test(text)) return "blocked";
  if ([550, 551, 553, 554, 501, 503].includes(r.code)) return "invalid";
  if (r.code >= 400 && r.code < 500) return "unknown";
  return "unknown";
}

/**
 * 用已登录的 SMTP 账号逐个 RCPT TO 探测。
 * 先给同域名的随机地址发一次：如果服务器照样回 250，说明是 catch-all，
 * 这种情况下任何探测都没有意义，必须如实告诉用户「判断不了」。
 */
export async function verifyAddresses(cfg, list, opts = {}) {
  const emails = [...new Set(
    (Array.isArray(list) ? list : String(list || "").split(/[\s,;]+/))
      .map((s) => String(s || "").trim().toLowerCase())
      .filter((s) => EMAIL_RE.test(s))
  )].slice(0, 25);
  if (!emails.length) throw new Error("没有可验证的邮箱地址（一行一个，或用逗号/空格分隔）");

  const smtp = await openSession(cfg);
  const results = [];
  const catchAll = {};
  const from = cfg.user;
  try {
    for (const email of emails) {
      const domain = email.split("@")[1];
      // 同一域名的 catch-all 只探一次，省时间也省服务器耐心
      if (catchAll[domain] === undefined) {
        const probe = `lr-check-${crypto.randomBytes(5).toString("hex")}@${domain}`;
        await smtp.cmd(`MAIL FROM:<${from}>`);
        const pr = await smtp.cmd(`RCPT TO:<${probe}>`);
        catchAll[domain] = pr.code === 250 || pr.code === 251;
        await smtp.cmd("RSET");
        if (catchAll[domain]) {
          results.push({ email, status: "catchall", code: pr.code, text: "该域名全收（catch-all），服务器对任意地址都回 250，无法判断真假" });
          continue;
        }
      }
      if (catchAll[domain]) {
        results.push({ email, status: "catchall", code: null, text: "该域名全收（catch-all），无法判断真假" });
        continue;
      }

      const mf = await smtp.cmd(`MAIL FROM:<${from}>`);
      if (mf.code !== 250) {
        throw new Error(`MAIL FROM 被拒（${mf.code}）：${mf.text.slice(0, 120)}。多是自己域名不在发信白名单里`);
      }
      const r = await smtp.cmd(`RCPT TO:<${email}>`);
      const v = rcptVerdict(r);
      results.push({
        email,
        status: v,
        code: r.code,
        text: r.text.slice(0, 160),
      });
      await smtp.cmd("RSET");
      await new Promise((res) => setTimeout(res, opts.gap || 120));
    }
  } finally {
    await smtp.quit();
  }
  return {
    ok: true,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === "ok").length,
      invalid: results.filter((r) => r.status === "invalid").length,
      catchall: results.filter((r) => r.status === "catchall").length,
      unknown: results.filter((r) => r.status === "unknown" || r.status === "blocked").length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 对外：发信
 * ------------------------------------------------------------------ */

function encodeHeader(str) {
  const s = String(str || "");
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  // RFC 2047：中文主题按 45 字节切块，折行写，避免超过 76 字符被拒
  const raw = Buffer.from(s, "utf8");
  const parts = [];
  for (let i = 0; i < raw.length; i += 45) {
    parts.push(`=?UTF-8?B?${raw.subarray(i, i + 45).toString("base64")}?=`);
  }
  return parts.join(`${CRLF} `);
}

function buildMessage(cfg, { to, subject, text }) {
  // 纯 ASCII 名字才加引号；中文名走 RFC2047 编码，编码字不能再套引号
  const name = cfg.name
    ? (/^[\x20-\x7E]*$/.test(cfg.name) ? `"${cfg.name}" ` : `${encodeHeader(cfg.name)} `)
    : "";
  const domain = String(cfg.user || "").split("@")[1] || "localhost";
  const body = Buffer.from(String(text || ""), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n").trimEnd();
  return [
    `From: ${name}<${cfg.from || cfg.user}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject || "LeadRadar 测试邮件")}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join(CRLF);
}

function dotStuff(msg) {
  return String(msg || "").replace(/\r\n\./g, "\r\n..").replace(/^\./, "..");
}

export async function sendMail(cfg, { to, subject, text }) {
  const rcpt = String(to || "").trim();
  if (!EMAIL_RE.test(rcpt)) throw new Error("收件人地址不对");
  const smtp = await openSession(cfg);
  try {
    const mf = await smtp.cmd(`MAIL FROM:<${cfg.user}>`);
    if (mf.code !== 250) throw new Error(`MAIL FROM 被拒（${mf.code}）：${mf.text.slice(0, 120)}`);
    const r = await smtp.cmd(`RCPT TO:<${rcpt}>`);
    if (!(r.code === 250 || r.code === 251)) {
      throw new Error(`收件人被拒（${r.code}）：${r.text.slice(0, 140)}`);
    }
    const d = await smtp.cmd("DATA");
    if (d.code !== 354) throw new Error(`DATA 被拒（${d.code}）：${d.text.slice(0, 120)}`);
    const msg = buildMessage(cfg, { to: rcpt, subject, text });
    const done = await smtp.cmd(`${dotStuff(msg)}${CRLF}.`);
    if (done.code !== 250) throw new Error(`发送失败（${done.code}）：${done.text.slice(0, 160)}`);
    return { ok: true, to: rcpt, reply: done.text.slice(0, 160) };
  } finally {
    await smtp.quit();
  }
}

/* ------------------------------------------------------------------ *
 * 对外：邮箱查找服务自检
 * ------------------------------------------------------------------ */

async function httpJson(cfg, url, opts = {}, timeout = T) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await proxiedFetch(cfg, url, { ...opts, signal: ctrl.signal }, timeout);
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* 非 JSON 就用原文报错 */ }
    return { status: res.status, data, body };
  } finally {
    clearTimeout(timer);
  }
}

function httpWhy(status, body) {
  if (status === 401 || status === 403) return `key 无效或没有权限（HTTP ${status}）`;
  if (status === 429) return "额度用完了（HTTP 429），等下个计费周期或换服务商";
  if (status === 402) return "套餐不支持这个接口（HTTP 402）";
  return `HTTP ${status}：${String(body || "").slice(0, 160)}`;
}

/**
 * @param {object} cfg  完整 cfg（用来拿代理）
 * @param {string} provider hunter | apollo | snov
 * @param {object} creds  { apiKey, userId, secret }
 */
export async function testFinder(cfg, provider, creds = {}) {
  try {
    if (provider === "hunter") {
      const key = String(creds.apiKey || "").trim();
      if (!key) return { ok: false, error: "还没填 Hunter API key" };
      // account 接口免费且不消耗搜索额度，最适合验证 key
      const r = await httpJson(cfg, `https://api.hunter.io/v2/account?api_key=${encodeURIComponent(key)}`);
      if (r.status !== 200 || !r.data?.data) return { ok: false, error: httpWhy(r.status, r.body) };
      const d = r.data.data;
      const c = d.requests?.credits || d.requests?.searches || {};
      const left = c.available != null ? Math.max(0, Number(c.available) - Number(c.used || 0)) : null;
      return {
        ok: true,
        detail: [d.email, d.plan_name ? `${d.plan_name} 套餐` : "", left != null ? `剩余 ${left} / ${c.available} 次` : ""]
          .filter(Boolean).join(" · "),
      };
    }

    if (provider === "apollo") {
      const key = String(creds.apiKey || "").trim();
      if (!key) return { ok: false, error: "还没填 Apollo API key" };
      const headers = { "Content-Type": "application/json", "Cache-Control": "no-cache", "X-Api-Key": key };
      let r = await httpJson(cfg, "https://api.apollo.io/v1/auth/health", { headers });
      if (r.status === 404) r = await httpJson(cfg, "https://api.apollo.io/api/v1/auth/health", { headers });
      if (r.status !== 200) return { ok: false, error: httpWhy(r.status, r.body) };
      if (!r.data?.is_logged_in) return { ok: false, error: "key 被拒（is_logged_in = false），检查有没有多余空格" };
      return { ok: true, detail: `key 有效${r.data.is_master_key ? " · Master key" : ""}` };
    }

    if (provider === "snov") {
      const userId = String(creds.userId || "").trim();
      const secret = String(creds.secret || "").trim();
      if (!userId || !secret) return { ok: false, error: "User ID 和 Secret 要一起填" };
      // 和流水线走同一个接口，测通就等于能真用
      const url = `https://api.snov.io/v1/get-domain-emails-with-info?domain=stripe.com&userId=${encodeURIComponent(userId)}&secret=${encodeURIComponent(secret)}`;
      const r = await httpJson(cfg, url);
      if (r.status !== 200) return { ok: false, error: httpWhy(r.status, r.body) };
      if (r.data?.success === false) return { ok: false, error: `Snov 拒绝：${r.data.message || "凭证不对"}` };
      const n = Object.keys(r.data?.emails || {}).length;
      return { ok: true, detail: n ? `连通，样例域名取到 ${n} 个邮箱` : "连通（样例域名没取到邮箱，可能是额度为 0）" };
    }

    return { ok: false, error: `未知服务商：${provider}` };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/abort|timeout|ETIMEDOUT/i.test(msg)) return { ok: false, error: "请求超时：服务商连不上，若在国内请先配代理" };
    return { ok: false, error: msg.slice(0, 200) };
  }
}

/* ------------------------------------------------------------------ *
 * 配置解析
 * ------------------------------------------------------------------ */

/** 从 .env 风格的环境变量里解析出 SMTP 配置（缺的服务端按域名猜） */
export function smtpConfig(env = {}) {
  const user = String(env.SMTP_USER || "").trim();
  const preset = user ? mailPreset(user) : null;
  const host = String(env.SMTP_HOST || "").trim() || preset?.host || "";
  const secureRaw = String(env.SMTP_SECURE ?? "").trim().toLowerCase();
  const port = Number(env.SMTP_PORT || 0) || preset?.port || (secureRaw === "0" || secureRaw === "starttls" ? 587 : 465);
  const secure = secureRaw === "" ? port === 465 : !/^(0|false|no|starttls|587)$/.test(secureRaw);
  const pass = String(env.SMTP_PASS || "");
  return {
    user,
    pass,
    host,
    port,
    secure,
    from: String(env.SMTP_FROM || "").trim() || user,
    name: String(env.SMTP_NAME || "").trim(),
    preset,
    ready: !!(user && pass && host),
  };
}
