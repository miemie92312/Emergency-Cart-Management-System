import { emptyData, uid } from './domain.js';
export function createStockChange(item, details) {
  return {...details,id:uid('change'),cartId:item.cartId,itemId:item.id,at:new Date().toISOString()};
}
export function hydrate(snapshot, prior={}) {
  const data=snapshot.data;
  const settings=Object.fromEntries(data.settings.map(r=>[r.key,r.value]));
  const items=data.items.map(it=>({ ...it, required:it.requiredQuantity, actual:it.actualQuantity,
    ...(it.quantityMode==='batches'?{batches:data.batches.filter(b=>b.itemId===it.id&&!b.archivedAt).map(b=>({...b,number:b.batchNumber,expiry:b.expiryDate,precision:b.expiryPrecision}))}:{}) }));
  const active=data.carts.find(c=>!c.archivedAt&&c.id===prior.cartId)||data.carts.find(c=>!c.archivedAt);
  return {...prior,page:prior.page||'home',query:prior.query||'',type:prior.type||'all',filter:prior.filter||'all',cartId:active?.id||null,itemId:prior.itemId||null,warningDays:settings.warningDays??30,lastChecker:settings.lastChecker||'',lastExportGeneratedAt:settings.lastExportGeneratedAt??null,carts:data.carts,items,records:data.checks.map(r=>({...r,legacy:r.source==='legacy_unknown'})).sort((a,b)=>Date.parse(b.checkedAt||b.recordedAt||0)-Date.parse(a.checkedAt||a.recordedAt||0)),changes:data.changes.map(r=>({...r,before:r.beforeQuantity,after:r.afterQuantity,at:r.occurredAt})).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)),fields:data.fields,templates:data.templates,generation:snapshot.generation,rawData:data,session:prior.session||null};
}
export function dehydrate(state) {
  const before=state.rawData||emptyData(), now=new Date().toISOString(), output={...structuredClone(before)};
  output.carts=state.carts.map(c=>({...c,department:c.department||null,dataPurpose:c.dataPurpose||(c.demo?'demo':'user_configured'),createdAt:c.createdAt||now,updatedAt:now}));
  output.items=state.items.map(it=>{
    const {batches,required,actual,...rest}=it;
    return {...rest,requiredQuantity:required??null,quantityPrecision:0,quantityMode:batches?'batches':'aggregate',...(batches?{}:{actualQuantity:actual??null}),revision:(it.revision??0)+1,createdAt:it.createdAt||now,updatedAt:now};
  });
  // 批次历史仍保留；当前显示与编辑只针对未归档批次。
  output.batches=[...before.batches.filter(b=>b.archivedAt),...state.items.flatMap(it=>(it.batches||[]).map(b=>{const {number,expiry,precision,batchNumber,expiryDate,expiryPrecision,...rest}=b;return {...rest,itemId:it.id,batchNumber:number||'',...(expiry?{expiryDate:expiry,expiryPrecision:precision}:{}),createdAt:b.createdAt||now,updatedAt:now};}))];
  output.checks=state.records.map(r=>{const {legacy,...rest}=r;return {...rest,checker:r.checker||null,result:r.result??null,findings:r.findings??null,source:r.source||(legacy?'legacy_unknown':'manual_item'),timeSource:legacy?'unknown':r.timeSource||'device',recordedAt:legacy?null:r.recordedAt,checkedAt:r.checkedAt||null};});
  output.changes=state.changes.map(c=>{const {before:old,after,at,...rest}=c;return {...rest,cartId:c.cartId||state.items.find(it=>it.id===c.itemId)?.cartId,beforeQuantity:old??null,afterQuantity:after??null,occurredAt:at};});
  output.fields=state.fields;
  output.templates=state.templates;
  output.settings=before.settings.filter(x=>!['warningDays','lastExportGeneratedAt','lastChecker'].includes(x.key)).concat([{key:'warningDays',value:state.warningDays},{key:'lastExportGeneratedAt',value:state.lastExportGeneratedAt??null},{key:'lastChecker',value:state.lastChecker||''}]);
  return output;
}
export function demoCartData(state,base,plusDays){
  const c={id:uid('cart'),name:'示例抢救车',department:'普通病区',location:'示例位置',dataPurpose:'demo',demo:true};
  state.carts.push(c);
  const a={id:uid('item'),cartId:c.id,type:'medicine',name:'示例药品 A',specification:'演示规格',unit:'支',required:10,location:'示例抽屉 1',batches:[{id:uid('batch'),number:'模拟批次 A1',quantity:4,expiry:plusDays(13,base),precision:'day'},{id:uid('batch'),number:'模拟批次 A2',quantity:4,expiry:plusDays(100,base),precision:'day'}],remark:'演示数据，不是医院配置。'};
  state.items.push(a,{id:uid('item'),cartId:c.id,type:'consumable',name:'示例耗材 B',specification:'演示规格',unit:'件',required:4,location:'示例抽屉 2',batches:[{id:uid('batch'),number:'模拟批次 B1',quantity:4,expiry:plusDays(-2,base),precision:'day'}]},{id:uid('item'),cartId:c.id,type:'equipment',name:'示例设备 C',specification:'演示型号',unit:'台',required:1,actual:1,checklist:['外观检查（模拟项目）','功能检查（模拟项目）']},{id:uid('item'),cartId:c.id,type:'custom',name:'示例物品 D',unit:'件',required:null,actual:null},{id:uid('item'),cartId:c.id,type:'medicine',name:'示例药品 E',unit:'瓶',required:2,batches:[{id:uid('batch'),number:'模拟批次 E1',quantity:2,expiry:plusDays(210,base).slice(0,7),precision:'month'}]});
  state.cartId=c.id;
}
