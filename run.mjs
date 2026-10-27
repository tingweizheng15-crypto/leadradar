#!/usr/bin/env node
import { loadConfig } from "./src/config.mjs";
import { runPipeline } from "./src/pipeline.mjs";
import { notify } from "./src/report.mjs";

const cfg = loadConfig();
const r = await runPipeline(cfg);

console.log(`\n✔ 完成：发现候选 ${r.stats.candidates} · 有效线索 ${r.stats.leads} · 合格 ${r.stats.qualified} · 待复核 ${r.stats.review}`);
console.log(`  有邮箱 ${r.stats.with_email} · 有电话 ${r.stats.with_phone}`);
console.log(`  数据源：${r.stats.source}`);
if (r.warnings.length) console.log("  警告：\n    - " + r.warnings.join("\n    - "));
console.log(`  报告：${r.reportPath}`);

await notify({ outDir: r.outDir, reportPath: r.reportPath, cfg, summary: r.stats });
