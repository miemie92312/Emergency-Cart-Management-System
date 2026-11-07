import Dexie from 'dexie';
import { TABLES, emptyData, validateData, makeBackup, parseBackup, migrateLegacy } from './domain.js';
import { readLegacySnapshot } from './legacy-safety.js';
export function createDatabase(name='EmergencyCartAssistantDB') {
  const db=new Dexie(name);
  db.version(1).stores({carts:'id',items:'id,cartId',batches:'id,itemId,expiryDate',checks:'id,cartId,itemId,checkedAt',changes:'id,itemId,occurredAt',templates:'id',fields:'id',settings:'key',legacyArchives:'id',migrations:'id,&sourceFingerprint',meta:'key'});
  db.on('versionchange',()=>db.close());return db;
}
export class ConflictError extends Error { constructor(){super('数据已在另一窗口更改，本次未保存。请保留草稿并刷新后重试。');} }
export class Repository {
  constructor(db=createDatabase()){this.db=db;}
  async initialize(){
    await this.db.open();
    await this.db.transaction('rw',this.db.tables,async()=>{if(!await this.db.meta.get('generation')){const data=emptyData();for(const table of TABLES)if(data[table].length)await this.db.table(table).bulkAdd(data[table]);await this.db.meta.put({key:'generation',value:0});}});
    return this.snapshot();
  }
  async snapshot(){return this.db.transaction('r',this.db.tables,async()=>{const data={};for(const table of TABLES)data[table]=await this.db.table(table).toArray();return {data,generation:(await this.db.meta.get('generation'))?.value??0};});}
  async save(input,expectedGeneration,{restore=false}={}){
    const data=validateData(input);
    return this.db.transaction('rw',this.db.tables,async()=>{
      const generation=(await this.db.meta.get('generation'))?.value??0;
      if(generation!==expectedGeneration)throw new ConflictError();
      if(restore){const before={};for(const t of TABLES)before[t]=await this.db.table(t).toArray();await this.db.meta.put({key:'beforeRestore',value:before,createdAt:new Date().toISOString()});}
      for(const t of TABLES){
        const rows=await this.db.table(t).toArray(), key=t==='settings'?'key':'id', prior=new Map(rows.map(r=>[r[key],r])), next=new Map(data[t].map(r=>[r[key],r]));
        const remove=rows.filter(r=>!next.has(r[key])).map(r=>r[key]), changed=data[t].filter(r=>JSON.stringify(prior.get(r[key]))!==JSON.stringify(r));
        if(remove.length)await this.db.table(t).bulkDelete(remove);
        if(changed.length)await this.db.table(t).bulkPut(changed);
      }
      await this.db.meta.put({key:'generation',value:generation+1});return generation+1;
    });
  }
  async backup(){return makeBackup((await this.snapshot()).data);}
  async preview(input){
    if(input?.format==='emergency-cart-assistant')return {data:await parseBackup(input),legacy:false};
    return {data:await migrateLegacy(input),legacy:true};
  }
  async restore(input,generation){const preview=await this.preview(input);await this.save(preview.data,generation,{restore:true});return this.snapshot();}
  async recovery(){return this.db.meta.get('beforeRestore');}
  async recover(generation){const backup=await this.recovery();if(!backup)throw Error('没有覆盖前的本地快照。');await this.save(backup.value,generation,{restore:true});return this.snapshot();}
}
export async function readExistingLegacy(){
  if(indexedDB.databases){const list=await indexedDB.databases();if(!list.some(db=>db.name==='RescueCartDB'))return null;}
  const db=await new Promise((resolve,reject)=>{
    const r=indexedDB.open('RescueCartDB');
    r.onupgradeneeded=()=>r.transaction.abort();
    r.onerror=()=>r.error?.name==='AbortError'?resolve(null):reject(r.error);
    r.onblocked=()=>reject(Error('旧数据库连接被阻塞，请关闭旧版其他窗口。'));
    r.onsuccess=()=>resolve(r.result);
  });
  if(!db)return null;
  try{if(db.version!==1||!['drugs','checks','settings'].every(t=>db.objectStoreNames.contains(t)))throw Error('旧数据库结构不是已支持的 v1，未执行迁移。');return {version:'1.0',exportTime:new Date().toISOString(),data:await readLegacySnapshot(db)};}finally{db.close();}
}
