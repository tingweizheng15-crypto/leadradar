import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DATA_DIR} from './config.mjs';
export function atomicJson(file,data){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,file);}
export function readStore(dir=DATA_DIR){const file=path.join(dir,'customers.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{version:1,companies:[],runs:[]};}
export function saveRun(cfg,records,run){
 const dir=cfg.data_dir||DATA_DIR;const db=readStore(dir);let newCount=0;const keys=l=>[l.domain,...(l.social||[]).map(s=>s.platform+':'+s.handle.toLowerCase())].filter(Boolean);
 for(const lead of records){const ids=keys(lead);const old=db.companies.find(x=>keys(x).some(k=>ids.includes(k)));const now=new Date().toISOString();
  if(old){const preserved={id:old.id,first_seen:old.first_seen,followup:old.followup,notes:old.notes,next_action:old.next_action};if(lead.fetch_status==='ok')Object.assign(old,lead,preserved,{last_verified:now,stale:false});else Object.assign(old,{fetch_status:'failed',stale:true,last_error:lead.errors,last_attempt:now});old.last_run_id=run.id;}
  else{db.companies.push({...lead,id:crypto.randomUUID(),first_seen:now,last_verified:lead.fetch_status==='ok'?now:null,followup:'未联系',notes:'',last_run_id:run.id});newCount++;}
 }
 run.new_companies=newCount;db.runs.unshift(run);db.runs=db.runs.slice(0,200);atomicJson(path.join(dir,'customers.json'),db);return newCount;
}
export function updateCompany(dir,id,patch){const db=readStore(dir);const c=db.companies.find(x=>x.id===id);if(!c)throw Error('客户不存在');for(const key of ['followup','notes','next_action'])if(typeof patch[key]==='string')c[key]=patch[key].slice(0,4000);atomicJson(path.join(dir,'customers.json'),db);return c;}
export function acquireLock(dir){fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'run.lock');if(fs.existsSync(file)){const old=JSON.parse(fs.readFileSync(file,'utf8'));let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}if(alive)throw Error('已有采集任务运行中');fs.unlinkSync(file);}const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.closeSync(fd);return ()=>{try{fs.unlinkSync(file);}catch{}};}
