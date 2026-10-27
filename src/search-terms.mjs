export function parseSearchTerms(value = []) {
  if (typeof value !== 'string' && !Array.isArray(value)) throw Error('搜索词请填写文本，每行一个');
  const entries = (Array.isArray(value) ? value : value.split(/\r?\n/)).map(x => {
    if (typeof x !== 'string') throw Error('搜索词必须是文本');
    return x.trim().replace(/\s+/g, ' ');
  }).filter(Boolean);
  if (entries.length > 20 || entries.some(x => x.length > 160)) throw Error('最多填写20个搜索词，每个不超过160字');
  const seen = new Set();
  return entries.filter(x => { const key=x.toLocaleLowerCase();if(seen.has(key))return false;seen.add(key);return true; });
}
export const searchTerms = cfg => parseSearchTerms(cfg.search?.custom_keywords || []);
export const customProduct = term => 'custom:' + term;
export const targetProducts = cfg => { const terms=searchTerms(cfg);return terms.length?terms.map(customProduct):(cfg.products||[]); };
export const productLabel = id => String(id).startsWith('custom:')?String(id).slice(7):id;
const stop = new Set('brand brands independent wholesale wholesaler wholesalers distributor distributors supplier suppliers manufacturer manufacturers retailer retailers store stores shop shops oem odm private label and or the in for of korea thailand usa uk united states kingdom indonesia malaysia'.split(' '));
const singular = word => word.length>4&&word.endsWith('s')&&!word.endsWith('ss')?word.slice(0,-1):word;
function words(text){return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)||[];}
export function keywordMatch(text,term){
  const cleaned=term.replace(/\b(?:site|inurl|intitle):\S+/gi,'').replace(/(?:^|\s)-\S+/g,' ').replace(/(?:批发商|供应商|零售商|品牌商|生产商|厂家|品牌)$/,'');
  const wanted=[...new Set(words(cleaned).filter(x=>!stop.has(x)).map(singular))];
  if(!wanted.length)return null;
  const direct=text.normalize('NFKC').toLowerCase().indexOf(cleaned.normalize('NFKC').toLowerCase().trim());
  if(cleaned.trim()&&direct>=0)return {index:direct,quote:text.slice(Math.max(0,direct-65),direct+335)};
  // All topic words must occur together in one short page passage, never across unrelated pages.
  const tokens=[...text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)];
  for(let i=0;i<tokens.length;i++){
    const start=tokens[i].index;const passage=text.slice(start,start+400);const found=words(passage).map(singular);
    if(wanted.every(w=>found.some(f=>f===w||/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}]/u.test(w)&&f.includes(w))))return {index:start,quote:passage.slice(0,400)};
  }
  return null;
}
