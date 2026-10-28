/**
 * 检索词生成：所有词表都可以在 config.json / 操作台里改，不再写死在代码里。
 *
 * 模板占位符：{product} 产品词 · {buyer} 买家类型词 · {country} 国家词
 */

export const PRODUCT_TERMS = {
  compression_tights: "compression tights",
  running_singlet: "running singlet",
  running_shorts: "running shorts",
  quick_dry: "quick dry shirt",
  tight_pants: "tight sports pants",
};

export const COUNTRY_TERMS = {
  KR: "Korea",
  TH: "Thailand",
  US: "USA",
  UK: "UK",
  ID: "Indonesia",
  MY: "Malaysia",
};

export const BUYER_TERMS = {
  brand: "brand",
  distributor: "wholesale distributor",
  retail: "running store",
  event: "run club",
};

export const DEFAULT_TEMPLATES = [
  "{product} {buyer} {country}",
  "{product} OEM {country}",
  "{product} private label {country}",
];

export const DEFAULTS = {
  product_terms: PRODUCT_TERMS,
  country_terms: COUNTRY_TERMS,
  buyer_terms: BUYER_TERMS,
  query_templates: DEFAULT_TEMPLATES,
};

const clean = (v) => String(v == null ? "" : v).replace(/\s+/g, " ").trim();
const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    const s = clean(v);
    if (s) out[k] = s;
  }
  return out;
};

/**
 * @param {object} cfg
 * @param {{full?: boolean}} [opts] full=true 时返回未截断的完整列表，
 *        供 allocateQueries 和社媒检索式一起做预算分配
 * @returns {{queries: Array, generated: number, truncated: number, templates: string[], custom: number, mode: string}}
 */
export function buildQueries(cfg, { full = false } = {}) {
  const s = cfg.search || {};
  const productTerms = merge(PRODUCT_TERMS, s.product_terms);
  const countryTerms = merge(COUNTRY_TERMS, s.country_terms);
  const buyerTerms = merge(BUYER_TERMS, s.buyer_terms);

  const tplList = (Array.isArray(s.query_templates) ? s.query_templates : [])
    .map(clean).filter(Boolean);
  const templates = tplList.length ? tplList : DEFAULT_TEMPLATES.slice();

  const products = cfg.products || [];
  const markets = cfg.markets || [];
  const buyerTypes = (cfg.buyer_types && cfg.buyer_types.length) ? cfg.buyer_types : ["brand"];

  const combos = [];
  for (const p of products) for (const c of markets) combos.push({ p, c });

  const seen = new Set();
  const built = [];
  const push = (text, meta) => {
    const q = clean(text);
    const key = q.toLowerCase();
    if (!q || seen.has(key)) return;
    seen.add(key);
    built.push({ q, ...meta });
  };

  // 模板在外层、组合在内层：预算被截断时，先保证每个「产品×市场」都至少有一条
  for (const tpl of templates) {
    combos.forEach((combo, idx) => {
      const bt = buyerTypes[idx % buyerTypes.length];
      const q = tpl
        .replace(/\{product\}/g, productTerms[combo.p] || combo.p)
        .replace(/\{buyer\}/g, buyerTerms[bt] || bt)
        .replace(/\{country\}/g, countryTerms[combo.c] || combo.c);
      push(q, { product: combo.p, country: combo.c, type: bt });
    });
  }

  // 自定义检索式：原样保留，尽力回填产品/国家，好让评分维度照常生效
  const TLD_MAP = [["co.kr", "KR"], ["co.th", "TH"], ["co.id", "ID"], ["com.my", "MY"], ["co.uk", "UK"], [".kr", "KR"], [".th", "TH"], [".id", "ID"], [".my", "MY"], [".uk", "UK"]];

  const customRaw = (Array.isArray(s.custom_queries) ? s.custom_queries : []).map(clean).filter(Boolean);
  const customList = customRaw.map((text) => {
    const low = text.toLowerCase();
    const p = products.find((x) => low.includes(String(productTerms[x] || x).toLowerCase())) || "";
    let c = markets.find((x) => low.includes(String(countryTerms[x] || x).toLowerCase())) || "";
    if (!c) {
      // site:.co.kr 这类后缀也能定国家
      for (const [suffix, code] of TLD_MAP) {
        if (low.includes(suffix) && markets.includes(code)) { c = code; break; }
      }
    }
    return { q: text, product: p, country: c, type: "brand", custom: true };
  });

  const mode = s.custom_mode === "replace" ? "replace" : "append";
  let list = mode === "replace" ? customList : [...customList, ...built];
  if (!list.length) list = built; // replace 但没写自定义时，别把流程跑空

  const max = Math.min(200, Math.max(1, Number(s.max_queries_per_run) || 30));
  const queries = full ? list.slice() : list.slice(0, max);

  return {
    queries,
    generated: list.length,
    truncated: Math.max(0, list.length - queries.length),
    templates,
    custom: customList.length,
    mode,
  };
}

/**
 * 把「主体检索式」和「社媒检索式」按预算分配后交错排列。
 *
 * 之前的问题：主体自己就吃满了 max，社媒 24 条追加在后面被整体截断，
 * 实际一条社媒检索都没跑——所以报告里从来没有 Instagram / TikTok 出来的线索。
 *
 * 规则：社媒占 socialRatio（默认 25%，至少 3 条），剩下给主体；
 * 排列上每 3 条主体插 1 条社媒，避免社媒全部挤在末尾。
 *
 * 比例之所以不设太高：实测 Google 对 site:instagram.com 几乎只返回帖子页
 * （URL 里没有用户名，抓不出品牌），而 site:tiktok.com 的视频页还能提到 @账号。
 * 所以社媒检索是"补充"，主力仍是主体检索 + 官网反查社媒。
 */
export function allocateQueries(bodyList, socialList, max, { socialRatio = 0.25 } = {}) {
  const budget = Math.max(1, Number(max) || 30);
  const bodies = Array.isArray(bodyList) ? bodyList : [];
  const socials = Array.isArray(socialList) ? socialList : [];
  const ratio = Number(socialRatio) >= 0 && Number(socialRatio) <= 1 ? Number(socialRatio) : 0.25;

  const socialCap = socials.length
    ? Math.min(socials.length, Math.max(3, Math.round(budget * ratio)))
    : 0;
  const bodyCap = Math.max(0, budget - socialCap);

  const body = bodies.slice(0, bodyCap);
  const social = socials.slice(0, socialCap);

  const out = [];
  let bi = 0, si = 0;
  while (bi < body.length || si < social.length) {
    for (let k = 0; k < 3 && bi < body.length; k++) out.push(body[bi++]);
    if (si < social.length) out.push(social[si++]);
  }

  return {
    queries: out,
    budget,
    bodyCount: body.length,
    socialCount: social.length,
    bodyTotal: bodies.length,
    socialTotal: socials.length,
  };
}

/** 给操作台用：当前生效的完整词表（默认值 + 用户覆盖） */
export function effectiveTerms(cfg) {
  const s = cfg.search || {};
  return {
    product_terms: merge(PRODUCT_TERMS, s.product_terms),
    country_terms: merge(COUNTRY_TERMS, s.country_terms),
    buyer_terms: merge(BUYER_TERMS, s.buyer_terms),
    query_templates: (Array.isArray(s.query_templates) && s.query_templates.length ? s.query_templates : DEFAULT_TEMPLATES).map(clean).filter(Boolean),
    custom_queries: (Array.isArray(s.custom_queries) ? s.custom_queries : []).map(clean).filter(Boolean),
    custom_mode: s.custom_mode === "replace" ? "replace" : "append",
    max_queries_per_run: Math.min(200, Math.max(1, Number(s.max_queries_per_run) || 30)),
  };
}
