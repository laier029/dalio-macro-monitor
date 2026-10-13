import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {latest,observed,change,periodDate,normalize,convertMonthly,freshness} from '../site/core.mjs';
const series=(values,frequency='M')=>({values,frequency,source:{status:'ok'},currency:'USD',unit:'美元/盎司'});
test('forecast is not the latest historical observation',()=>{
 const s=series([['2025',2,'historical-estimate'],['2026',3,'forecast']],'A');
 assert.equal(latest(s)[0],'2025');assert.equal(latest(s,true)[0],'2026');assert.equal(observed(s).length,1);
});
test('calendar month-end comparisons handle shorter months',()=>{
 assert.equal(change(series([['2024-02',100],['2024-03',110]]),1).value,10.000000000000009);
 assert.equal(periodDate('2024-Q1').toISOString().slice(0,10),'2024-03-31');
});
test('missing periods never silently become one-month returns',()=>{
 assert.equal(change(series([['2025-01',100],['2025-03',110]]),1),null);
 assert.equal(change(series([['2025-Q1',100],['2025-Q2',110]],'Q'),1),null);
 assert.equal(change(series([['2025-Q1',100],['2025-Q2',110]],'Q'),3).from,'2025-Q1');
});
test('daily lookback accepts weekends but not old months',()=>{
 assert.equal(change(series([['2025-03-28',100],['2025-04-30',110]],'D'),1).from,'2025-03-28');
 assert.equal(change(series([['2025-03-10',100],['2025-04-30',110]],'D'),1),null);
});
test('FX depreciation is negative; yields change in basis points',()=>{
 const fx=series([['2025-01',7],['2025-02',7.7]]);assert.ok(Math.abs(change(fx,1,'fx').value+9.090909)<.00001);
 assert.equal(change(series([['2025-01',4],['2025-02',4.5]]),1,'bps').value,50);
});
test('monthly FX and CPI must share the exact period',()=>{
 const commodity=series([['2025-01',100],['2025-02',110],['2025-03',120]]);
 const fx={...series([['2025-01',7],['2025-03',8]]),currency:'CNY'};
 const cpi=series([['2025-01',140],['2025-02',150]]);
 const result=convertMonthly(commodity,fx,cpi);assert.equal(result.values.length,1);assert.equal(result.values[0][0],'2025-01');assert.ok(Math.abs(result.values[0][1]-500)<1e-9);
 assert.equal(result.currency,'CNY');assert.match(result.unit,/CNY/);
});
test('zero baselines cannot create infinite normalized prices',()=>{assert.deepEqual(normalize(series([['2025-01',0],['2025-02',1]])).values,[]);});
test('stale annual data and source errors are not labeled current',()=>{
 assert.match(freshness(series([['2020',1]],'A'),new Date('2026-10-13')),/滞后/);
 assert.match(freshness({...series([['2026-10-12',1]],'D'),source:{status:'retained'}},new Date('2026-10-13')),/失败/);
});
test('all shipped series are safe to use with the client',()=>{
 const d=JSON.parse(readFileSync(new URL('../site/data/dashboard.json',import.meta.url)));
 assert.equal(d.areas.length,7);assert.ok(d.series.length>180);
 for(const s of d.series){assert.ok(latest(s),s.id);for(const p of s.values)assert.ok(Number.isFinite(p[1]),s.id);assert.ok(Number.isFinite(+periodDate(latest(s)[0])),s.id);}
 assert.equal(d.series.find(s=>s.id==='DE.policy').source.key,d.series.find(s=>s.id==='XM.policy').source.key);
 assert.equal(d.series.some(s=>s.id==='CN.dsr_H'),false);
});
