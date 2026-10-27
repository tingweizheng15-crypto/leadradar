#!/usr/bin/env node
/**
 * 把 LeadRadar 打包成单文件 EXE（Node SEA）
 *
 *   node build/build-exe.mjs              → build/LeadRadar.exe + 复制到桌面
 *   node build/build-exe.mjs --no-desktop → 只留在 build/
 *
 * 原理：把运行时要用的源码/页面打成 base64 塞进启动器，注入到一份 node.exe 里。
 * 首次双击解压到 %LOCALAPPDATA%\LeadRadar\app，之后直接复用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUILD = path.join(ROOT, "build");
const DIST = path.join(ROOT, "dist");
const OUT_NAME = "LeadRadar获客雷达.exe";

const EXCLUDE_DIRS = new Set(["build", "dist", "node_modules", ".git", "out", "exports", "screenshots", ".workbuddy"]);
const INCLUDE_EXT = new Set([".mjs", ".cjs", ".json", ".html", ".md", ".example", ".txt"]);
const SKIP_FILES = new Set(["package-lock.json", ".env", "config.json"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      if (path.join(dir, entry.name) === path.join(ROOT, "daily", "out")) continue;
      if (path.join(dir, entry.name) === path.join(ROOT, "daily", "state")) continue;
      walk(path.join(dir, entry.name), out);
    } else {
      const abs = path.join(dir, entry.name);
      if (SKIP_FILES.has(entry.name)) continue;
      if (!INCLUDE_EXT.has(path.extname(entry.name).toLowerCase()) && !entry.name.startsWith(".env")) continue;
      out.push(path.relative(ROOT, abs).replace(/\\/g, "/"));
    }
  }
  return out;
}

const files = walk(ROOT).sort();
const assets = {};
let rawBytes = 0;
for (const rel of files) {
  const buf = fs.readFileSync(path.join(ROOT, rel));
  rawBytes += buf.length;
  assets[rel] = buf.toString("base64");
}

const buildId = `${new Date().toISOString().slice(0, 19)}-${rawBytes}`;
const template = fs.readFileSync(path.join(BUILD, "sea-entry.template.cjs"), "utf8");
// 用函数式替换：避免 JSON 里出现 $ 被当成替换模式，同时替换所有同名占位符
const entry = template
  .replace(/__BUILD_ID__/g, () => buildId)
  .replace(/__ASSETS__/g, () => JSON.stringify(assets));

const entryPath = path.join(BUILD, "sea-entry.cjs");
fs.writeFileSync(entryPath, entry, "utf8");

const seaConfig = {
  main: entryPath,
  output: path.join(BUILD, "leadradar.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
};
const cfgPath = path.join(BUILD, "sea-config.json");
fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2), "utf8");

console.log(`资源：${files.length} 个文件 / ${(rawBytes / 1024).toFixed(0)} KB`);
console.log("1/4 生成 SEA blob …");
execFileSync(process.execPath, ["--experimental-sea-config", cfgPath], { stdio: "inherit" });

console.log("2/4 复制 node 宿主 …");
fs.mkdirSync(DIST, { recursive: true });
const exePath = path.join(DIST, OUT_NAME);
fs.copyFileSync(process.execPath, exePath);

console.log("3/4 注入 blob …");
const postject = path.join(ROOT, "node_modules", "postject", "dist", "cli.js");
if (!fs.existsSync(postject)) {
  console.error("缺少 postject，请先执行：npm i --no-save postject");
  process.exit(1);
}
execFileSync(process.execPath, [
  postject, exePath, "NODE_SEA_BLOB", seaConfig.output,
  "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
], { stdio: "inherit" });

const MB = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
console.log(`4/4 完成：${exePath}（${MB} MB）`);

if (!process.argv.includes("--no-desktop")) {
  const desktop = path.join(process.env.USERPROFILE || "C:\\Users\\Administrator", "Desktop");
  if (fs.existsSync(desktop)) {
    const target = path.join(desktop, OUT_NAME);
    fs.copyFileSync(exePath, target);
    console.log(`已放到桌面：${target}`);
  } else {
    console.log("未找到桌面目录，EXE 留在 dist/");
  }
}
