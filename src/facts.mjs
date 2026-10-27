import {keywordMatch,customProduct} from './search-terms.mjs';
import {stripBuyerRoles,productAliases} from './localization.mjs';
export const productPatterns={
 compression_tights:/\bcompression (?:tights|leggings|pants|shorts)\b|压缩裤|รัดกล้ามเนื้อ|컴프레션/ig,
 running_singlet:/\b(?:running |race )?(?:singlets?)\b|跑步背心|싱글렛|싱글릿|เสื้อกล้ามวิ่ง/ig,
 running_shorts:/\brunning shorts\b|跑步短裤|กางเกงวิ่ง|러닝\s*쇼츠/ig,
 quick_dry:/\b(?:quick[ -]?dry|moisture[ -]?wicking)\b|速干|흡습속건/ig,
};
export function factsFromPages(pages,{searchTerms=[],localizedTopics=[]}={}){
 const evidence=[];const products=new Set();let role='unknown',offersOem=false,seeksSupplier=false;
 for(const p of pages){const text=p.text||'';for(const [product,re]of Object.entries(productPatterns)){re.lastIndex=0;const m=re.exec(text);if(m){products.add(product);evidence.push({field:'product',value:product,url:p.url,quote:text.slice(Math.max(0,m.index-75),m.index+150),observed_at:p.fetched_at});}}
 for(const term of searchTerms){const m=keywordMatch(text,term);if(m){const value=customProduct(term);products.add(value);evidence.push({field:'product',value,url:p.url,quote:m.quote,observed_at:p.fetched_at});}}
 for(const topic of [...Object.keys(productPatterns).map(product=>({product,variants:productAliases(product)})),...localizedTopics]){
  if(products.has(topic.product))continue;for(const variant of topic.variants){const clean=stripBuyerRoles(variant);if(!clean)continue;const m=keywordMatch(text,clean);if(m){products.add(topic.product);evidence.push({field:'product',value:topic.product,url:p.url,quote:m.quote,matched_language_term:variant,observed_at:p.fetched_at});break;}}
 }
 const roleRules=[['manufacturer',/\b(?:we (?:manufacture|produce)|our (?:garment )?factory|we are (?:an? )?(?:OEM |garment )?manufacturer)\b|我们工厂|自有工厂|โรงงานของเรา|pabrik kami|kilang kami|자체 공장|저희 공장/i],['distributor',/\b(?:we (?:distribute|import)|official distributor|exclusive distributor)\b|进口分销|授权代理|ตัวแทนจำหน่ายอย่างเป็นทางการ|distributor resmi|pengedar rasmi|공식 유통/i],['brand',/\b(?:our brand|independent (?:sportswear |running |apparel )?brand|we design|our designs)\b|自有品牌|独立品牌|แบรนด์ของเรา|เราคือแบรนด์|merek kami|jenama kami|우리 브랜드|자체 브랜드/i],['event',/\b(?:our run club|running club|race organi[sz]er)\b|跑团|赛事主办|ชมรมวิ่ง|komunitas lari|kelab larian|러닝 크루/i],['retail',/\b(?:running store|sports retailer|multi[ -]brand store)\b|运动零售|ร้านค้าปลีก|toko olahraga|kedai sukan|스포츠 매장/i]];
 for(const [r,re]of roleRules){const m=re.exec(text);if(m&&(role==='unknown'||r==='manufacturer')){role=r;evidence.push({field:'role',value:r,url:p.url,quote:text.slice(Math.max(0,m.index-70),m.index+160),observed_at:p.fetched_at});break;}}
 const offer=/\b(?:we offer|we provide|our services).{0,60}(?:OEM|private label|manufactur)|\bOEM manufacturer\b/i.exec(text);
 const seek=/\b(?:looking for|seeking|sourcing|need).{0,65}(?:supplier|manufactur|production partner)|寻找.{0,20}(?:供应商|工厂)|กำลังมองหา.{0,60}(?:โรงงาน|ผู้ผลิต)|mencari.{0,60}(?:pemasok|produsen|mitra produksi|pembekal|pengilang)|(?:공급업체|제조업체).{0,40}(?:찾|모집)/i.exec(text);
 if(offer)offersOem=true;if(seek){seeksSupplier=true;evidence.push({field:'procurement',value:'seeks_supplier',url:p.url,quote:text.slice(Math.max(0,seek.index-50),seek.index+200),observed_at:p.fetched_at});}
 }
 return {verified_products:[...products],verified_type:role,offers_oem:offersOem,seeks_supplier:seeksSupplier,evidence_items:evidence};
}
export function countryOf(text){const rules={KR:/韩国|\b(?:Korea|Seoul)\b|서울|首尔|대한민국|한국/i,TH:/泰国|\b(?:Thailand|Bangkok)\b|曼谷|ประเทศไทย|กรุงเทพ/i,US:/美国|\b(?:USA|United States)\b/i,UK:/英国|\b(?:UK|United Kingdom)\b/i,ID:/印尼|\b(?:Indonesia|Jakarta)\b|雅加达/i,MY:/马来西亚|\b(?:Malaysia|Kuala Lumpur)\b/i};return Object.entries(rules).find(([,re])=>re.test(text))?.[0]||'';}
