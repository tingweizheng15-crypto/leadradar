/**
 * 跨天去重：记住见过哪些域名，让每天的日报只报「今天新发现的」。
 *
 * 之前每次运行都从零开始，同样的检索词搜出同一批网站、每天重抓一遍，
 * 日报告自然天天一个样。这里把见过的域名落盘（data/seen.json），
 * 下一次运行优先跑没见过的；新域名不够时再用回访补位，避免日报开天窗。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

const DIR = path.join(ROOT, "data");
const FILE = path.join(DIR, "seen.json");

export function todayCN() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
}

function daysBetween(fromYmd, toYmd) {
  const t = (s) => Date.parse(`${s}T00:00:00Z`);
  const d = (t(toYmd) - t(fromYmd)) / 86400e3;
  return Number.isFinite(d) ? d : 9999;
}

export function loadSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

export function saveSeen(map) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(map), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * 把候选拆成「全新」与「回访」。
 * @returns {{fresh: Array, revisit: Array, total: number}}
 */
export function splitSeen(candidates, ttlDays = 14, today = todayCN()) {
  const seen = loadSeen();
  const fresh = [];
  const revisit = [];
  for (const c of candidates) {
    const last = seen[c.domain] || "";
    if (last && daysBetween(last, today) < ttlDays) revisit.push({ ...c, lastSeen: last });
    else fresh.push({ ...c, lastSeen: last || "" });
  }
  return { fresh, revisit, total: candidates.length };
}

/** 记录本轮真正抓过的域名，并顺手清理过期记录，避免文件无限增长 */
export function markSeen(domains, { ttlDays = 14, today = todayCN() } = {}) {
  const seen = loadSeen();
  for (const d of domains) if (d) seen[d] = today;
  for (const [k, v] of Object.entries(seen)) {
    if (!v || daysBetween(v, today) > ttlDays * 3) delete seen[k];
  }
  saveSeen(seen);
  return Object.keys(seen).length;
}

export function seenStats() {
  const seen = loadSeen();
  const keys = Object.keys(seen);
  return { total: keys.length, file: FILE };
}
