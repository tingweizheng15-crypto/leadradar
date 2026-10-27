/**
 * 按「目标时区的墙上时间」算下一次执行时刻。
 * 关键点：不依赖服务器本地时区。UTC 的云服务器也照样按北京时间 10:00 跑。
 */

export function parseHms(s) {
  const [h, m, sec] = String(s || "10:00:00").split(":").map(Number);
  return { h: h || 0, m: m || 0, s: sec || 0 };
}

export function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; }
  catch { return "Asia/Shanghai"; }
}

function wallParts(epoch, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const o = {};
  for (const p of dtf.formatToParts(new Date(epoch))) if (p.type !== "literal") o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second };
}

function zonedEpoch(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const w = wallParts(guess, tz);
  const back = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  const offset = back - guess;
  return guess - offset;
}

export function nextRunEpoch(hms, tz) {
  const now = Date.now();
  const wp = wallParts(now, tz);
  let candidate = zonedEpoch(wp.y, wp.m, wp.d, hms.h, hms.m, hms.s, tz);
  if (candidate <= now) {
    const tomorrow = zonedEpoch(wp.y, wp.m, wp.d, 0, 0, 0, tz) + 86400e3;
    const tp = wallParts(tomorrow, tz);
    candidate = zonedEpoch(tp.y, tp.m, tp.d, hms.h, hms.m, hms.s, tz);
  }
  return candidate;
}

const pad = (n) => String(n).padStart(2, "0");

export function fmt(epoch, tz) {
  const w = wallParts(epoch, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}

export const nowStr = (tz) => fmt(Date.now(), tz);

export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = [];
  if (d) p.push(`${d}天`); if (h) p.push(`${h}小时`); if (m) p.push(`${m}分`); p.push(`${sec}秒`);
  return p.join("");
}

/** 把 config.schedule 归一化成统一的作业列表，定时器 / 操作台 / --next 共用同一份口径 */
export function jobsOf(cfg) {
  const tz = validTz(cfg?.schedule?.timezone);
  const dw = cfg?.schedule?.daily_watch || {};
  return [
    {
      key: "pipeline",
      name: "获客流水线",
      time: cfg?.schedule?.daily || "10:00:00",
      enabled: cfg?.schedule?.enabled !== false,
      tz,
    },
    {
      key: "daily",
      name: "每日采集",
      time: dw.time || "09:30:00",
      enabled: dw.enabled !== false,
      tz,
    },
  ];
}
