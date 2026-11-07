import { describe, it, expect, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readLegacySnapshot, restoreLegacy, requestStore, validateLegacy, validDay } from '../src/legacy-safety.js';
const opened = [];
async function create() {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(`legacy-test-${crypto.randomUUID()}`, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('drugs', {keyPath:'id'}); r.result.createObjectStore('checks',{keyPath:'id'}); r.result.createObjectStore('settings',{keyPath:'key'}); };
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }); opened.push(db); return db;
}
const old = () => ({drugs:[{id:'old',name:'合成物品',quantity:4,minimumQuantity:3,expiryDate:'2027-06-15',extra:'保留未知字段'}],checks:[{id:'check',drugId:'old',checker:'合成姓名',checkedAt:'2026-11-07T00:00:00Z'}],settings:{warningDays:30,lastChecker:'合成姓名',extension:'保留'}});
afterEach(() => { for(const db of opened.splice(0)){ db.close(); indexedDB.deleteDatabase(db.name); } });
describe('原生旧库安全补丁', () => {
  it('拒绝不真实日期和年月自动补日', () => { expect(validDay('2026-02-31')).toBe(false); expect(validDay('2028-02-29')).toBe(true); expect(()=>validateLegacy({...old(),drugs:[{...old().drugs[0],expiryDate:'2027-06'}]})).toThrow(); });
  it('兼容外层/裸数据且保留未知字段和孤立历史', () => { const value=old(); value.checks[0].drugId='missing'; expect(validateLegacy({version:'1.0',data:value})).toEqual(validateLegacy(value)); expect(validateLegacy(value).drugs[0].extra).toBe('保留未知字段'); });
  it('拒绝重复 ID、危险 ID、小数和原型键', () => {
    expect(()=>validateLegacy({...old(),drugs:[old().drugs[0],old().drugs[0]]})).toThrow(/重复/);
    expect(()=>validateLegacy({...old(),drugs:[{...old().drugs[0],id:'bad" id'}]})).toThrow(/ID/);
    expect(()=>validateLegacy({...old(),drugs:[{...old().drugs[0],quantity:0.5}]})).toThrow(/整数/);
    expect(()=>validateLegacy(JSON.parse('{"drugs":[],"checks":[],"settings":{"__proto__":{}}}'))).toThrow();
  });
  it('请求成功后事务 abort 仍然拒绝且旧数据不变', async () => {
    const db=await create(); await restoreLegacy(db,old());
    await expect(requestStore(db,'drugs','readwrite',(store,tx)=>{const req=store.put({id:'temp'}); req.addEventListener('success',()=>tx.abort()); return req;})).rejects.toThrow();
    expect(await readLegacySnapshot(db)).toEqual(old());
  });
  it('中途重复主键使 clear 与已写入第一条一起回滚', async () => {
    const db=await create(); await restoreLegacy(db,old());
    await expect(restoreLegacy(db,{drugs:[{id:'new'},{id:'new'}],checks:[],settings:{warningDays:5}})).rejects.toBeDefined();
    expect(await readLegacySnapshot(db)).toEqual(old());
  });
  it('同步缺主键失败不破坏旧数据，成功恢复完整替换设置', async () => {
    const db=await create(); await restoreLegacy(db,old());
    await expect(restoreLegacy(db,{drugs:[{name:'缺主键'}],checks:[],settings:{}})).rejects.toBeDefined();
    expect(await readLegacySnapshot(db)).toEqual(old());
    const next={drugs:[],checks:[],settings:{warningDays:0}}; await restoreLegacy(db,next);
    expect(await readLegacySnapshot(db)).toEqual(next);
  });
});
