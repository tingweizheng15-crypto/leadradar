#!/usr/bin/env node
/**
 * 开发态的子任务入口：node console/job.mjs <kind> [args]
 * 与打包态 LeadRadar.exe --job <kind> 行为一致（见 build/sea-entry.cjs）。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../src/config.mjs";
import { jobArgsFor } from "../src/runner.mjs";

const kind = process.argv[2];
const { script, args } = jobArgsFor(kind);

if (!script) {
  console.error(`未知任务类型：${kind}`);
  process.exit(2);
}

const abs = path.join(ROOT, script);
process.argv = [process.execPath, abs, ...args];
await import(pathToFileURL(abs).href);
