import { z } from 'zod';
import { validDay, validateLegacy } from './legacy-safety.js';

export const TABLES = ['carts', 'items', 'batches', 'checks', 'changes', 'templates', 'fields', 'settings', 'legacyArchives', 'migrations'];
export const DEPARTMENTS = ['普通病区', '急诊', 'ICU', '儿科', '手术室 / 麻醉恢复室', '妇产科', '自定义'];
export const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
export function today() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function plusDays(days, base = today()) {
  const [y,m,d]=base.split('-').map(Number), date=new Date(Date.UTC(y,m-1,d+days));
  return date.toISOString().slice(0,10);
}
export function dayNumber(value) { if(!validDay(value))return null; const [y,m,d]=value.split('-').map(Number); return Date.UTC(y,m-1,d)/86400000; }
export function expiryStatus(batch, warningDays=30, base=today()) {
  if(!batch.expiryDate)return {key:'unset',label:'效期未设置',tone:''};
  if(batch.expiryPrecision==='month')return {key:'pending',label:'日期规则待确认',tone:''};
  const n=dayNumber(batch.expiryDate); if(n===null)return {key:'invalid',label:'日期待修正',tone:'danger'};
  const days=n-dayNumber(base);
  return days<0?{key:'expired',label:`已过期 ${-days} 天`,tone:'danger',days}:days<=warningDays?{key:'warning',label:`近效期 · 剩余 ${days} 天`,tone:'warning',days}:{key:'normal',label:`剩余 ${days} 天`,tone:'good',days};
}
const id=z.string().min(1).max(1024).refine(v=>!['__proto__','prototype','constructor'].includes(v),'主键使用了保留名称');
const text=z.string().max(10000);
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const instant=z.string().refine(v=>Number.isFinite(Date.parse(v)),'时间无效');
const optionalText=text.optional();
const archive={archivedAt:instant.optional()};
const keyed=z.object({id}).passthrough();
const cartSchema=keyed.extend({name:text.min(1),department:text.nullable(),location:optionalText,dataPurpose:z.enum(['demo','user_configured','legacy_unclassified']),createdAt:instant,updatedAt:instant,...archive});
const itemSchema=keyed.extend({cartId:id,type:z.enum(['medicine','consumable','equipment','custom']),name:text.min(1),specification:optionalText,unit:optionalText,requiredQuantity:count.nullable(),quantityPrecision:z.literal(0),quantityMode:z.enum(['batches','aggregate']),actualQuantity:count.nullable().optional(),quantityEntered:z.boolean().optional(),legacyMinimumQuantity:count.optional(),location:optionalText,remark:optionalText,customValues:z.record(z.string(),z.union([text,z.number().finite(),z.null()])).optional(),checklist:z.array(text).optional(),revision:count,createdAt:instant,updatedAt:instant,...archive}).superRefine((row,ctx)=>{
  if(row.quantityMode==='batches'&&row.actualQuantity!==undefined)ctx.addIssue({code:'custom',message:'批次数量是唯一库存来源，不得另存总数。'});
  if(row.quantityMode==='aggregate'&&row.actualQuantity===undefined)ctx.addIssue({code:'custom',message:'汇总数量需明确数值或未知 null。'});
});
const batchSchema=keyed.extend({itemId:id,batchNumber:optionalText,quantity:count,expiryDate:optionalText,expiryPrecision:z.enum(['day','month']).optional(),createdAt:instant,updatedAt:instant,...archive}).superRefine((b,ctx)=>{
  if(!!b.expiryDate!==!!b.expiryPrecision)ctx.addIssue({code:'custom',message:'有效期原值和精度须一起设置。'});
  if(b.expiryPrecision==='day'&&!validDay(b.expiryDate))ctx.addIssue({code:'custom',message:'有效期不是合法日历日期。'});
  if(b.expiryPrecision==='month'&&!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.expiryDate))ctx.addIssue({code:'custom',message:'年月有效期格式应为 YYYY-MM。'});
});
const checkSchema=keyed.extend({cartId:id,itemId:id.nullable(),name:text,checker:text.nullable(),checkedAt:instant.nullable(),recordedAt:instant.nullable(),result:z.enum(['normal','abnormal']).nullable(),findings:z.array(z.enum(['short','expired','packaging','missing','equipment','other'])).nullable(),source:z.enum(['manual_item','manual_batch','recheck','legacy_unknown']),timeSource:z.enum(['device','unknown']),remark:optionalText,snapshot:z.record(z.string(),z.unknown()).optional(),equipmentConfirmed:z.array(z.string()).optional()}).superRefine((r,ctx)=>{
  if(r.source==='legacy_unknown') {
    if(r.result!==null||r.timeSource!=='unknown'||r.recordedAt!==null)ctx.addIssue({code:'custom',message:'旧检查不能补造结果、记录时间或时间来源。'});
    return;
  }
  if(!r.itemId||!r.checker?.trim()||!r.checkedAt||!r.recordedAt||r.timeSource!=='device'||!r.snapshot)ctx.addIssue({code:'custom',message:'新检查须明确物品、人、设备时间与快照。'});
  if(r.result===null||r.findings===null)ctx.addIssue({code:'custom',message:'新检查必须明确结果。'});
  if(r.result==='normal'&&r.findings?.length)ctx.addIssue({code:'custom',message:'正常结果不能同时包含异常。'});
  if(r.result==='abnormal'&&(!r.findings?.length||!r.remark?.trim()))ctx.addIssue({code:'custom',message:'异常须选择原因并填写说明。'});
  if(r.result==='normal'&&r.snapshot?.type==='equipment') {
    const checklist=r.snapshot.checklist, confirmed=new Set(r.equipmentConfirmed||[]);
    if(!Array.isArray(checklist)||!checklist.length||!checklist.every((_,i)=>confirmed.has(String(i))))ctx.addIssue({code:'custom',message:'设备全部必检项正常后才能整体正常。'});
  }
});
const changeSchema=keyed.extend({cartId:id,itemId:id,batchId:id.optional(),label:text,beforeQuantity:count.nullable(),afterQuantity:count.nullable(),reason:optionalText,occurredAt:instant});
const templateSchema=keyed.extend({name:text.min(1),department:text,items:z.array(z.record(z.string(),z.unknown())),version:count,createdAt:instant,updatedAt:instant,...archive});
const fieldSchema=keyed.extend({name:text.min(1),kind:z.enum(['text','number','date','remark']),...archive});
const settingsSchema=z.object({key:id,value:z.unknown()}).passthrough();
const archiveSchema=keyed.extend({rawJson:z.string(),createdAt:instant,source:text});
const migrationSchema=keyed.extend({sourceFingerprint:id,createdAt:instant,cartId:id});
const dataSchema=z.object({carts:z.array(cartSchema),items:z.array(itemSchema),batches:z.array(batchSchema),checks:z.array(checkSchema),changes:z.array(changeSchema),templates:z.array(templateSchema),fields:z.array(fieldSchema),settings:z.array(settingsSchema),legacyArchives:z.array(archiveSchema),migrations:z.array(migrationSchema)}).strict();
function scan(value) { if(value&&typeof value==='object')for(const key of Object.keys(value)){if(['__proto__','prototype','constructor'].includes(key))throw Error(`不允许的字段：${key}`);scan(value[key]);} }
export function validateData(input) {
  scan(input);
  const result=dataSchema.safeParse(input);
  if(!result.success){const issue=result.error.issues[0];throw Error(`${issue.path.join('.')}: ${issue.message}`);}
  const data=result.data, maps={};
  for(const table of TABLES){const seen=new Map(); for(const row of data[table]){const key=table==='settings'?row.key:row.id;if(seen.has(key))throw Error(`${table} 含重复主键。`);seen.set(key,row);} maps[table]=seen;}
  for(const it of data.items)if(!maps.carts.has(it.cartId))throw Error('物品关联的抢救车不存在。');
  for(const b of data.batches)if(maps.items.get(b.itemId)?.quantityMode!=='batches')throw Error('批次必须关联跟踪批次的在车物品。');
  for(const r of [...data.checks,...data.changes]){
    if(!maps.carts.has(r.cartId))throw Error('历史关联的抢救车不存在。');
    if(r.itemId&&(!maps.items.has(r.itemId)||maps.items.get(r.itemId).cartId!==r.cartId))throw Error('历史关联的物品或车不一致。');
  }
  for(const it of data.items){if(it.quantityMode==='batches'){const total=data.batches.filter(b=>b.itemId===it.id&&!b.archivedAt).reduce((s,b)=>s+b.quantity,0);if(!Number.isSafeInteger(total))throw Error('批次数量合计超出整数范围。');}}
  const warning=maps.settings.get('warningDays')?.value;
  if(!Number.isSafeInteger(warning)||warning<0||warning>3650)throw Error('预警天数须为 0 至 3650 的整数。');
  for(const field of data.fields)for(const it of data.items){const v=it.customValues?.[field.id];if(v==null||v==='')continue;if(field.kind==='number'&&typeof v!=='number')throw Error('数字扩展字段的值类型不匹配。');if(field.kind==='date'&&!validDay(v))throw Error('日期扩展字段的值不合法。');}
  return data;
}
export function emptyData() {
  const now=new Date().toISOString(), data=Object.fromEntries(TABLES.map(t=>[t,[]]));
  data.settings=[{key:'warningDays',value:30},{key:'lastExportGeneratedAt',value:null}];
  data.templates=DEPARTMENTS.map((name,i)=>({id:`blank-department-${i}`,name,department:name,items:[],version:1,createdAt:now,updatedAt:now,builtIn:true}));
  return data;
}
function canonical(v){return Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;}
export async function fingerprint(data){const bytes=new TextEncoder().encode(JSON.stringify(canonical(data)));const hash=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function makeBackup(data){const checked=validateData(data);return {format:'emergency-cart-assistant',schemaVersion:2,appVersion:'0.1.0',exportedAt:new Date().toISOString(),data:checked,manifest:{counts:Object.fromEntries(TABLES.map(t=>[t,checked[t].length])),sha256:await fingerprint(checked)}};}
export async function parseBackup(input){
  if(input?.format!=='emergency-cart-assistant'||input?.schemaVersion!==2)throw Error('不是支持的新版备份格式（schemaVersion 2）。');
  const data=validateData(input.data);
  if(!input.manifest?.sha256||input.manifest.sha256!==await fingerprint(data))throw Error('备份完整性校验失败，原数据未改变。');
  for(const table of TABLES)if(input.manifest.counts?.[table]!==data[table].length)throw Error('备份条数校验失败。');
  return data;
}
export async function migrateLegacy(input){
  const old=validateLegacy(input,{allowMonth:true}), digest=await fingerprint(old), data=emptyData(), now=new Date().toISOString(), prefix=`legacy-${digest}-`, cartId=prefix+'cart', map=new Map();
  data.carts.push({id:cartId,name:'迁入抢救车（待确认）',department:null,location:'',dataPurpose:'legacy_unclassified',createdAt:now,updatedAt:now});
  old.drugs.forEach(drug=>{
    const itemId=prefix+encodeURIComponent(`${typeof drug.id}:${drug.id}`);map.set(`${typeof drug.id}:${drug.id}`,itemId);
    data.items.push({id:itemId,cartId,type:'medicine',name:drug.name,specification:drug.specification||'',unit:'',requiredQuantity:null,quantityPrecision:0,quantityMode:'batches',quantityEntered:true,legacyMinimumQuantity:drug.minimumQuantity??3,location:drug.location||'',remark:drug.remark||'',revision:0,createdAt:now,updatedAt:now,legacyRef:{store:'drugs',key:drug.id}});
    data.batches.push({id:itemId+'-initial',itemId,batchNumber:drug.batchNumber||'',quantity:drug.quantity,...(drug.expiryDate?{expiryDate:drug.expiryDate,expiryPrecision:drug.expiryDate.length===7?'month':'day'}:{}),createdAt:now,updatedAt:now});
  });
  old.checks.forEach(check=>{const itemId=map.get(`${typeof check.drugId}:${check.drugId}`)||null;data.checks.push({id:prefix+'check-'+encodeURIComponent(`${typeof check.id}:${check.id}`),cartId,itemId,name:data.items.find(it=>it.id===itemId)?.name||'原物品已不存在',checker:check.checker||null,checkedAt:check.checkedAt||null,recordedAt:null,result:null,findings:null,source:'legacy_unknown',timeSource:'unknown',remark:check.remark||'',legacyRef:{store:'checks',key:check.id,drugId:check.drugId}});});
  if(old.settings.warningDays!==undefined)data.settings[0].value=old.settings.warningDays;
  if(old.settings.lastChecker!==undefined)data.settings.push({key:'lastChecker',value:old.settings.lastChecker});
  data.legacyArchives.push({id:prefix+'archive',rawJson:JSON.stringify(input),createdAt:now,source:'RescueCartDB v1 / JSON v1.0'});
  data.migrations.push({id:prefix+'migration',sourceFingerprint:digest,createdAt:now,cartId});
  return validateData(data);
}
