import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import zlib from "node:zlib";

const agents = new Map();

function proxyAgent(proxyUrl) {
  if (agents.has(proxyUrl)) return agents.get(proxyUrl);
  const pu = new URL(proxyUrl);
  const auth = pu.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(pu.username)}:${decodeURIComponent(pu.password || "")}`).toString("base64")}\r\n`
    : "";
  const agent = new https.Agent({ keepAlive: true });

  // 必须在「实例」上赋值：写进 new https.Agent({ createConnection }) 会被原型方法盖掉，
  // 表现就是「配了代理却一直直连」——Google / GitHub 这种被墙的站只会一直超时。
  agent.createConnection = (opts, cb) => {
    let done = false;
    const finish = (err, sock) => { if (done) return; done = true; cb(err, sock); };

    const host = opts.host || opts.hostname;
    const port = Number(opts.port) || 443;
    const socket = net.connect(Number(pu.port) || 80, pu.hostname, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    });

    let buf = "";
    const onData = (d) => {
      buf += d.toString("latin1");
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      socket.removeListener("data", onData);
      const statusLine = buf.slice(0, idx).split("\r\n")[0];
      if (!/ 200 /.test(statusLine)) {
        socket.destroy();
        return finish(new Error(`proxy CONNECT 失败：${statusLine.slice(0, 90)}`));
      }
      socket.setTimeout(0);
      // TLS 要自己包：https.Agent 拿到的必须已经是加密 socket
      const secure = tls.connect({
        socket,
        servername: opts.servername || host,
        ALPNProtocols: ["http/1.1"],
      }, () => finish(null, secure));
      secure.once("error", (e) => finish(e));
    };

    socket.on("data", onData);
    socket.on("error", (e) => finish(e));
    socket.setTimeout(20000, () => { socket.destroy(); finish(new Error("proxy 连接超时")); });
  };

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
  try {
    const r = await httpsThroughProxy(proxy, url, options, timeoutMs);
    // 204/205/304 不允许带 body，Response 构造器会直接抛错（generate_204 探活就踩这个坑）
    const empty = r.status === 204 || r.status === 205 || r.status === 304;
    return new Response(empty ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
  } catch (e) {
    // 代理软件端口经常变（今天 60206 明天 7897）。代理连不上时退回直连：
    // 被墙的站（Google/GitHub）直连也会失败，但 serper / hunter 这类本来就能直连的不会跟着挂。
    if (options && options.__noDirect) {
      const err = new Error(`代理 ${proxy} 不可用（${String(e.message || e).slice(0, 60)}）`);
      err.code = "PROXY_FAIL";
      throw err;
    }
    try {
      return await fetch(url, options);
    } catch {
      const err = new Error(`代理 ${proxy} 连不上（${String(e.message || e).slice(0, 60)}），直连也失败`);
      err.code = "PROXY_FAIL";
      throw err;
    }
  }
}
