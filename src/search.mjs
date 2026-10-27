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

async function serper(cfg, query, count) {
  const s = cfg.search.serper;
  const data = await httpJson(cfg, s.endpoint, {
    method: "POST",
    headers: { "X-API-KEY": s.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: count, gl: "us", hl: "en" }),
  }, cfg.search.timeout_ms);
  return (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

async function bing(cfg, query, count) {
  const b = cfg.search.bing;
  const url = `${b.endpoint}?q=${encodeURIComponent(query)}&count=${count}&mkt=${b.market}`;
  const data = await httpJson(cfg, url, { headers: { "Ocp-Apim-Subscription-Key": b.apiKey } }, cfg.search.timeout_ms);
  return (data.webPages?.value || []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet || "" }));
}

async function googleCse(cfg, query, count) {
  const g = cfg.search.google_cse;
  const url = `${g.endpoint}?key=${g.apiKey}&cx=${g.cx}&q=${encodeURIComponent(query)}&num=${count}`;
  const data = await httpJson(cfg, url, {}, cfg.search.timeout_ms);
  return (data.items || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

export async function search(cfg, query, count) {
  if (!searchReady(cfg)) return null;
  const p = cfg.search.provider;
  if (p === "serper") return serper(cfg, query, count);
  if (p === "bing") return bing(cfg, query, count);
  if (p === "google_cse") return googleCse(cfg, query, count);
  return null;
}
