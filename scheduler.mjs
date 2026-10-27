#!/usr/bin/env node
/**
 * LeadRadar 定时器：一个进程管两条链路
 *   09:30:00  每日采集（daily/run.mjs，观察名单 + 截图 + 新鲜度判定）
 *   10:00:00  获客流水线（run.mjs 等价，搜索发现 + 挖联系方式 + AI + 日报）
 * 时间按 config.schedule.timezone（默认 Asia/Shanghai）计算，与服务器本地时区无关。
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, ROOT } from "./src/config.mjs";
import { runPipeline } from "./src/pipeline.mjs";
import { notify } from "./src/report.mjs";
import { findChrome } from "./src/enrich.mjs";
import { parseHms, validTz, nextRunEpoch, fmt, nowStr, fmtDuration, jobsOf } from "./src/schedule.mjs";
import { jobCommand } from "./src/runner.mjs";

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function plan(cfg) {
  const jobs = jobsOf(cfg);
  return jobs.map((j) => ({ ...j, next: nextRunEpoch(parseHms(j.time), j.tz) }));
}

function printPlan(cfg) {
  const jobs = plan(cfg);
  const tz = jobs[0]?.tz || "Asia/Shanghai";
  console.log(`系统：${process.platform}　时区：${tz}${/Shanghai/.test(tz) ? "（服务器本地时间可能不是 +8，这里按北京时间算）" : ""}`);
  console.log(`当前时间（${tz}）：${nowStr(tz)}`);
  for (const j of jobs) {
    console.log(`- ${j.name}：每天 ${j.time}${j.enabled ? "" : "（已停用）"}`);
    console.log(`  下次运行：${fmt(j.next, tz)}（约 ${fmtDuration(j.next - Date.now())} 后）`);
  }
  if (jobs.find((j) => j.key === "daily")?.enabled && !findChrome()) {
    console.log("  ⚠ 未找到 Chrome：每日采集需要 Chrome 做无头抓取/截图，请装 Chrome 或设置 CHROME_PATH");
  }
  return jobs;
}

async function runPipelineJob(cfg, tag) {
  const r = await runPipeline(cfg, { reason: tag });
  console.log(`[${nowStr(cfg.schedule.timezone)}] ${tag} 完成：线索 ${r.stats.leads} · 合格 ${r.stats.qualified} · 有邮箱 ${r.stats.with_email} · 有电话 ${r.stats.with_phone}`);
  if (r.warnings.length) console.log("  警告：\n    - " + r.warnings.join("\n    - "));
  await notify({ outDir: r.outDir, reportPath: r.reportPath, cfg, summary: r.stats });
  return r;
}

async function runDailyJob(cfg, tag) {
  const tz = validTz(cfg.schedule.timezone);
  const startedAt = Date.now();
  try {
    const jc = jobCommand("daily");
    const { stdout } = await execFileP(jc.cmd, jc.args, { cwd: ROOT, maxBuffer: 20 * 1024 * 1024, timeout: 30 * 60 * 1000 });
    console.log(`[${nowStr(tz)}] ${tag}（每日采集）完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    const tail = stdout.trim().split(/\r?\n/).slice(-2).join("\n");
    if (tail) console.log(tail);
    return { ok: true };
  } catch (e) {
    console.error(`[${nowStr(tz)}] ${tag}（每日采集）失败：${String(e.message || e).slice(0, 200)}`);
    return { ok: false };
  }
}

async function loop(cfg) {
  while (true) {
    const jobs = plan(cfg);
    const live = jobs.filter((j) => j.enabled);
    if (!live.length) {
      console.log("两条定时链路都已停用；60 秒后重新读取配置。");
      await sleep(60e3);
      continue;
    }
    const job = live.reduce((a, b) => (a.next <= b.next ? a : b));
    const wait = Math.max(0, job.next - Date.now());
    console.log(`下次运行：${job.name} ${fmt(job.next, job.tz)}（${fmtDuration(wait)} 后）`);
    await sleep(wait);
    try {
      if (job.key === "pipeline") await runPipelineJob(cfg, "定时");
      else await runDailyJob(cfg, "定时");
    } catch (e) {
      console.error("定时任务执行失败：", e.message);
    }
  }
}

async function registerTask(cfg) {
  if (process.platform === "win32") {
    const node = process.execPath;
    const cmdPath = path.join(ROOT, "start-scheduler.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\nchcp 65001 >nul\r\n"${node}" "%~dp0scheduler.mjs"\r\n`, "utf8");
    try {
      await execFileP("schtasks", ["/Create", "/TN", "LeadRadar-Scheduler", "/TR", cmdPath, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
      console.log("已注册 Windows 计划任务「LeadRadar-Scheduler」：每次登录自动后台启动定时器（两条链路都在里面）。");
    } catch (e) {
      console.error("注册失败，可手动创建计划任务：", e.message);
    }
    return;
  }

  const node = process.execPath || "node";
  const tz = validTz(cfg.schedule.timezone);
  const jobs = jobsOf(cfg);
  const unitPath = path.join(ROOT, "leadradar.service");
  const unit = `[Unit]
Description=LeadRadar 定时器（${jobs.map((j) => `${j.name} ${j.time}`).join(" / ")} ${tz}）
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

if (args.includes("--next")) {
  printPlan(cfg);
} else if (args.includes("--register-task")) {
  printPlan(cfg);
  await registerTask(cfg);
} else if (args.includes("--once")) {
  printPlan(cfg);
  await runPipelineJob(cfg, "手动单次");
} else if (args.includes("--daily")) {
  printPlan(cfg);
  await runDailyJob(cfg, "手动单次");
} else if (args.includes("--now")) {
  printPlan(cfg);
  await runPipelineJob(cfg, "立即执行");
  console.log("首次执行完成，进入定时循环……");
  await loop(cfg);
} else {
  printPlan(cfg);
  console.log("进入定时循环（Ctrl+C 退出）。");
  await loop(cfg);
}
