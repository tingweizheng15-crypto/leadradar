export const PRODUCTS = {
  compression_tights: "压缩裤",
  running_singlet: "跑步背心",
  running_shorts: "跑步短裤",
  quick_dry: "速干衣",
  tight_pants: "紧身裤",
};

export const COUNTRIES = { KR: "韩国", TH: "泰国", US: "美国", UK: "英国", ID: "印尼", MY: "马来西亚" };

export const TYPES = {
  brand: { label: "自有品牌 / DTC", role: 20 },
  distributor: { label: "进口分销 / 代理", role: 19 },
  retail: { label: "专业零售连锁", role: 17 },
  event: { label: "赛事 / 跑团 / 定制", role: 15 },
  manufacturer: { label: "品牌 + 制造", role: 11 },
};

const ROLE_KEYWORDS = [
  [/distribut|agent|代理|import|수입|ตัวแทนจำหน่าย/i, "distributor"],
  [/retail|store|shop|门店|매장|ร้านค้า/i, "retail"],
  [/factory|manufactur|공장|โรงงาน|oem.*maker/i, "manufacturer"],
  [/marathon|race|run club|event|赛事|跑团|มาราธอน|마라톤/i, "event"],
  [/brand|design|label|브랜드|แบรนด์/i, "brand"],
];

export function guessType(lead) {
  const text = [lead.name, lead.title, ...(lead.signals || [])].join(" ").toLowerCase();
  for (const [re, type] of ROLE_KEYWORDS) if (re.test(text)) return type;
  return lead.type || "brand";
}

export function statusOf(score) {
  return score >= 80 ? "qualified" : score >= 60 ? "review" : "rejected";
}

export function statusLabel(s) {
  return s === "qualified" ? "合格" : s === "review" ? "待复核" : "已排除";
}

export function recompute(lead) {
  lead.total = Math.min(100, Math.round(Object.values(lead.scores || {}).reduce((a, b) => a + b, 0)));
  lead.status = statusOf(lead.total);
  lead.statusLabel = statusLabel(lead.status);
  return lead;
}

const OEM_KEY = /private label|white label|custom logo|oem|odm|贴牌|代工|定制|customiz|personaliz|bespoke|your brand|made to order|주문제작|맞춤|รับผลิต|สั่งทำ/i;

function oemScore(lead) {
  const hay = [...(lead.signals || []), lead.snippet || "", lead.typeLabel || "", lead.type || ""].join(" ");
  const hasCustomSignal = (lead.signals || []).some((s) => /定制|OEM|贴牌/.test(s)) || OEM_KEY.test(hay);
  if (hasCustomSignal) return 13;
  if (["brand", "distributor", "event"].includes(lead.type)) return 8;
  return 2;
}

const PRODUCT_ALIAS = {
  singlet: "running_singlet",
  vest: "running_singlet",
  running_vest: "running_singlet",
  tight_pants: "compression_tights",
  tights: "compression_tights",
  leggings: "compression_tights",
  legging: "compression_tights",
  quick_dry_shirt: "quick_dry",
};
const canon = (p) => PRODUCT_ALIAS[p] || p;

export function scoreLead(lead, cfg) {
  const products = cfg.products || [];
  const markets = cfg.markets || [];
  const leadProds = new Set((lead.products || []).map(canon));
  const overlap = products.filter((p) => leadProds.has(canon(p)));

  let productScore;
  if (overlap.length === 0) productScore = 0;
  else if (overlap.length === 1) productScore = 15;
  else if (overlap.length === 2) productScore = 20;
  else productScore = 25;

  const type = guessType(lead);
  const roleScore = TYPES[type]?.role ?? 10;

  const geoScore = markets.includes(lead.country) ? (lead.countrySource === "query_guess" ? 5 : 10) : 0;

  let readiness = 3;
  if (lead.url) readiness += 3;
  if ((lead.social || []).length) readiness += 3;
  if ((lead.emails || []).length || (lead.phones || []).length) readiness += 3;
  readiness = Math.min(12, readiness);

  const activity = Math.min(10, 2 + Math.round((lead.signals || []).length * 2.0));

  const oem = oemScore(lead);

  const evidence = lead.evidence === "official" ? 10 : lead.evidence === "news" ? 8 : lead.evidence === "directory" ? 6 : 5;

  const total = Math.min(100, Math.round(productScore + roleScore + geoScore + readiness + activity + oem + evidence));

  lead.overlap = overlap;
  lead.type = type;
  lead.typeLabel = TYPES[type]?.label || type;
  lead.oem = oem;
  lead.scores = { product: productScore, role: roleScore, geo: geoScore, readiness, activity, oem, evidence };
  lead.total = total;
  lead.status = statusOf(total);
  lead.statusLabel = statusLabel(lead.status);
  return lead;
}

export function dedupeByDomain(leads) {
  const map = new Map();
  for (const l of leads) {
    const k = l.domain || l.url;
    if (!k) continue;
    if (!map.has(k) || l.total > map.get(k).total) map.set(k, l);
  }
  return [...map.values()];
}
