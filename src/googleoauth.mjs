/**
 * Gmail OAuth 2.0（XOAUTH2）
 *
 * 为什么需要它：Google 的「应用密码」要求账号先开两步验证，公司/学校 Workspace 账号
 * 还可能被管理员整体禁用。OAuth 不需要应用密码——用浏览器授权一次，之后只用 refresh token
 * 换 access token，SMTP 侧走 AUTH XOAUTH2。
 *
 * 实现要点：
 *   - 桌面应用（Desktop client）的 loopback 回调，端口不被 Google 校验，所以直接复用
 *     操作台的 127.0.0.1:7788/oauth2/callback，用户不用登记回调地址
 *   - PKCE（S256）：Desktop client 的 secret 本身不算秘密，多一层 PKCE 更稳
 *   - 令牌交换走代理：国内直连 oauth2.googleapis.com 基本不通
 *   - refresh token 存 .env；7 天不用会失效（Testing 状态的限制），失效时给 NEED_REAUTH
 */
import crypto from "node:crypto";
import { proxiedFetch } from "./net.mjs";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
// mail.google.com 是 SMTP/IMAP 的 XOAUTH2 必需 scope；openid/email 只是为了显示账号名
const SCOPE = "openid email https://mail.google.com/";

const pending = new Map();  // state -> { verifier, redirectUri, at }
const cache = new Map();    // refreshToken -> { token, exp }

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function googleCreds(env = {}) {
  return {
    clientId: String(env.GOOGLE_CLIENT_ID || "").trim(),
    clientSecret: String(env.GOOGLE_CLIENT_SECRET || "").trim(),
    refreshToken: String(env.GOOGLE_REFRESH_TOKEN || "").trim(),
    email: String(env.GOOGLE_ACCOUNT_EMAIL || "").trim(),
  };
}

export function googleStatus(env = {}) {
  const c = googleCreds(env);
  return {
    configured: !!(c.clientId && c.clientSecret),
    authorized: !!(c.clientId && c.clientSecret && c.refreshToken),
    email: c.email,
  };
}

/** 生成授权链接；state 10 分钟内有效，只允许完成一次回调 */
export function buildAuthUrl(creds, redirectUri, loginHint = "") {
  const state = crypto.randomBytes(16).toString("hex");
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  for (const [k, v] of pending) if (Date.now() - v.at > 600000) pending.delete(k);
  pending.set(state, { verifier, redirectUri, at: Date.now() });

  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", creds.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("access_type", "offline");       // 要 refresh token
  u.searchParams.set("prompt", "consent");            // 强制每次都发 refresh token
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  if (loginHint) u.searchParams.set("login_hint", loginHint);
  return { url: u.toString(), state };
}

function tokenErrorText(err, data) {
  if (err === "invalid_grant") return "Google 授权已失效（超过 7 天没用，或你手动撤销了），需要重新授权一次";
  if (err === "invalid_client") return "Client ID / Client Secret 不对，回 Google Cloud 的「凭据」页重新复制";
  if (err === "redirect_uri_mismatch") return "回调地址不匹配：OAuth 客户端类型要选「桌面应用」，不要选「Web 应用」";
  if (err === "unauthorized_client") return "这个 OAuth 客户端不允许这种授权方式，确认类型是「桌面应用」";
  return `Google 返回错误：${err}${data?.error_description ? "（" + String(data.error_description).slice(0, 120) + "）" : ""}`;
}

async function postForm(cfg, params) {
  const body = new URLSearchParams(params).toString();
  let res;
  try {
    res = await proxiedFetch(cfg, TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, 20000);
  } catch (e) {
    // 国内直连 Google 不通，必须走代理；这里把「代理挂了」和「授权有问题」分开说清楚
    const detail = String(e?.message || e);
    throw new Error(`连不上 Google（oauth2.googleapis.com）：${detail.slice(0, 120)}。代理软件换过端口的话，去「密钥与代理」改成当前端口`);
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON 走下面统一报错 */ }
  if (!res.ok || !data || data.error) {
    const err = data?.error || `http_${res.status}`;
    const e = new Error(tokenErrorText(err, data));
    e.code = err === "invalid_grant" ? "NEED_REAUTH" : "OAUTH";
    throw e;
  }
  return data;
}

async function fetchEmail(cfg, accessToken) {
  try {
    const res = await proxiedFetch(cfg, USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } }, 15000);
    if (!res.ok) return "";
    const d = await res.json();
    return String(d.email || "");
  } catch {
    return "";
  }
}

/** 用户从 Google 跳回本地后：用 code 换 refresh token */
export async function completeAuth(cfg, creds, { code, state }) {
  const p = pending.get(state);
  if (!p) throw new Error("授权会话已过期（或工具重启过），回操作台重新点一次「用 Google 账号授权」");
  pending.delete(state);
  const data = await postForm(cfg, {
    code,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: "authorization_code",
    code_verifier: p.verifier,
  });
  if (!data.refresh_token) {
    throw new Error("Google 没返回 refresh_token。去 myaccount.google.com/permissions 删掉本应用的授权，再重新授权一次");
  }
  const email = await fetchEmail(cfg, data.access_token);
  cache.set(data.refresh_token, {
    token: data.access_token,
    exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000,
  });
  return { refreshToken: data.refresh_token, email, accessToken: data.access_token };
}

/** 拿 access token（内存缓存 1 小时） */
export async function getAccessToken(cfg, creds) {
  const hit = cache.get(creds.refreshToken);
  if (hit && hit.exp > Date.now()) return { accessToken: hit.token };
  const data = await postForm(cfg, {
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  cache.set(creds.refreshToken, {
    token: data.access_token,
    exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 - 60000,
  });
  return { accessToken: data.access_token };
}

/**
 * 给一个已解析的 SMTP 配置补上 OAuth 令牌。
 * 只有 Gmail 账号 + 已完成授权时才会接管；否则原样返回（继续用应用密码）。
 */
export async function withGmailAuth(cfg, smtp, env) {
  if (!/@(gmail|googlemail)\.com$/i.test(String(smtp.user || ""))) return smtp;
  const c = googleCreds(env);
  if (!c.clientId || !c.clientSecret || !c.refreshToken) return smtp;
  try {
    const { accessToken } = await getAccessToken(cfg, c);
    return { ...smtp, auth: "xoauth2", accessToken };
  } catch (e) {
    if (e.code === "NEED_REAUTH") {
      const err = new Error("Gmail 授权过期了（Google 的 7 天限制），回「邮箱」卡片点一次「重新授权」");
      err.code = "NEED_REAUTH";
      throw err;
    }
    throw e;
  }
}
