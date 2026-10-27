import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import dns from 'node:dns/promises';
import net from 'node:net';
const agents=new Map();
export const resolveProxy=cfg=>cfg?.proxy??process.env.HTTPS_PROXY??process.env.HTTP_PROXY??'';
export function safeUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('不支持的页面地址');return u;}
function privateIP(ip){return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|224\.|255\.)/.test(ip)||ip.includes(':')&&(/^(::|fc|fd|fe[89ab])/i.test(ip)||/^::ffff:/i.test(ip));}
export async function publicUrl(value){const u=safeUrl(value);const host=u.hostname.replace(/^\[|\]$/g,'');const list=net.isIP(host)?[{address:host}]:await dns.lookup(host,{all:true});if(!list.length||list.some(x=>privateIP(x.address)))throw Error('采集地址不能指向本机或私有网络');return u;}
function agentFor(protocol,proxy){const key=protocol+proxy;if(!agents.has(key)){const Agent=protocol==='https:'?https.Agent:http.Agent;agents.set(key,new Agent({keepAlive:true,maxSockets:6,proxyEnv:{HTTP_PROXY:proxy,HTTPS_PROXY:proxy}}));}return agents.get(key);}
export async function proxiedFetch(cfg,url,options={},timeoutMs=15000){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(Error('请求超时')),timeoutMs);const signal=options.signal?AbortSignal.any([ctrl.signal,options.signal]):ctrl.signal;
  const maxBytes=options.maxBytes||2_000_000;
  try{
    let current=safeUrl(url),method=options.method||'GET',body=options.body,headers={...options.headers};
    for(let hop=0;hop<=5;hop++){
      if(options.publicOnly)await publicUrl(current);
      signal.throwIfAborted();
      const r=await new Promise((resolve,reject)=>{
        const transport=current.protocol==='https:'?https:http;
        const req=transport.request(current,{method,headers:{...headers,'accept-encoding':'identity'},signal,agent:agentFor(current.protocol,resolveProxy(cfg))},res=>{
          const chunks=[];let size=0;
          res.on('data',c=>{size+=c.length;if(size>maxBytes){res.destroy(Error('响应超过大小上限'));return;}chunks.push(c);});
          res.on('error',reject);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
        });req.on('error',reject);if(body)req.write(body);req.end();
      });
      if([301,302,303,307,308].includes(r.status)&&r.headers.location&&options.redirect!=='manual'){
        if(hop===5)throw Error('重定向次数过多');const next=safeUrl(new URL(r.headers.location,current));
        if(next.origin!==current.origin)for(const k of Object.keys(headers))if(/authorization|cookie|api.key/i.test(k))delete headers[k];
        if(r.status===303||([301,302].includes(r.status)&&method==='POST')){method='GET';body=undefined;}
        current=next;continue;
      }
      let data=r.body;const enc=r.headers['content-encoding'];const limits={maxOutputLength:maxBytes};
      if(enc==='gzip')data=zlib.gunzipSync(data,limits);else if(enc==='br')data=zlib.brotliDecompressSync(data,limits);else if(enc==='deflate')data=zlib.inflateSync(data,limits);
      const h={...r.headers};delete h['content-encoding'];delete h['content-length'];
      const response=new Response([204,205,304].includes(r.status)?null:data,{status:r.status,headers:h});Object.defineProperty(response,'url',{value:current.href});return response;
    }
  }finally{clearTimeout(timer);}
}
export function closeConnections(){for(const a of agents.values())a.destroy();agents.clear();}
export function redactError(e){return String(e?.message||e).replace(/([?&](?:api_key|key|secret|access_token)=)[^&\s]+/gi,'$1[隐藏]').replace(/Bearer\s+\S+/gi,'Bearer [隐藏]').slice(0,250);}
