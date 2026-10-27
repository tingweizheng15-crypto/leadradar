import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ROOT } from "./config.mjs";
import { COUNTRIES, PRODUCTS, statusLabel } from "./score.mjs";

const execFileP = promisify(execFile);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function isoCN(d = new Date(Date.now() + 8 * 3600e3)) { return d.toISOString().replace("Z", "+08:00"); }
export function ymd(d = new Date(Date.now() + 8 * 3600e3)) { return d.toISOString().slice(0, 10); }

const fmtContacts = (list) => (list || []).map((c) => c.value).filter(Boolean).join("; ") || "—";
const fmtEmails = (list) => (list || []).map((c) => `${c.value}${c.confidence === "candidate" ? "(候选)" : "(官方)"}`).join("; ") || "—";

export function writeReport({ stats, leads, cfg, warnings }) {
  const date = stats.date || ymd();
  const outDir = path.join(ROOT, cfg.report.out_dir, date);
  fs.mkdirSync(outDir, { recursive: true });

  const data = { stats, warnings, leads };
  fs.writeFileSync(path.join(outDir, "data.json"), JSON.stringify(data, null, 2), "utf8");

  const head = ["公司", "国家", "买家类型", "需求商品", "评分", "状态", "邮箱", "电话", "社媒", "官网", "业务信号", "判断依据", "AI匹配理由", "开发信草稿", "抓取时间"];
  const csv = [head.join(",")].concat(leads.map((l) => [
    l.name, COUNTRIES[l.country] || l.country, l.typeLabel || "", (l.overlap || []).map((p) => PRODUCTS[p] || p).join("/"),
    l.total, statusLabel(l.status), fmtEmails(l.emails), fmtContacts(l.phones),
    (l.social || []).map((s) => `${s.platform}:${s.handle}`).join("; "),
    l.url, (l.signals || []).join("/"), l.evidence || "", l.ai_fit || "", l.draft || "", l.fetched_at || "",
  ].map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")));
  fs.writeFileSync(path.join(outDir, "leads.csv"), "\ufeff" + csv.join("\r\n"), "utf8");

  const md = [];
  md.push(`# 获客日报 ${date}`, "");
  md.push(`生成时间：${isoCN()}　耗时：${stats.duration_s}s`, "");
  md.push(`- 数据源：${stats.source}　搜索就绪：${stats.search_ready ? "是" : "否"}　邮箱查找：${stats.email_finder}`, "");
  if (stats.search_ready) md.push(`- 本轮检索：${stats.search_queries} 条（失败 ${stats.search_failed || 0} 条）`, "");
  md.push(`- 发现候选：${stats.candidates}　有效线索：${stats.leads}　合格(≥80)：${stats.qualified}　待复核：${stats.review}`, "");
  if (warnings?.length) { md.push("", "## 警告", ""); for (const w of warnings) md.push(`- ${w}`); }
  md.push("", "## 客户线索", "");
  md.push("| 公司 | 国家 | 类型 | 评分 | 状态 | 邮箱 | 电话 | 社媒 | 官网 |", "|---|---|---|---|---|---|---|---|---|");
  for (const l of leads) {
    md.push(`| ${l.name} | ${COUNTRIES[l.country] || l.country} | ${l.typeLabel || ""} | ${l.total} | ${statusLabel(l.status)} | ${fmtEmails(l.emails)} | ${fmtContacts(l.phones)} | ${(l.social || []).map((s) => `${s.platform}:${s.handle}`).join("、") || "—"} | ${l.url || "—"} |`);
  }
  const drafts = leads.filter((l) => l.draft);
  if (drafts.length) {
    md.push("", "## AI 开发信草稿", "");
    for (const l of drafts) {
      md.push(`**${l.name}**（${l.language || "en"}）${l.ai_fit ? `— ${l.ai_fit}` : ""}${l.contact_hint ? `　·　${l.contact_hint}` : ""}`, "");
      md.push(`> ${l.draft}`, "");
    }
  }
  md.push("> 邮箱标注：`(官方)`=来自客户官网/公开页面，可信；`(候选)`=来自邮箱查找服务推测，发信前需验证。", "");
  fs.writeFileSync(path.join(outDir, "report.md"), md.join("\n"), "utf8");

  const html = renderHtml({ stats, leads, warnings, date });
  const reportPath = path.join(outDir, "report.html");
  // 同一天可能手动跑多次：旧报告先归档成 report-HHMM.html，别把上一轮结果冲掉
  if (fs.existsSync(reportPath)) {
    const stamp = new Date().toTimeString().slice(0, 5).replace(":", "");
    try { fs.copyFileSync(reportPath, path.join(outDir, `report-${stamp}.html`)); } catch { /* 归档失败不影响主流程 */ }
  }
  fs.writeFileSync(reportPath, html, "utf8");

  return { outDir, reportPath };
}

function renderHtml({ stats, leads, warnings, date }) {
  const rows = leads.map((l) => {
    const sc = l.total >= 80 ? "#15803d" : l.total >= 60 ? "#b45309" : "#94a3b8";
    return `<tr>
      <td><b>${esc(l.name)}</b></td>
      <td>${esc(COUNTRIES[l.country] || l.country || "")}</td>
      <td>${esc(l.typeLabel || "")}</td>
      <td>${(l.overlap || []).map((p) => `<span class="tag">${esc(PRODUCTS[p] || p)}</span>`).join("")}</td>
      <td style="color:${sc};font-weight:700">${l.total}</td>
      <td>${statusLabel(l.status)}</td>
      <td class="mono">${esc(fmtEmails(l.emails))}</td>
      <td class="mono">${esc(fmtContacts(l.phones))}</td>
      <td>${(l.social || []).map((s) => `<span class="tag">${esc(s.platform)}:${esc(s.handle)}</span>`).join("") || "—"}</td>
      <td>${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">官网 ↗</a>` : "—"}</td>
    </tr>`;
  }).join("");

  const warn = warnings?.length ? `<div class="warn">${warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>` : "";

  const drafts = leads.filter((l) => l.draft);
  const draftsHtml = drafts.length ? `<div class="card"><h2>AI 开发信草稿（${drafts.length}）</h2>
    ${drafts.map((l) => `<div class="draft"><div class="d-top"><b>${esc(l.name)}</b><span class="lang">${esc(l.language || "en")}</span></div>${l.ai_fit ? `<div class="d-fit">${esc(l.ai_fit)}</div>` : ""}${l.contact_hint ? `<div class="d-hint">联系建议：${esc(l.contact_hint)}</div>` : ""}<div class="d-body">${esc(l.draft || "")}</div></div>`).join("")}
  </div>` : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>获客日报 ${esc(date)}</title>
<style>
:root{--ink:#0f172a;--ink2:#475569;--ink3:#94a3b8;--line:#e6e9ef;--bg:#f5f6f8;--red:#e11d48}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;font-size:13px;line-height:1.6}
.wrap{max-width:1280px;margin:0 auto;padding:28px 24px 60px}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--ink2);font-size:13px;margin-bottom:18px}
.kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin-bottom:18px}
.kpi{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}.kpi .k{font-size:11px;color:var(--ink3)}.kpi .v{font-size:26px;font-weight:700}.kpi .ks{font-size:10.5px;color:#b0b8c4;margin-top:2px}
.kpi.hot .v{color:var(--red)}.warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;border-radius:12px;padding:12px 16px;margin-bottom:16px;font-size:12.5px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:16px;overflow-x:auto}
h2{font-size:14px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f1f4f8;vertical-align:top}th{color:var(--ink3);font-size:11px;font-weight:600;white-space:nowrap}
.tag{display:inline-block;background:#f1f5f9;border-radius:5px;padding:1px 6px;font-size:10.5px;margin:1px 3px 1px 0}.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px}
a{color:#be123c;text-decoration:none}.foot{font-size:11px;color:var(--ink3);line-height:1.8;margin-top:8px}
.draft{padding:12px 0;border-bottom:1px solid #f1f4f8}.draft:last-child{border-bottom:none}
.d-top{display:flex;align-items:center;gap:8px;margin-bottom:4px}.d-top b{font-size:13px}.lang{font-size:10px;background:#0f172a;color:#fff;padding:1px 7px;border-radius:4px}
.d-fit{font-size:12px;color:var(--ink2)}.d-hint{font-size:11px;color:#b45309;margin-top:3px}
.d-body{margin-top:6px;font-size:12.5px;background:#f8fafc;border:1px solid #eef1f5;border-radius:8px;padding:10px 12px;white-space:pre-wrap;color:#0f172a}
@media(max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}}
</style></head><body><div class="wrap">
<h1>获客日报 · ${esc(date)}</h1>
<div class="sub">生成于 ${isoCN()}　·　耗时 ${stats.duration_s}s　·　数据源 ${esc(stats.source)}　·　搜索就绪 ${stats.search_ready ? "是" : "否"}${stats.search_ready ? `　·　检索 ${stats.search_queries} 条（失败 ${stats.search_failed || 0}）` : ""}　·　邮箱查找 ${esc(stats.email_finder)}</div>
<div class="kpis">
<div class="kpi hot"><div class="k">有效线索</div><div class="v">${stats.leads}</div></div>
<div class="kpi"><div class="k">发现候选</div><div class="v">${stats.candidates}</div></div>
<div class="kpi"><div class="k">合格(≥80)</div><div class="v">${stats.qualified}</div></div>
<div class="kpi"><div class="k">待复核</div><div class="v">${stats.review}</div></div>
<div class="kpi"><div class="k">有邮箱</div><div class="v">${stats.with_email}</div><div class="ks">入选线索中</div></div>
<div class="kpi"><div class="k">有电话</div><div class="v">${stats.with_phone}</div><div class="ks">入选线索中</div></div>
</div>
${warn}
<div class="card"><h2>客户线索（${leads.length}）</h2>
<table><thead><tr><th>公司</th><th>国家</th><th>类型</th><th>商品</th><th>评分</th><th>状态</th><th>邮箱</th><th>电话</th><th>社媒</th><th>官网</th></tr></thead><tbody>${rows || `<tr><td colspan="10" style="color:#94a3b8">暂无线索</td></tr>`}</tbody></table>
</div>
${draftsHtml}
<div class="foot">邮箱标注：(官方)=来自客户官网/公开页面，可信；(候选)=来自邮箱查找服务推测，发信前需验证。开发信草稿由大模型生成，仅供参考，发送前请人工确认。本报告只做信息采集与判断，不自动发送任何消息。</div>
</div></body></html>`;
}

export async function notify({ outDir, reportPath, cfg, summary }) {
  const n = cfg?.report?.notify;
  if (n === "none") return;
  const lines = [
    "LeadRadar 获客日报已生成",
    summary ? `线索 ${summary.leads} · 合格 ${summary.qualified} · 有邮箱 ${summary.with_email}` : "",
    outDir || "",
  ].filter(Boolean).join("\n");

  const useWebhook = (n === "webhook") || (n === "auto" && !!cfg?.report?.webhook_url);
  const useDesktop = n !== "webhook";

  if (useDesktop) {
    try {
      if (process.platform === "win32") {
        const ps = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$tpl.GetElementsByTagName('text')[0].AppendChild($tpl.CreateTextNode('LeadRadar 获客日报已生成')) > $null
$tpl.GetElementsByTagName('text')[1].AppendChild($tpl.CreateTextNode('${lines.replace(/['"]/g, "")}')) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('LeadRadar').Show([Windows.UI.Notifications.ToastNotification]::new($tpl))`;
        await execFileP("powershell", ["-NoProfile", "-Command", ps], { timeout: 15000 }).catch(() => {});
      } else {
        await execFileP("notify-send", ["LeadRadar 获客日报", lines]).catch(() => {});
      }
    } catch { /* 桌面通知失败不影响主流程 */ }
  }

  const webhook = cfg?.report?.webhook_url;
  if (useWebhook && webhook) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      await fetch(webhook, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msgtype: "text", text: { content: lines } }) });
      clearTimeout(t);
    } catch { /* webhook 失败不影响主流程 */ }
  }

  if (cfg?.report?.open_after_run && reportPath) {
    try {
      if (process.platform === "win32") await execFileP("cmd", ["/c", "start", "", reportPath], { timeout: 10000 }).catch(() => {});
      else await execFileP("xdg-open", [reportPath]).catch(() => {});
    } catch { }
  }
}
