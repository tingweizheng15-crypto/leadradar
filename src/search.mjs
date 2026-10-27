import { searchReady } from "./config.mjs";
import { proxiedFetch } from "./net.mjs";
import {MARKETS} from './localization.mjs';

async function httpJson(cfg, url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const signal = opts.signal ? AbortSignal.any([ctrl.signal, opts.signal]) : ctrl.signal;
    const res = await proxiedFetch(cfg, url, { ...opts, signal, redirect: "follow" }, timeoutMs);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}：搜索服务请求失败`);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export function providerName(cfg) {
  const map = { serper: "Serper(Google)", bing: "Bing Web Search", google_cse: "Google Custom Search" };
  return map[cfg.search.provider] || cfg.search.provider;
}

async function serper(cfg, query, count, context = {}) {
  const s = cfg.search.serper;
  const data = await httpJson(cfg, s.endpoint, {
    method: "POST",
    headers: { "X-API-KEY": s.apiKey, "Content-Type": "application/json" },
    signal: context.signal,
    body: JSON.stringify({ q: query, num: count, gl: context.gl || MARKETS[context.country]?.gl || 'us', hl: context.hl || MARKETS[context.country]?.hl || 'en' }),
  }, cfg.search.timeout_ms);
  return (data.organic || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

async function bing(cfg, query, count) {
  const b = cfg.search.bing;
  const url = `${b.endpoint}?q=${encodeURIComponent(query)}&count=${count}&mkt=${b.market}`;
  const data = await httpJson(cfg, url, { headers: { "Ocp-Apim-Subscription-Key": b.apiKey } }, cfg.search.timeout_ms);
  return (data.webPages?.value || []).map((r) => ({ title: r.name, url: r.url, snippet: r.snippet || "" }));
}

async function googleCse(cfg, query, count, context = {}) {
  const g = cfg.search.google_cse;
  const market=MARKETS[context.country]||MARKETS.US;const url=new URL(g.endpoint);
  for(const [key,value]of Object.entries({key:g.apiKey,cx:g.cx,q:query,num:count,gl:context.gl||market.gl,hl:context.hl||market.hl,lr:'lang_'+(context.hl||market.hl)}))url.searchParams.set(key,value);
  const data = await httpJson(cfg, url, {signal:context.signal}, cfg.search.timeout_ms);
  return (data.items || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
}

export async function search(cfg, query, count, context = {}) {
  if (!searchReady(cfg)) return null;
  const p = cfg.search.provider;
  if (p === "serper") return serper(cfg, query, count, context);
  if (p === "bing") return bing(cfg, query, count);
  if (p === "google_cse") return googleCse(cfg, query, count, context);
  return null;
}
