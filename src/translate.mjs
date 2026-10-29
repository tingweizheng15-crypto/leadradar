/**
 * 中文关键词 → 目标国家「本地人真实会搜的词」。
 *
 * 为什么不是直译：
 *   直译出来的词（比如「压缩紧身裤」→「압축 타이즈」）当地人根本不会那样搜。
 *   韩国人在 Coupang 搜「압축 레깅스」，泰国人在 Shopee 搜「กางเกงรัดกล้ามเนื้อ ขายส่ง」，
 *   印尼人搜「celana compression grosir」。差别在口语习惯和行业行话，不在字面。
 *
 * 两条路：
 *   1. 有大模型 key → 让模型按「本地电商搜索习惯」生成（质量最好，能跟上新词）
 *   2. 没 key / 调不通 → 内置词典兜底（覆盖跑步服饰常用词，离线也能用）
 */
import { llmReady } from "./config.mjs";
import { callLLM, parseJson } from "./llm.mjs";

export const MARKETS = {
  KR: "韩语",
  TH: "泰语",
  ID: "印尼语",
  MY: "马来语",
  US: "英语（美国）",
  UK: "英语（英国）",
};

/** 意图词：采购/代工这两种意图，各国说法差异最大 */
const INTENT = {
  wholesale: { KR: "도매", TH: "ขายส่ง", ID: "grosir", MY: "borong", US: "wholesale", UK: "wholesale" },
  oem: { KR: "OEM 제작", TH: "รับผลิต", ID: "konveksi", MY: "pengilang", US: "private label manufacturer", UK: "private label manufacturer" },
  supplier: { KR: "공급업체", TH: "ผู้ผลิต", ID: "supplier", MY: "pembekal", US: "supplier", UK: "supplier" },
  factory: { KR: "공장", TH: "โรงงาน", ID: "pabrik", MY: "kilang", US: "factory", UK: "factory" },
};

/**
 * 内置词典：故意用「当地人搜索时的写法」，不是词典式直译。
 * key 是中文里常见的叫法，value 是各国真实搜索词。
 */
const GLOSSARY = [
  {
    zh: ["压缩裤", "压缩紧身裤", "紧身裤", "压缩长裤", "leggings", "打底裤"],
    terms: {
      KR: "압축 레깅스",       // 韩国搜「압축 레깅스」，不是「압축 타이즈」
      TH: "กางเกงรัดกล้ามเนื้อ", // 泰国最常用说法，直译成「กางเกงบีบกล้ามเนื้อ」没人搜
      ID: "celana compression", // 印尼习惯夹英文 compression，不用 kompresi
      MY: "seluar compression",
      US: "compression tights",
      UK: "compression tights",
    },
  },
  {
    zh: ["跑步背心", "背心", "运动背心", "singlet", "无袖"],
    terms: {
      KR: "러닝 싱글렛",
      TH: "เสื้อกล้ามวิ่ง",
      ID: "rompi lari",
      MY: "singlet lari",
      US: "running singlet",
      UK: "running vest",
    },
  },
  {
    zh: ["跑步短裤", "短裤", "三分裤", "五分裤"],
    terms: {
      KR: "러닝 반바지",
      TH: "กางเกงวิ่งขาสั้น",
      ID: "celana lari pendek",
      MY: "seluar lari pendek",
      US: "running shorts",
      UK: "running shorts",
    },
  },
  {
    zh: ["速干衣", "速干t恤", "速干t", "运动t恤", "跑步t恤"],
    terms: {
      KR: "드라이핏 반팔",
      TH: "เสื้อวิ่งแห้งไว",
      ID: "kaos lari quick dry",
      MY: "baju lari quick dry",
      US: "quick dry running shirt",
      UK: "quick dry running shirt",
    },
  },
  {
    zh: ["运动内衣", "运动bra", "bra", "运动文胸"],
    terms: {
      KR: "스포츠 브라",
      TH: "สปอร์ตบรา",
      ID: "sport bra",
      MY: "sport bra",
      US: "sports bra",
      UK: "sports bra",
    },
  },
  {
    zh: ["瑜伽裤", "瑜伽紧身裤"],
    terms: {
      KR: "요가 레깅스",
      TH: "กางเกงโยคะ",
      ID: "celana yoga",
      MY: "seluar yoga",
      US: "yoga leggings",
      UK: "yoga leggings",
    },
  },
  {
    zh: ["跑步服", "运动服", "健身服", "运动装", "跑步装备"],
    terms: {
      KR: "러닝웨어",
      TH: "เสื้อผ้าวิ่ง",
      ID: "pakaian olahraga",
      MY: "pakaian sukan",
      US: "activewear",
      UK: "activewear",
    },
  },
  {
    zh: ["压缩衣", "压缩上衣", "压缩长袖"],
    terms: {
      KR: "압박 티셔츠",
      TH: "เสื้อรัดกล้ามเนื้อ",
      ID: "baju compression",
      MY: "baju compression",
      US: "compression shirt",
      UK: "compression base layer",
    },
  },
];

/** 从中文里认出意图，一个词可能命中多个（“批发代工”） */
function detectIntents(text) {
  const out = [];
  if (/批发|经销|分销|拿货|货源|进货/.test(text)) out.push("wholesale");
  if (/代工|oem|贴牌|定制|定做|打样|来图|加工/i.test(text)) out.push("oem");
  if (/供应商|厂家|厂商|工厂|制造/.test(text)) out.push("supplier");
  return out.length ? out : ["wholesale"];
}

/** 从中文里认出产品，返回命中的词典项 */
function detectProducts(text) {
  const low = text.toLowerCase();
  const hits = [];
  for (const g of GLOSSARY) {
    for (const z of g.zh) {
      if (low.includes(z.toLowerCase())) { hits.push(g); break; }
    }
  }
  return hits;
}

/** 词典兜底：没大模型时也能出结果 */
export function glossaryTranslate(lines, markets) {
  const items = [];
  for (const zh of lines) {
    const intents = detectIntents(zh);
    const prods = detectProducts(zh);
    if (!prods.length) {
      items.push({ zh, market: "", query: "", via: "none", note: "词典里没有这个产品词" });
      continue;
    }
    for (const m of markets) {
      for (const p of prods) {
        const base = p.terms[m];
        if (!base) continue;
        for (const it of intents) {
          const tail = INTENT[it]?.[m] || "";
          items.push({ zh, market: m, query: `${base} ${tail}`.replace(/\s+/g, " ").trim(), via: "glossary" });
        }
      }
    }
  }
  return items;
}

const SYSTEM = `你是跨境电商选品与采购关键词专家，专做「中文 → 当地人真实搜索词」的转换。

任务：把中文采购关键词，转成目标国家本地人在本地搜索引擎和电商平台（Naver、Coupang、Gmarket、Shopee、Lazada、Tokopedia、Google）里真实会输入的检索词。

硬要求：
1. 必须是当地人日常会打的口语/行话，不许直译，不许书面语，不许百科式说法。
2. 保留采购意图：批发 / 代工 / 定制 / 供应商，用当地行业里的固定说法。
   例：韩国 도매、제작 / 泰国 ขายส่ง、รับผลิต / 印尼 grosir、konveksi / 马来 borong、pembekal
3. 每条 2-5 个词，不加引号、不加引号、不加 OR/site: 等运算符。
4. 每个国家给 2 条：一条偏「批发/采购」，一条偏「代工/定制/OEM」。
5. 只用目标国语言（英语国家用英语）。不要混中文，不要加拼音。

参考（这些是真实搜索习惯，照这个风格写）：
- 压缩裤：韩 압축 레깅스（不是 압축 타이즈）｜泰 กางเกงรัดกล้ามเนื้อ（不是 กางเกงบีบกล้ามเนื้อ）｜印尼 celana compression（不用 kompresi）｜马来 seluar compression｜英 compression tights
- 批发：韩 도매｜泰 ขายส่ง｜印尼 grosir｜马来 borong｜英 wholesale
- 代工：韩 OEM 제작｜泰 รับผลิต｜印尼 konveksi｜马来 pengilang｜英 private label manufacturer

只输出 JSON，不要解释，不要 Markdown 代码块：
{"items":[{"zh":"原中文","KR":["...","..."],"TH":["...","..."],"ID":["...","..."],"MY":["...","..."],"US":["...","..."],"UK":["...","..."]}]}`;

async function llmTranslate(cfg, lines, markets) {
  const user = [
    `中文关键词（每行一条）：`,
    ...lines.map((l, i) => `${i + 1}. ${l}`),
    ``,
    `目标市场：${markets.map((m) => `${m}（${MARKETS[m] || m}）`).join("、")}`,
    `只需要这些市场的字段，其他市场可以省略。`,
  ].join("\n");
  const content = await callLLM(cfg, [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ], { temperature: 0.4, maxTokens: 3000 });
  const j = parseJson(content);
  if (!j || !Array.isArray(j.items)) throw new Error("模型没有返回预期的 JSON");
  const items = [];
  for (const it of j.items) {
    const zh = String(it.zh || "").trim();
    for (const m of markets) {
      const arr = Array.isArray(it[m]) ? it[m] : [];
      for (const q of arr) {
        const text = String(q || "").trim().replace(/^["'「]|["'」]$/g, "");
        if (text) items.push({ zh, market: m, query: text, via: "llm" });
      }
    }
  }
  return items;
}

/**
 * 英语国家的检索式要带地理标记。
 *
 * 「compression tights wholesale」这条美国词和英国词一模一样：
 *   - 后处理时国家认不出来 → 退回默认 gl=us，英国词也在用美国视角搜
 *   - 两条内容完全相同 → 白白多花一次检索额度
 * 所以给美国词补 USA、英国词补 UK（这也是真人写搜索词的习惯写法）。
 */
const GEO_MARK = {
  US: { re: /\b(usa|u\.s\.a|us|united states|america)\b/i, add: " USA" },
  UK: { re: /\b(uk|u\.k|united kingdom|britain|england)\b/i, add: " UK" },
};

function ensureGeoMarker(items) {
  return items.map((it) => {
    const m = GEO_MARK[it.market];
    if (!m || m.re.test(it.query)) return it;
    return { ...it, query: `${it.query}${m.add}` };
  });
}

/**
 * @param {object} cfg
 * @param {string} chineseText 中文关键词，一行一条
 * @param {string[]} markets 目标市场代码
 * @returns {Promise<{items:Array, usedLLM:boolean, warning:string}>}
 */
export async function translateKeywords(cfg, chineseText, markets) {
  const lines = String(chineseText || "")
    .split(/[\n,，、;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!lines.length) throw new Error("先输入中文关键词，一行一条");
  const mkts = (markets && markets.length ? markets : (cfg.markets || ["KR", "TH", "ID", "MY", "US", "UK"]))
    .filter((m) => MARKETS[m]);

  let items = [];
  let usedLLM = false;
  let warning = "";

  if (llmReady(cfg)) {
    try {
      items = await llmTranslate(cfg, lines, mkts);
      usedLLM = items.length > 0;
    } catch (e) {
      warning = "大模型翻译失败，已退回内置词典：" + String(e.message || e).slice(0, 120);
    }
  } else {
    warning = "没配大模型 key，用的是内置词典（覆盖跑步服饰常用词，新词可能翻不出来）";
  }

  // 模型没覆盖到的行，用词典补
  const covered = new Set(items.map((x) => x.zh));
  const missingLines = lines.filter((l) => !covered.has(l));
  if (missingLines.length) {
    const fallback = glossaryTranslate(missingLines, mkts).filter((x) => x.query);
    if (fallback.length) {
      items = items.concat(fallback);
      if (usedLLM) warning = (warning ? warning + "；" : "") + `有 ${missingLines.length} 条模型漏了，用词典补齐`;
    }
  }

  // 英语国家补地理标记（否则 US/UK 会重复且都按美国搜）
  items = ensureGeoMarker(items);

  // 去重，保留顺序
  const seen = new Set();
  items = items.filter((x) => {
    if (!x.query) return false;
    const k = `${x.market}:${x.query}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (!items.length) {
    warning = warning || "一条都没翻出来：换个更常见的产品词，或检查大模型配置";
  } else {
    // 个别词没翻出来时要说清楚是哪几个，别静默丢
    const stillMissing = lines.filter((l) => !items.some((x) => x.zh === l));
    if (stillMissing.length) {
      warning = (warning ? warning + "；" : "") + `${stillMissing.length} 条没翻出来：${stillMissing.slice(0, 3).join("、")}（换个更常见的说法，或检查大模型配置）`;
    }
  }
  return { items, usedLLM, warning };
}
