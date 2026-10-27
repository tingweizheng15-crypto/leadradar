import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {ROOT} from '../src/config.mjs';
test('桌面服务：启动、鉴权、配置保存、界面资源和退出',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leadradar-desktop-'));const child=spawn(process.execPath,[path.join(ROOT,'server.mjs')],{env:{...process.env,LEADRADAR_DATA_DIR:dir},stdio:'pipe',windowsHide:true});let log='';child.stderr.on('data',d=>log+=d);child.stdout.on('data',d=>log+=d);
 try{
  const file=path.join(dir,'desktop-session.json');for(let i=0;i<100&&!fs.existsSync(file);i++)await new Promise(r=>setTimeout(r,50));assert.ok(fs.existsSync(file),log);const s=JSON.parse(fs.readFileSync(file,'utf8'));const origin=`http://127.0.0.1:${s.port}`;const headers={Authorization:'Bearer '+s.token,'Content-Type':'application/json'};
  assert.equal((await fetch(origin+'/api/state')).status,401);
  assert.equal((await fetch(origin+'/api/state',{headers:{...headers,Origin:'https://other.invalid'}})).status,403);
  const health=await(await fetch(origin+'/api/health',{headers})).json();assert.equal(health.ok,true);
  const page=await(await fetch(origin)).text();assert.match(page,/type="module" src="\/app.js"/);assert.match(page,/id="search_terms"/);assert.equal((await fetch(origin+'/app.js')).status,200);
  let r=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({queries:0})});assert.equal(r.status,400);
  r=await fetch(origin+'/api/run',{method:'POST',headers,body:JSON.stringify({search_terms:'cycling jersey brand'})});assert.equal(r.status,400);assert.match((await r.json()).error,/搜索 API 密钥/);
  r=await fetch(origin+'/api/keywords',{method:'POST',headers,body:JSON.stringify({search_terms:'cycling jersey brand\n冲锋衣批发商'})});assert.equal(r.status,200);
  let saved=await(await fetch(origin+'/api/state',{headers})).json();assert.equal(saved.settings.search_terms,'cycling jersey brand\n冲锋衣批发商');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')).search.custom_keywords,['cycling jersey brand','冲锋衣批发商']);
  r=await fetch(origin+'/api/keywords',{method:'POST',headers,body:JSON.stringify({search_terms:'x'.repeat(161)})});assert.equal(r.status,400);
  r=await fetch(origin+'/api/search-plan',{method:'POST',headers,body:JSON.stringify({search_terms:'cycling jersey brand',markets:['TH','ID','MY','US','UK','KR'],multilingual:true})});assert.equal(r.status,200);const plan=await r.json();assert.equal(plan.markets.length,6);assert.ok(plan.queries.some(q=>q.country==='TH'&&/เสื้อปั่นจักรยาน/.test(q.q)));assert.ok(plan.queries.some(q=>q.country==='KR'&&q.hl==='ko'));
  r=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({serper_key:'fixture-secret-not-real',queries:12})});assert.equal(r.status,200);
  const stateText=await(await fetch(origin+'/api/state',{headers})).text();assert.ok(!stateText.includes('fixture-secret-not-real'));assert.equal(JSON.parse(stateText).settings.queries,12);assert.equal(JSON.parse(stateText).settings.search_ready,true);
  r=await fetch(origin+'/api/shutdown',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);await new Promise(r=>child.once('exit',r));
 }finally{if(child.exitCode===null)child.kill();}
});
