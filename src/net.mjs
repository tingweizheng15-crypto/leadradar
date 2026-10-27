import net from "node:net";
import https from "node:https";
import zlib from "node:zlib";

const agents = new Map();

function proxyAgent(proxyUrl) {
  if (agents.has(proxyUrl)) return agents.get(proxyUrl);
  const pu = new URL(proxyUrl);
  const agent = new https.Agent({
    keepAlive: true,
    createConnection(opts, cb) {
      const socket = net.connect(Number(pu.port) || 80, pu.hostname, () => {
        const auth = pu.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password || "")}`).toString("base64")}\r\n` : "";
        socket.write(`CONNECT ${opts.host}:${opts.port} HTTP/1.1\r\nHost: ${opts.host}:${opts.port}\r\n${auth}\r\n`);
      });
      let buf = "";
      const onData = (d) => {
        buf += d.toString("latin1");
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        socket.removeListener("data", onData);
        if (/ 200 /.test(buf.slice(0, idx).split("\r\n")[0])) cb(null, socket);
        else { socket.destroy(); cb(new Error("proxy CONNECT 失败")); }
      };
      socket.on("data", onData);
      socket.on("error", (e) => cb(e));
      socket.setTimeout(20000, () => { socket.destroy(); cb(new Error("proxy 连接超时")); });
    },
  });
  agents.set(proxyUrl, agent);
  return agent;
}

function httpsThroughProxy(proxyUrl, target, options, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tu = new URL(target);
    const req = https.request({
      hostname: tu.hostname,
      port: tu.port || 443,
      path: tu.pathname + tu.search,
      method: options.method || "GET",
      headers: { ...(options.headers || {}), "accept-encoding": "identity" },
      agent: proxyAgent(proxyUrl),
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let body = Buffer.concat(chunks);
        const enc = (res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("gzip")) body = zlib.gunzipSync(body);
          else if (enc.includes("deflate")) body = zlib.inflateSync(body);
          else if (enc.includes("br")) body = zlib.brotliDecompressSync(body);
        } catch { /* 解压失败用原文 */ }
        resolve({ status: res.statusCode, statusText: res.statusMessage || "", headers: res.headers, body });
      });
    });
    req.on("error", reject);
    const timer = setTimeout(() => req.destroy(new Error("proxy 请求超时")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    if (options.signal) options.signal.addEventListener("abort", () => req.destroy(new Error("已中止")));
    if (options.body) req.write(options.body);
    req.end();
  });
}

export function resolveProxy(cfg) {
  return (cfg && cfg.proxy) || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
}

export async function proxiedFetch(cfg, url, options = {}, timeoutMs = 15000) {
  const proxy = resolveProxy(cfg);
  if (!proxy || !String(url).startsWith("https://")) {
    return fetch(url, options);
  }
  const r = await httpsThroughProxy(proxy, url, options, timeoutMs);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
