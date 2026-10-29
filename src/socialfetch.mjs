/**
 * Instagram / TikTok / Facebook 公开主页抓取。
 *
 * 三个平台的难点各不相同：
 *  - Instagram：未登录直接跳登录墙，必须复用 browser.mjs 里的登录态；
 *  - TikTok：未登录也能拿到统计，数据藏在 __UNIVERSAL_DATA_FOR_REHYDRATION__ 里；
 *  - Facebook：主页多数可看，但结构最不稳定，靠 og 标签 + 文本兜底。
 *
 * 只抓公开主页信息（简介、粉丝、帖子数、外链），不做私信、不抓粉丝列表。
 */
import { dumpDom, profileState } from "./browser.mjs";

/** "1,234" / "1.5M" / "2.3万" → 数字 */
export function parseCount(v) {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/[,，\s]/g, "");
  const m = s.match(/^([\d.]+)\s*([KkMmBb万億亿]?)/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2];
  const mul = { k: 1e3, m: 1e6, b: 1e9, 万: 1e4, 億: 1e8, 亿: 1e8 }[unit.toLowerCase()] || 1;
  return Math.round(n * mul);
}

const firstMatch = (html, res) => {
  for (const re of res) {
    const m = html.match(re);
    if (m) return (m[1] ?? m[0] ?? "").trim();
  }
  return "";
};

const cleanText = (s) => String(s || "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

/** 按码点截断，避免把 emoji 切成半个字节导致乱码 */
const clip = (s, n) => {
  const str = String(s || "");
  return str.length <= n ? str : Array.from(str).slice(0, n).join("");
};

// ---------------- Instagram ----------------
export async function fetchInstagram(handle, opts = {}) {
  const url = `https://www.instagram.com/${handle}/`;
  const out = base("instagram", handle, url);
  try {
    const html = await dumpDom(url, { budget: opts.budget || 14000, timeout: opts.timeout || 70000 });

    if (/创建账户或登录|Create an account or log in/i.test(html)) {
      out.ok = false;
      out.needLogin = true;
      out.error = "未登录：Instagram 返回登录墙。请先在操作台点「登录 Instagram」完成登录。";
      return out;
    }

    // og:description 是最稳的来源：
    // "1.5M Followers, 320 Following, 4,200 Posts - See Instagram photos and videos from XEXYMIX (@xexymix)"
    const desc = firstMatch(html, [
      /<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i,
      /<meta[^>]+name="description"[^>]+content="([^"]*)"/i,
    ]);
    const title = firstMatch(html, [/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i, /<title[^>]*>([\s\S]*?)<\/title>/i]);
    const image = firstMatch(html, [/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i]);

    const d = cleanText(desc);
    out.followers = parseCount(firstMatch(d, [/([\d.,]+[KkMmBb]?)\s*Followers/i, /([\d.,]+[KkMmBb]?)\s*粉丝/i]));
    out.following = parseCount(firstMatch(d, [/([\d.,]+[KkMmBb]?)\s*Following/i, /([\d.,]+[KkMmBb]?)\s*正在关注/i]));
    out.posts = parseCount(firstMatch(d, [/([\d.,]+[KkMmBb]?)\s*Posts/i, /([\d.,]+[KkMmBb]?)\s*帖子/i]));

    // 简介：优先 JSON 里的 biography，其次从描述里切
    out.bio = firstMatch(html, [/"biography":"((?:[^"\\]|\\.)*)"/])
      || d.replace(/^.*?-\s*See Instagram[^.]*\.?/i, "").trim();
    out.bio = cleanText(out.bio.replace(/\\n/g, " ").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    out.bio = clip(out.bio, 500);

    out.website = firstMatch(html, [/"external_url":"((?:[^"\\]|\\.)*)"/]).replace(/\\\//g, "/");
    out.name = cleanText(title).replace(/\s*\(@[^)]*\).*$/, "").replace(/•\s*Instagram.*$/i, "").trim()
      || firstMatch(html, [/"full_name":"((?:[^"\\]|\\.)*)"/]);
    out.avatar = image;
    out.email = (out.bio.match(EMAIL_RE) || [])[0] || "";
    out.ok = !!(out.followers || out.posts || out.bio);
    if (!out.ok) out.error = `页面已加载但没解析出数据（${html.length} 字节），可能是账号不存在或页面结构变了`;
  } catch (e) {
    out.ok = false;
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

// ---------------- TikTok ----------------
export async function fetchTikTok(handle, opts = {}) {
  const url = `https://www.tiktok.com/@${handle}`;
  const out = base("tiktok", handle, url);
  try {
    const html = await dumpDom(url, { budget: opts.budget || 14000, timeout: opts.timeout || 70000 });

    // 数据在 __UNIVERSAL_DATA_FOR_REHYDRATION__ 这段 JSON 里
    let stats = null, user = null;
    const m = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
    if (m) {
      try {
        const j = JSON.parse(m[1]);
        const scope = j?.__DEFAULT_SCOPE__ || {};
        const detail = scope["webapp.user-detail"] || {};
        user = detail.userInfo?.user || null;
        stats = detail.userInfo?.stats || detail.stats || null;
      } catch { /* JSON 坏了就走 meta 兜底 */ }
    }

    if (stats) {
      out.followers = Number(stats.followerCount) || 0;
      out.following = Number(stats.followingCount) || 0;
      out.likes = Number(stats.heartCount) || 0;
      out.posts = Number(stats.videoCount) || 0;
    }
    if (user) {
      out.name = user.nickname || "";
      out.bio = cleanText(user.signature || "");
      out.website = user.bioLink?.link || "";
      out.verified = !!user.verified;
    }

    if (!out.name) {
      const desc = firstMatch(html, [/<meta[^>]+name="description"[^>]+content="([^"]*)"/i]);
      const d = cleanText(desc);
      out.name = firstMatch(d, [/TikTok 上的\s*(.+?)\s*\(@/i, /^(.+?)\s*\(@/i]);
      out.bio = out.bio || firstMatch(d, [/\|\s*(.+?)\.?\s*观看/i]);
      out.followers = out.followers || parseCount(firstMatch(d, [/([\d.,]+[KkMmBb]?)\s*Followers/i, /粉丝数?[:：]?\s*([\d.,]+[KkMmBb]?)/i]));
    }
    if (!out.name && !out.followers) out.error = `没解析到账号数据（${html.length} 字节），账号可能不存在`;
    out.ok = !!(out.name || out.followers);
    out.email = (out.bio.match(EMAIL_RE) || [])[0] || "";
  } catch (e) {
    out.ok = false;
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

// ---------------- Facebook ----------------
export async function fetchFacebook(handle, opts = {}) {
  const url = `https://www.facebook.com/${handle}`;
  const out = base("facebook", handle, url);
  try {
    const html = await dumpDom(url, { budget: opts.budget || 14000, timeout: opts.timeout || 70000 });
    const text = cleanText(html.slice(0, 400000));

    out.name = cleanText(firstMatch(html, [/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i]));
    const desc = cleanText(firstMatch(html, [/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i]));
    out.bio = clip(desc, 500);

    // og:description 里通常直接写着「1,317,209 位粉丝 · 32,396 人在谈论」，
    // 比在整页 DOM 里碰运气稳得多；抓不到再回落到正文
    const dm = desc.match(/([\d.,]+\s*[KkMmBb万]?)\s*(?:位粉丝|followers?|人关注)/i);
    const lm = desc.match(/([\d.,]+\s*[KkMmBb万]?)\s*(?:人点赞|位用户赞了|likes?)/i);
    const fm = desc.match(/([\d.,]+\s*[KkMmBb万]?)\s*(?:人在谈论|talking about)/i);
    out.followers = parseCount(dm?.[1]) || parseCount(firstMatch(text, [/([\d.,]+[KkMmBb]?)\s*(?:位粉丝|followers?|人关注)/i]));
    out.likes = parseCount(lm?.[1]) || parseCount(firstMatch(text, [/([\d.,]+[KkMmBb]?)\s*(?:人点赞|位用户赞了|likes?)/i]));
    out.talking = parseCount(fm?.[1]);

    out.website = firstMatch(html, [/"website":"((?:[^"\\]|\\.)*)"/, /rel="me"[^>]+href="([^"]+)"/]).replace(/\\\//g, "/");
    out.phone = firstMatch(text, [/(\+\d[\d\s().\-]{7,18})/]);
    out.email = firstMatch(text, [EMAIL_RE]);
    out.ok = !!(out.name || out.likes || out.followers);
    if (!out.ok) out.error = `没解析到主页数据（${html.length} 字节），可能需要登录或页面不存在`;
  } catch (e) {
    out.ok = false;
    out.error = String(e.message || e).slice(0, 200);
  }
  return out;
}

function base(platform, handle, url) {
  return {
    platform, handle, url,
    name: "", bio: "", website: "", email: "", phone: "",
    followers: 0, following: 0, posts: 0, likes: 0,
    avatar: "", verified: false,
    ok: false, needLogin: false, error: "",
  };
}

/** 统一入口：首次失败重试一次（Chrome 偶发拿不到完整 DOM） */
export async function fetchProfile(platform, handle, opts = {}) {
  if (!handle) return { ...base(platform, "", ""), error: "缺少账号名" };
  const call = () => {
    if (platform === "instagram") return fetchInstagram(handle, opts);
    if (platform === "tiktok") return fetchTikTok(handle, opts);
    if (platform === "facebook") return fetchFacebook(handle, opts);
    return Promise.resolve({ ...base(platform, handle, ""), error: `不支持的平台：${platform}` });
  };

  const first = await call();
  if (first.ok || first.needLogin) return first;

  await new Promise((r) => setTimeout(r, 1500));
  const second = await call();
  if (second.ok || second.needLogin) return second;
  return second.error ? second : first;
}

export { profileState };
