import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 打包成 EXE 后，程序文件在只读的安装目录，可写数据（.env / out / state）由启动器通过 LR_ROOT 指定
export const ROOT = process.env.LR_ROOT ? path.resolve(process.env.LR_ROOT) : path.resolve(__dirname, "..");

export function loadEnvFile() {
  const p = path.join(ROOT, ".env");
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

export function loadConfig() {
  const fileEnv = loadEnvFile();
  const env = { ...fileEnv, ...process.env };
  const cfgPath = path.join(ROOT, "config.json");
  const exPath = path.join(ROOT, "config.example.json");
  const src = fs.existsSync(cfgPath) ? cfgPath : exPath;
  const cfg = JSON.parse(fs.readFileSync(src, "utf8"));

  // 代理优先级：config.json 的 proxy > .env 的 HTTPS_PROXY > 系统环境变量。
  // 之前 .env 里的 HTTPS_PROXY 谁都不读，用户照着文档填了却不生效。
  const proxy = fileEnv.HTTPS_PROXY || env.HTTPS_PROXY || fileEnv.HTTP_PROXY || env.HTTP_PROXY || "";
  if (!cfg.proxy && proxy) cfg.proxy = proxy;

  // CHROME_PATH 同理：写进 .env 也要能用（findChrome 读的是 process.env）
  const chromePath = fileEnv.CHROME_PATH || env.CHROME_PATH || "";
  if (chromePath && !process.env.CHROME_PATH) process.env.CHROME_PATH = chromePath;

  const s = cfg.search || (cfg.search = {});
  // 换搜索源不用改 config.json：操作台/`.env` 里写 SEARCH_PROVIDER=bing / google_cse 即可
  if (env.SEARCH_PROVIDER) s.provider = env.SEARCH_PROVIDER;
  const serper = s.serper || (s.serper = {});
  const bing = s.bing || (s.bing = {});
  const g = s.google_cse || (s.google_cse = {});
  if (env.SERPER_API_KEY) serper.apiKey = env.SERPER_API_KEY;
  if (env.BING_API_KEY) bing.apiKey = env.BING_API_KEY;
  if (env.GOOGLE_CSE_KEY) g.apiKey = env.GOOGLE_CSE_KEY;
  if (env.GOOGLE_CSE_CX) g.cx = env.GOOGLE_CSE_CX;

  const ef = cfg.contacts?.email_finder || (cfg.contacts.email_finder = {});
  // 操作台切换查找服务时只写 .env，不动 config.json；这里做一次覆盖
  if (env.EMAIL_FINDER_PROVIDER) ef.provider = String(env.EMAIL_FINDER_PROVIDER).trim();
  const hunter = ef.hunter || (ef.hunter = {});
  const apollo = ef.apollo || (ef.apollo = {});
  const snov = ef.snov || (ef.snov = {});
  if (env.HUNTER_API_KEY) hunter.apiKey = env.HUNTER_API_KEY;
  if (env.APOLLO_API_KEY) apollo.apiKey = env.APOLLO_API_KEY;
  if (env.SNOV_USER_ID) snov.userId = env.SNOV_USER_ID;
  if (env.SNOV_SECRET) snov.secret = env.SNOV_SECRET;

  const llm = cfg.llm || (cfg.llm = {});
  if (env.LLM_API_KEY) llm.api_key = env.LLM_API_KEY;
  if (env.LLM_BASE_URL) llm.base_url = env.LLM_BASE_URL;
  if (env.LLM_MODEL) llm.model = env.LLM_MODEL;
  // 思考型模型（deepseek-reasoner / deepseek-flash / o1 等）的思考 token 也吃 max_tokens，
  // 1500 常常在思考阶段就见底，导致正文为空。默认给足，可用 LLM_MAX_TOKENS 覆盖。
  const mt = Number(env.LLM_MAX_TOKENS || llm.max_tokens || 0);
  llm.max_tokens = Number.isFinite(mt) && mt > 0 ? Math.min(32000, Math.round(mt)) : 4000;
  if (env.LLM_JSON_MODE) llm.json_mode = !/^(0|false|no|off)$/i.test(String(env.LLM_JSON_MODE).trim());

  return cfg;
}

export function llmReady(cfg) {
  return !!(cfg.llm?.api_key && cfg.llm?.model);
}

export function searchReady(cfg) {
  const p = cfg.search.provider;
  if (p === "serper") return !!cfg.search.serper?.apiKey;
  if (p === "bing") return !!cfg.search.bing?.apiKey;
  if (p === "google_cse") return !!(cfg.search.google_cse?.apiKey && cfg.search.google_cse?.cx);
  return false;
}

export function emailFinderReady(cfg) {
  const p = cfg.contacts.email_finder.provider;
  if (p === "hunter") return !!cfg.contacts.email_finder.hunter?.apiKey;
  if (p === "apollo") return !!cfg.contacts.email_finder.apollo?.apiKey;
  if (p === "snov") return !!(cfg.contacts.email_finder.snov?.userId && cfg.contacts.email_finder.snov?.secret);
  return false;
}
