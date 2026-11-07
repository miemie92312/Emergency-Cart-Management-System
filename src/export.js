import * as XLSX from 'xlsx';
import { expiryStatus, today } from './domain.js';
export function downloadJson(name, value){
  const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
export function makeWorkbook(data){
  const carts=new Map(data.carts.map(c=>[c.id,c])), items=new Map(data.items.map(it=>[it.id,it]));
  const warningDays=data.settings.find(r=>r.key==='warningDays')?.value??30;
  const counts=it=>it.quantityMode==='batches'?(data.batches.some(b=>b.itemId===it.id)?data.batches.filter(b=>b.itemId===it.id&&!b.archivedAt).reduce((s,b)=>s+b.quantity,0):it.quantityEntered?0:null):it.actualQuantity;
  const rows={
    '抢救车信息':[['车ID','名称','科室','位置','数据用途','已归档'],...data.carts.map(c=>[c.id,c.name,c.department||'',c.location||'',c.dataPurpose,c.archivedAt||''])],
    '物品清单':[['物品ID','车ID','名称','规格','类型','单位','应有数量','实际数量','位置','原最低库存提醒','已归档'],...data.items.map(it=>[it.id,it.cartId,it.name,it.specification||'',it.type,it.unit||'',it.requiredQuantity,counts(it),it.location||'',it.legacyMinimumQuantity??null,it.archivedAt||''])],
    '批次效期':[['批次ID','物品ID','物品名称','批号','数量','有效期原值','精度','剩余天数','状态','计算基准日','已归档'],...data.batches.map(b=>{const status=expiryStatus(b,warningDays);return[b.id,b.itemId,items.get(b.itemId)?.name||'',b.batchNumber||'',b.quantity,b.expiryDate||'',b.expiryPrecision||'',status.days??null,status.label,today(),b.archivedAt||''];})],
    '检查记录':[['记录ID','车名称','物品','检查人','结果','异常','备注','检查时间','记录时间','时间来源','记录来源','当时快照','数据用途'],...data.checks.map(r=>[r.id,carts.get(r.cartId)?.name||'',r.name,r.checker||'',r.result===null?'旧版未记录':r.result==='normal'?'人工自报正常':'异常',(r.findings||[]).join('、'),r.remark||'',r.checkedAt||'',r.recordedAt||'',r.timeSource,r.source,r.snapshot?JSON.stringify(r.snapshot):'',carts.get(r.cartId)?.dataPurpose||'legacy_unclassified'])]
  };
  const workbook=XLSX.utils.book_new();
  for(const [name,values] of Object.entries(rows)){
    const sheet=XLSX.utils.aoa_to_sheet(values,{sheetStubs:false});
    // 用户内容始终作为字符串，绝不构造 f 公式；批号与 ID 保留前导零。
    values.forEach((row,r)=>row.forEach((v,c)=>{const cell=sheet[XLSX.utils.encode_cell({r,c})];if(cell&&typeof v==='string'){cell.t='s';delete cell.f;}}));
    sheet['!cols']=values[0].map((_,i)=>({wch:i===0?24:18}));
    sheet['!autofilter']={ref:sheet['!ref']};XLSX.utils.book_append_sheet(workbook,sheet,name);
  }
  return workbook;
}
export function exportExcel(data){XLSX.writeFileXLSX(makeWorkbook(data),`抢救车管理_${today()}.xlsx`,{compression:true});}
