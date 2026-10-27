import { fetchHtml, enrichSite, detectSignals } from "./enrich.mjs";
import { resolveProxy } from "./net.mjs";

export function parseSocialUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    let platform = "", handle = "";
    if (/instagram\.com/.test(h)) {
      platform = "instagram";
      const m = u.pathname.match(/^\/([a-zA-Z0-9_.]+)/);
      handle = m ? m[1] : "";
    } else if (/tiktok\.com/.test(h)) {
      platform = "tiktok";
      const m = u.pathname.match(/^\/@([a-zA-Z0-9_.]+)/);
      handle = m ? m[1] : "";
    } else if (/facebook\.com/.test(h)) {
      platform = "facebook";
      const m = u.pathname.match(/^\/([a-zA-Z0-9_.]+)/);
      handle = m ? m[1] : "";
    }
    return { platform, handle };
  } catch { return { platform: "", handle: "" }; }
}

export function isSocialUrl(url) {
  return /instagram\.com|tiktok\.com|facebook\.com/i.test(String(url || ""));
}

export async function fetchInstagramProfile(handle, proxy = "") {
  const url = `https://www.instagram.com/${handle}/embed/`;
  const html = await fetchHtml(url, { timeout: 8000, maxBytes: 1500000, useChrome: false, proxy });
  if (!html) return null;
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const bio = text.slice(0, 800);
  const website = (bio.match(/https?:\/\/[^\s]+/i) || [])[0] || "";
  const email = (html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/) || [])[0] || "";
  const followers = (text.match(/([\d.,]+[KkMm]?)\s*(?:Followers|粉丝)/i) || [])[1] || "";
  const posts = (text.match(/([\d.,]+[KkMm]?)\s*(?:Posts|帖子)/i) || [])[1] || "";
  return { name: handle, bio, website, email, followers, posts };
}

export async function enrichSocial(cfg, url) {
  const { platform, handle } = parseSocialUrl(url);
  const acc = { emails: [], phones: [], social: [], signals: [], title: "", text: "" };
  if (!platform || !handle) return acc;

  if (platform === "instagram") {
    const prof = await fetchInstagramProfile(handle, resolveProxy(cfg));
    if (prof) {
      acc.title = `${handle} (Instagram)`;
      acc.social.push({ platform: "instagram", handle, url: `https://www.instagram.com/${handle}/` });
      acc.text = prof.bio || "";
      if (prof.bio) acc.signals.push(...detectSignals(prof.bio));
      if (prof.email) acc.emails.push({ value: prof.email, source: "instagram-bio", confidence: "official" });
      if (prof.website && prof.website !== `https://www.instagram.com/${handle}/`) {
        try {
          const site = await enrichSite(cfg, prof.website);
          acc.emails.push(...site.emails);
          acc.phones.push(...site.phones);
          acc.social.push(...site.social);
          acc.signals.push(...site.signals);
          if (site.title) acc.title = site.title;
          acc.website = prof.website;
          acc.followers = prof.followers;
          acc.posts = prof.posts;
        } catch { /* 官网抓取失败不阻塞 */ }
      }
    }
  } else {
    const html = await fetchHtml(url, { timeout: 8000, maxBytes: 800000, useChrome: false, proxy: resolveProxy(cfg) });
    acc.title = `${handle} (${platform})`;
    acc.social.push({ platform, handle, url });
    if (html) {
      acc.text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1200);
      acc.signals.push(...detectSignals(acc.text));
    }
  }
  acc.social = [...new Map(acc.social.map((s) => [`${s.platform}:${s.handle}`, s])).values()];
  acc.signals = [...new Set(acc.signals)];
  acc.emails = [...new Map(acc.emails.map((e) => [e.value, e])).values()];
  acc.phones = [...new Map(acc.phones.map((p) => [p.value, p])).values()];
  return acc;
}

export function buildSocialQueries(cfg) {
  const prod = { compression_tights: "compression tights", running_singlet: "running singlet", running_shorts: "running shorts", quick_dry: "quick dry shirt" };
  const ct = { KR: "Korea", TH: "Thailand", US: "USA", UK: "UK", ID: "Indonesia", MY: "Malaysia" };
  const qs = [];
  for (const p of cfg.products) {
    for (const c of (cfg.markets || []).slice(0, 3)) {
      qs.push({ q: `site:instagram.com ${prod[p] || p} ${ct[c] || c}`, product: p, country: c, type: "brand", social: true });
      qs.push({ q: `site:tiktok.com ${prod[p] || p} ${ct[c] || c}`, product: p, country: c, type: "brand", social: true });
    }
  }
  return qs.slice(0, 24);
}
