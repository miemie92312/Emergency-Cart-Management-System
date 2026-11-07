import {it,expect} from 'vitest';
import * as XLSX from 'xlsx';
import {makeWorkbook} from '../src/export.js';
import {emptyData,plusDays} from '../src/domain.js';
import {hydrate,dehydrate,demoCartData} from '../src/view-model.js';
it('导出真实 XLSX 四表，文本不变公式且年月不计算天数',()=>{
  const s=hydrate({data:emptyData(),generation:0});demoCartData(s,'2026-11-07',plusDays);s.items[0].name='=SUM(1,2)';s.items[0].batches[0].number='0000123';
  const workbook=makeWorkbook(dehydrate(s)),buffer=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'}),read=XLSX.read(buffer,{type:'buffer'});
  expect(read.SheetNames).toEqual(['抢救车信息','物品清单','批次效期','检查记录']);
  expect(read.Sheets['物品清单']['C2']).toMatchObject({t:'s',v:'=SUM(1,2)'});expect(read.Sheets['物品清单']['C2'].f).toBeUndefined();
  const batches=XLSX.utils.sheet_to_json(read.Sheets['批次效期']);expect(batches.some(r=>r['批号']==='0000123')).toBe(true);
  const month=batches.find(r=>r['精度']==='month');expect(month['状态']).toBe('日期规则待确认');expect(month['剩余天数']).toBeUndefined();
});
