/**
 * SEA 启动器模板：构建时把 __ASSETS__ 替换成 base64 资源表。
 * 运行逻辑：
 *   1. 首次运行把源码解压到 %LOCALAPPDATA%\LeadRadar\app
 *   2. 无参数 → 起操作台 + 开浏览器；带 --job <kind> → 跑子任务（定时器/流水线/采集）
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const BUILD_ID = "__BUILD_ID__";
const ASSETS = __ASSETS__;

const BASE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "LeadRadar");
const APP = path.join(BASE, "app");
const PORT = Number(process.env.LR_PORT || 7788);

function extract() {
  const marker = path.join(APP, ".build");
  try {
    if (fs.readFileSync(marker, "utf8").trim() === BUILD_ID) return false;
  } catch { /* 首次运行 */ }
  for (const rel of Object.keys(ASSETS)) {
    const dest = path.join(APP, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(ASSETS[rel], "base64"));
  }
  fs.writeFileSync(marker, BUILD_ID);
  return true;
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: 900 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(res.statusCode === 200 && body.indexOf("schedules") > -1));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function openBrowser(url) {
  try {
    const c = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin" ? ["open", [url]]
        : ["xdg-open", [url]];
    spawn(c[0], c[1], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* 打不开浏览器不影响服务 */ }
}

(async () => {
  const first = extract();
  process.env.LR_ROOT = APP;
  process.env.LR_SEA = "1";

  if (process.argv[2] === "--job") {
    const kind = process.argv[3] || "";
    const { jobArgsFor } = await import(pathToFileURL(path.join(APP, "src", "runner.mjs")).href);
    const { script, args } = jobArgsFor(kind);
    if (!script) {
      console.error("未知任务：" + kind);
      process.exit(2);
    }
    const abs = path.join(APP, script);
    process.argv = [process.execPath, abs, ...args];
    await import(pathToFileURL(abs).href);
    return;
  }

  if (await probe(PORT)) {
    console.log(`LeadRadar 已在运行：http://127.0.0.1:${PORT}`);
    openBrowser(`http://127.0.0.1:${PORT}`);
    return;
  }

  if (first) console.log("首次运行，正在准备运行环境……");
  process.env.LR_PORT = String(PORT);
  process.env.LR_OPEN = "1";
  process.env.LR_AUTOSCHED = "1";
  await import(pathToFileURL(path.join(APP, "console", "server.mjs")).href);
})();
