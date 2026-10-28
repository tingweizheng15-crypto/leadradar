import { searchReady } from "./config.mjs";
import { proxiedFetch } from "./net.mjs";

async function httpJson(cfg, url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await proxiedFetch(cfg, url, { ...opts, signal: ctrl.signal, redirect: "follow" }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export function providerName(cfg) {
  const map = { serper: "Serper(Google)", bing: "Bing Web Search", google_cse: "Google Custom Search" };
  return map[cfg.search.provider] || cfg.search.provider;
}

// 按目标市场决定 Google 的地区/语言参数。
// 之前写死 gl=us&hl=en，等于每次都用「美国英语用户」的视角搜韩国/泰国品牌，
// 返回的自然全是卖货到当地的美国站（runningwarehouse / 2XU US 这类），
// 而不是当地需要贴牌的小品牌——这是搜索结果天天一个样的根因之一。
const GEO = {
  KR: { gl: "kr", hl: "ko", mkt: "ko-KR" },
  TH: { gl: "th", hl: "th", mkt: "th-TH" },
  ID: { gl: "id", hl: "id", mkt: "id-ID" },
  MY: { gl: "my", hl: "ms", mkt: "ms-MY" },
  US: { gl: "us", hl: "en", mkt: "en-US" },
  UK: { gl: "uk", hl: "en", mkt: "en-GB" },
};

function geoFor(query, country) {
  const g = GEO[country] || { gl: "us", hl: "en", mkt: "en-US" };
  // 查询本身是本地语言（韩文/泰文等）时用本地语言界面；英文词保持英文，避免命中率下降
  const hasLocalScript = /[^\x00-\x7F]/.test(String(query || ""));
  return { gl: g.gl, hl: hasLocalScript ? g.hl : "en", mkt: g.mkt };
}

async function serper(cfg, query, count, country) {
  const s = cfg.search.serper;
  const { gl, hl } = geoFor(query, country);
  const data = await httpJson(cfg, s.endpoint, {
    method: "POST",
    headers: { "X-API-KEY": s.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: count, gl, hl }),
  }, cfg.search.timeout_ms);
  return (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

async function bing(cfg, query, count, country) {
  const b = cfg.search.bing;
  const { mkt } = geoFor(query, country);
  const market = country ? mkt : b.market;
  const url = `${b.endpoint}?q=${encodeURIComponent(query)}&count=${count}&mkt=${market}`;
  const data = await httpJson(cfg, url, { headers: { "Ocp-Apim-Subscription-Key": b.apiKey } }, cfg.search.timeout_ms);
  return (data.webPages?.value || []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet || "" }));
}

async function googleCse(cfg, query, count, country) {
  const g = cfg.search.google_cse;
  const { gl, hl } = geoFor(query, country);
  const url = `${g.endpoint}?key=${g.apiKey}&cx=${g.cx}&q=${encodeURIComponent(query)}&num=${count}&gl=${gl}&hl=${hl}`;
  const data = await httpJson(cfg, url, {}, cfg.search.timeout_ms);
  return (data.items || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

export async function search(cfg, query, count, opts = {}) {
  if (!searchReady(cfg)) return null;
  const country = opts.country || "";
  const p = cfg.search.provider;
  if (p === "serper") return serper(cfg, query, count, country);
  if (p === "bing") return bing(cfg, query, count, country);
  if (p === "google_cse") return googleCse(cfg, query, count, country);
  return null;
}
