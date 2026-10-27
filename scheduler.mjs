#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, ROOT } from "./src/config.mjs";
import { runPipeline } from "./src/pipeline.mjs";
import { notify } from "./src/report.mjs";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseHms(s) {
  const [h, m, sec] = String(s || "10:00:00").split(":").map(Number);
  return { h: h || 0, m: m || 0, s: sec || 0 };
}

function validTz(tz) {
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

function nextRunEpoch(hms, tz) {
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
function fmt(epoch, tz) {
  const w = wallParts(epoch, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}:${pad(w.s)}`;
}
const nowStr = (tz) => fmt(Date.now(), tz);

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = [];
  if (d) p.push(`${d}天`); if (h) p.push(`${h}小时`); if (m) p.push(`${m}分`); p.push(`${sec}秒`);
  return p.join("");
}

function printNext(cfg, tz) {
  const hms = parseHms(cfg.schedule.daily);
  const next = nextRunEpoch(hms, tz);
  console.log(`系统：${process.platform}　时区：${tz}${/Shanghai/.test(tz) ? "（服务器本地时间可能不是 +8，这里按北京时间算）" : ""}`);
  console.log(`当前时间（${tz}）：${nowStr(tz)}`);
  console.log(`每日推送时间：${cfg.schedule.daily}${cfg.schedule.enabled ? "" : "（已停用）"}`);
  console.log(`下次运行：${fmt(next, tz)}（约 ${fmtDuration(next - Date.now())} 后）`);
  return next;
}

async function runOnce(cfg, tag) {
  const r = await runPipeline(cfg, { reason: tag });
  console.log(`[${nowStr(cfg.schedule.timezone)}] ${tag} 完成：线索 ${r.stats.leads} · 合格 ${r.stats.qualified} · 有邮箱 ${r.stats.with_email} · 有电话 ${r.stats.with_phone}`);
  if (r.warnings.length) console.log("  警告：\n    - " + r.warnings.join("\n    - "));
  await notify({ outDir: r.outDir, reportPath: r.reportPath, cfg, summary: r.stats });
  return r;
}

async function loop(cfg, tz) {
  while (true) {
    const hms = parseHms(cfg.schedule.daily);
    const next = nextRunEpoch(hms, tz);
    const wait = Math.max(0, next - Date.now());
    console.log(`下次运行：${fmt(next, tz)}（${fmtDuration(wait)} 后）`);
    await sleep(wait);
    if (!cfg.schedule.enabled) { console.log("定时已停用，仅等待；如需运行请设置 enabled=true 或使用 run.mjs"); await sleep(60e3); continue; }
    try { await runOnce(cfg, "定时"); }
    catch (e) { console.error("定时任务执行失败：", e.message); }
  }
}

async function registerTask(cfg, tz) {
  if (process.platform === "win32") {
    const node = process.execPath;
    const cmdPath = path.join(ROOT, "start-scheduler.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${node}" "%~dp0scheduler.mjs"\r\n`, "utf8");
    try {
      await execFileP("schtasks", ["/Create", "/TN", "LeadRadar-Scheduler", "/TR", cmdPath, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
      console.log("已注册 Windows 计划任务「LeadRadar-Scheduler」：每次登录自动后台启动定时器。");
    } catch (e) {
      console.error("注册失败，可手动创建计划任务：", e.message);
    }
    return;
  }

  // Linux（Ubuntu 等）：生成 systemd 服务 + 打印安装命令
  const node = process.execPath || "node";
  const unitPath = path.join(ROOT, "leadradar.service");
  const unit = `[Unit]
Description=LeadRadar 获客定时器（每天 ${cfg.schedule.daily} ${tz}）
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart="${node}" "${path.join(ROOT, "scheduler.mjs")}"
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
  fs.writeFileSync(unitPath, unit, "utf8");
  console.log("已生成 systemd 服务文件：" + unitPath);
  console.log("");
  console.log("安装（二选一，推荐用户级，无需 root）：");
  console.log("  # 用户级（无需 sudo，登录后自启）");
  console.log("  mkdir -p ~/.config/systemd/user");
  console.log(`  cp "${unitPath}" ~/.config/systemd/user/leadradar.service`);
  console.log("  systemctl --user daemon-reload");
  console.log("  systemctl --user enable --now leadradar");
  console.log("  loginctl enable-linger $USER   # 允许未登录时也运行");
  console.log("");
  console.log("  # 或系统级（需要 sudo，开机即跑，推荐云服务器）");
  console.log(`  sudo cp "${unitPath}" /etc/systemd/system/leadradar.service`);
  console.log("  sudo systemctl daemon-reload");
  console.log("  sudo systemctl enable --now leadradar");
  console.log("");
  console.log("查看状态： systemctl status leadradar  （或 systemctl --user status leadradar）");
  console.log("查看日志： journalctl -u leadradar -f  （或 journalctl --user -u leadradar -f）");
}

const args = process.argv.slice(2);
const cfg = loadConfig();
const tz = validTz(cfg.schedule.timezone);

if (args.includes("--next")) {
  printNext(cfg, tz);
} else if (args.includes("--register-task")) {
  printNext(cfg, tz);
  await registerTask(cfg, tz);
} else if (args.includes("--once")) {
  await runOnce(cfg, "手动单次");
} else if (args.includes("--now")) {
  await runOnce(cfg, "立即执行");
  console.log("首次执行完成，进入每日定时循环……");
  await loop(cfg, tz);
} else {
  printNext(cfg, tz);
  console.log("进入定时循环（Ctrl+C 退出）。");
  await loop(cfg, tz);
}
