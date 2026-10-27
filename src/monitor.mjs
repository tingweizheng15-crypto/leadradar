export function stableContent(text){return text.toLowerCase().replace(/[\d][\d.,]*\s*(?:k|m|万|亿)?\s*(?:followers|likes|views|粉丝|点赞|浏览)/gi,'[动态计数]').replace(/\s+/g,' ').trim();}
export function freshness(pubISO,changed,firstSeenToday,now=Date.now()){
 if(firstSeenToday)return {tier:'BASE',label:'首次建档',basis:'基线记录，不计入新增业务事件',hours:null};
 const epoch=Date.parse(pubISO);const h=(now-epoch)/36e5;
 if(pubISO&&Number.isFinite(epoch)&&h<0)return {tier:'UNKNOWN',label:'发布时间异常',basis:'来源日期在未来，需核验',hours:h};
 if(changed)return {tier:'T1',label:'本次发现变化',basis:'与上次成功快照不同；不等于内容刚发布',hours:null};
 if(pubISO&&Number.isFinite(epoch))return {tier:h<=2?'T0':h<=24?'T1':h<=72?'T2':'T3',label:h<=72?'来源发布时间在3天内':'超过3天',basis:'来源发布时间',hours:+h.toFixed(1)};
 return {tier:'T3',label:'未发现变化',basis:'没有可靠新增证据',hours:null};
}
