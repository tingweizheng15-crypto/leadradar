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

  // 本地语检索词里通常没有 "Korea/Thailand" 这种英文国家名，
  // 认不出来就会退回默认的 gl=us，等于拿美国视角搜韩语词——必须按文字特征判断
  function countryByScript(text) {
    const t = String(text || "");
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(t)) return "KR"; // 韩文
    if (/[\u0E00-\u0E7F]/.test(t)) return "TH";              // 泰文
    if (/\b(grosir|celana|rompi|konveksi|kaos|sepatu|olahraga)\b/i.test(t)) return "ID";
    if (/\b(borong|seluar|pembekal|baju|sukan|kasut)\b/i.test(t)) return "MY";
    // 英语词靠地理标记区分：UK 必须先判，否则 "uk" 会被 US 的 \bus\b 吃掉
    if (/\b(uk|u\.k|united kingdom|britain|england|london)\b/i.test(t)) return "UK";
    if (/\b(usa|u\.s\.a|united states|america)\b/i.test(t)) return "US";
    return "";
  }

  // 本地语里的产品词和英文完全不同，不映射的话评分里的「产品匹配」维度会一直是 0
  function productByScript(text) {
    const t = String(text || "");
    // 瑜伽裤不属于「压缩裤」：只认 yoga 而没提压缩/压迫的，别硬算成产品匹配（会虚高评分）
    if (/요가|yoga|โยคะ/i.test(t) && !/압축|압박|compression|รัดกล้ามเนื้อ|คอมเพรส/i.test(t)) return "";
    if (/압축|타이즈|레깅스|กางเกงรัด|รัดกล้ามเนื้อ|กางเกงคอมเพรส|compression|ketat|tight/i.test(t)) return "compression_tights";
    if (/싱글렛|เสื้อกล้าม|rompi|singlet|마라톤|มาราธอน|marathon/i.test(t)) return "running_singlet";
    if (/티셔츠|속건|เสื้อแห้งเร็ว|kaos|baju|quick.?dry|티\b/i.test(t)) return "quick_dry";
    if (/반바지|กางเกงวิ่ง|celana lari|seluar lari|shorts/i.test(t)) return "running_shorts";
    return "";
  }

  const customRaw = (Array.isArray(s.custom_queries) ? s.custom_queries : []).map(clean).filter(Boolean);
  const customList = customRaw.map((text) => {
    const low = text.toLowerCase();
    const p = products.find((x) => low.includes(String(productTerms[x] || x).toLowerCase())) || productByScript(text) || "";
    // 短国家码（US/UK/ID/MY）必须按整词匹配，否则 "sukan" 里的 "uk" 会把马来语词判成英国
    let c = markets.find((x) => {
      const term = String(countryTerms[x] || x);
      if (term.length <= 3 && /^[A-Za-z]+$/.test(term)) {
        return new RegExp(`(^|[^A-Za-z])${term}([^A-Za-z]|$)`, "i").test(text);
      }
      return low.includes(term.toLowerCase());
    }) || "";
    if (!c) {
      // site:.co.kr 这类后缀也能定国家
      for (const [suffix, code] of TLD_MAP) {
        if (low.includes(suffix) && markets.includes(code)) { c = code; break; }
      }
    }
    if (!c) {
      const byScript = countryByScript(text);
      if (byScript && (!markets.length || markets.includes(byScript))) c = byScript;
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

  // 社媒份额：按比例，但必须给主体留位置。
  // 之前写死「至少 3 条」，预算只有 3 时会算出 主体 0 + 社媒 3，
  // 而社媒检索在 Google 上几乎全返回帖子页（实测 72 条 0 个主页），等于白跑。
  const share = Math.round(budget * ratio);
  const floor = budget >= 10 ? 3 : 1;   // 小预算时不要把额度全给社媒
  const socialCap = socials.length
    ? Math.min(socials.length, Math.max(floor, Math.min(share, budget - 1)))
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
