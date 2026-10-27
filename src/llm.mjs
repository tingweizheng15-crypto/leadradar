import { llmReady } from "./config.mjs";
import { proxiedFetch } from "./net.mjs";

function normalizeBaseUrl(base) {
  let b = String(base || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (b.endsWith("/chat/completions")) return b;
  return b + "/chat/completions";
}

export async function callLLM(cfg, messages, { temperature = 0.3, maxTokens, json = false } = {}) {
  const llm = cfg.llm || {};
  const url = normalizeBaseUrl(llm.base_url);
  if (!url || !llm.api_key) throw new Error("LLM 未配置");
  const budget = Math.max(256, Number(maxTokens || llm.max_tokens || 4000));
  const wantJson = json || llm.json_mode !== false;

  // 先按 JSON 模式请求；服务商不支持 response_format 时自动降级重试一次
  let res = await post(url, budget, true);
  if (!res.ok && wantJson && res.status === 400 && /response_format|json.?mode|not supported|unsupported/i.test(res.text)) {
    res = await post(url, budget, false);
  }
  if (!res.ok) throw new Error(friendly(url, llm.model, res.status, res.text));

  let data;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new Error(`大模型返回的不是 JSON（HTTP 200 但正文异常）：${res.text.slice(0, 160)}`);
  }

  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  const content = String(msg.content || "");
  const reasoning = String(msg.reasoning_content || msg.reasoning || "");
  const finish = choice.finish_reason || "";
  const usage = data.usage || {};

  if (finish === "length") {
    const why = reasoning && !content
      ? `思考阶段把 ${budget} token 用完了，正文一个字都没输出`
      : `输出在 ${budget} token 处被截断`;
    throw new Error(`大模型输出不完整（finish_reason=length）：${why}。到「密钥与代理 → 更多密钥」把 LLM_MAX_TOKENS 调到 8000，或换成非思考模型。`);
  }
  if (!content.trim()) {
    const think = (usage.completion_tokens_details?.reasoning_tokens || 0) || (reasoning ? Math.round(reasoning.length / 3) : 0);
    throw new Error(`模型返回空内容（finish_reason=${finish || "?"}${think ? `，思考用了约 ${think} token` : ""}）。这是思考型模型的典型症状，把 LLM_MAX_TOKENS 调大（如 8000），或改用 deepseek-chat 这类非思考模型。`);
  }
  return content;

  async function post(u, budget, useJson) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 90000);
    try {
      const body = {
        model: llm.model,
        messages,
        temperature,
        max_tokens: budget,
        stream: false,
      };
      if (useJson) body.response_format = { type: "json_object" };
      const r = await proxiedFetch(cfg, u, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${llm.api_key}` },
        body: JSON.stringify(body),
      }, 90000);
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    } catch (e) {
      if (e.name === "AbortError") throw new Error(`大模型 90 秒未返回（${url}）。思考型模型偶发超长思考，建议调大超时或换非思考模型。`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }
}

/** 把常见配置错误翻译成人能看懂的话，别只丢一个 405/401 */
function friendly(url, model, status, text) {
  const body = String(text || "").slice(0, 160);
  if (status === 405 || status === 404) {
    return `大模型地址不对：${url} 返回 ${status}。LLM_BASE_URL 要填 API 地址（如 https://api.deepseek.com/v1），不是官网首页。原文：${body}`;
  }
  if (status === 401 || status === 403) {
    return `大模型鉴权失败（${status}）：key 无效或不属于这个地址。检查 LLM_API_KEY 与 LLM_BASE_URL 是否配套。原文：${body}`;
  }
  if (status === 400 && /model/i.test(body)) {
    return `模型名不存在：${model}。改成该服务商文档里的模型名（DeepSeek 是 deepseek-chat / deepseek-reasoner）。原文：${body}`;
  }
  if (status === 402 || /insufficient|balance|quota/i.test(body)) {
    return `大模型余额不足或被限流（${status}）。原文：${body}`;
  }
  return `LLM HTTP ${status}: ${body}`;
}

export function parseJson(content) {
  if (!content) return null;
  const attempt = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  const clean = (s) => String(s || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/,\s*([}\]])/g, "$1")
    .trim();

  // 1) 去掉 ``` 代码块包裹，模型经常不听话
  const fence = content.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    const hit = attempt(clean(fence[1]));
    if (hit && typeof hit === "object") return hit;
  }

  // 2) 直接整体解析
  const whole = attempt(clean(content));
  if (whole && typeof whole === "object") return whole;

  // 3) 从第一个 { 开始做括号配平，取第一个完整对象（贪婪正则会把多个对象粘在一起）
  const start = content.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < content.length; i++) {
      const ch = content[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > start) {
      const hit = attempt(clean(content.slice(start, end + 1)));
      if (hit && typeof hit === "object") return hit;
    }
    // 4) 被截断的 JSON：尽力补全括号再试一次，能救回一部分字段总比全丢好
    const tail = clean(content.slice(start));
    const open = (tail.match(/\{/g) || []).length;
    const close = (tail.match(/\}/g) || []).length;
    if (open > close) {
      const quoteOpen = (tail.split('"').length - 1) % 2 === 1;
      const repaired = attempt(tail + (quoteOpen ? '"' : "") + "}".repeat(open - close));
      if (repaired && typeof repaired === "object") return repaired;
    }
  }
  return null;
}

const SYSTEM_PROMPT = `你是外贸获客助手。根据给定公司信息，判断它是否是中国跑步服饰供应商（压缩裤/跑步背心/跑步短裤/速干衣，支持定制 LOGO 和版型）的潜在 B2B 买家。
只输出一个 JSON 对象，不要输出任何其他文字。字段：
{
 "is_buyer": true/false,
 "buyer_type": "brand|distributor|retail|event|manufacturer",
 "oem_need": 0到13的整数（判断该公司是否需要贴牌/定制/OEM，需求越明确分越高）,
 "fit": "一句话匹配理由（中文）",
 "contact_hint": "建议联系谁、走什么渠道（如：官网 wholesale 表单 / Instagram DM / LINE 官方号）",
 "language": "开发信用什么语言，如 en / ko / th",
 "draft": "用上述语言写的开发信草稿，3-5句，自然口语，点到其卖点或定制需求，不要空话套话，不要画册式推销"
}`;

export async function analyzeLead(cfg, lead) {
  if (!llmReady(cfg)) return null;
  const user = [
    `公司名：${lead.name || ""}`,
    `官网：${lead.url || ""}`,
    `国家：${lead.country || "未知"}`,
    `已检测信号：${(lead.signals || []).join("、") || "无"}`,
    `页面摘要：${(lead.text || lead.snippet || "").slice(0, 2000)}`,
  ].join("\n");
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];

  let why = "";
  // 思考型模型偶发空响应/格式漂移，重试一次（降温度）能救回大部分
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const content = await callLLM(cfg, messages, { temperature: attempt === 0 ? 0.3 : 0.1, json: true });
      const j = parseJson(content);
      if (j && typeof j === "object" && j.is_buyer !== undefined) return j;
      why = j
        ? `返回的 JSON 缺少 is_buyer 字段：${JSON.stringify(j).slice(0, 100)}`
        : `返回内容不是合法 JSON：${content.replace(/\s+/g, " ").slice(0, 120)}`;
    } catch (e) {
      why = String(e.message || e).slice(0, 220);
      // 配置类错误重试也没用，直接抛给上层
      if (/地址不对|鉴权失败|余额不足|模型名不存在|未配置|LLM HTTP 4/.test(why)) break;
    }
  }
  return { error: why };
}
