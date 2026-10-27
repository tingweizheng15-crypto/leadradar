import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {ROOT} from '../src/config.mjs';
test('搜索框请求通过桌面API传到搜索服务，结果保留实际搜索词',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leadradar-keywords-')),queries=[];
 const provider=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;queries.push(JSON.parse(text).q);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({organic:[]}));});await new Promise(r=>provider.listen(0,'127.0.0.1',r));
 const cfg=JSON.parse(fs.readFileSync(path.join(ROOT,'config.example.json'),'utf8'));cfg.search.serper={apiKey:'local-fixture-key',endpoint:`http://127.0.0.1:${provider.address().port}/search`};cfg.search.max_queries_per_run=2;cfg.search.include_social=false;cfg.search.multilingual=false;cfg.markets=['TH'];cfg.proxy='';fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(cfg));
 const child=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{env:{...process.env,LEADRADAR_DATA_DIR:dir,HTTP_PROXY:'',HTTPS_PROXY:''},stdio:'ignore',windowsHide:true});
 try{const file=path.join(dir,'desktop-session.json');for(let i=0;i<100&&!fs.existsSync(file);i++)await new Promise(r=>setTimeout(r,50));assert.ok(fs.existsSync(file));const s=JSON.parse(fs.readFileSync(file,'utf8')),origin=`http://127.0.0.1:${s.port}`,headers={Authorization:'Bearer '+s.token,'Content-Type':'application/json'};
  const r=await fetch(origin+'/api/run',{method:'POST',headers,body:JSON.stringify({search_terms:'cycling jersey brand\n冲锋衣批发商'})});assert.equal(r.status,202);
  let state;for(let i=0;i<100;i++){state=await(await fetch(origin+'/api/state',{headers})).json();if(!state.busy&&state.lastResult?.stats)break;await new Promise(r=>setTimeout(r,50));}
  assert.equal(state.lastResult.stats.status,'success');assert.deepEqual(state.lastResult.stats.search_terms,['cycling jersey brand','冲锋衣批发商']);assert.equal(queries.length,2);assert.ok(queries.some(q=>q.includes('cycling jersey brand')));assert.ok(queries.some(q=>q.includes('冲锋衣批发商')));assert.ok(queries.every(q=>!q.includes('compression tights')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')).search.custom_keywords,['cycling jersey brand','冲锋衣批发商']);
  await fetch(origin+'/api/shutdown',{method:'POST',headers,body:'{}'});await new Promise(r=>child.once('exit',r));
 }finally{if(child.exitCode===null)child.kill();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
});
