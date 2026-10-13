import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {latest,observed,change,periodDate,normalize,convertMonthly,freshness,commonObservations,nearestIndex,provenance,countryViewHash,readCountryView} from '../site/core.mjs';
import {renderChart,resetCharts} from '../site/charts.mjs';
import {releaseTotals,renderRunChanges,renderPointChanges} from '../site/releases.mjs';
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
test('asset comparison aligns both ending and beginning dates without filling gaps',()=>{
 const a=series([['2025-01',100],['2025-02',105],['2025-03',110],['2025-04',115]]);
 const b=series([['2025-01',200],['2025-03',230],['2025-04',240],['2025-05',250]]);
 const aligned=commonObservations([a,b]);
 assert.deepEqual(aligned.map(s=>latest(s)[0]),['2025-04','2025-04']);
 assert.deepEqual(aligned.map(s=>change(s,3).from),['2025-01','2025-01']);
 assert.equal(change({...aligned[0],values:aligned[0].values.slice(0,-1)},1),null);
 assert.equal(a.values.length,4);assert.equal(latest(b)[0],'2025-05');
 assert.deepEqual(commonObservations([a,{...b,frequency:'Q'}]),[]);
 assert.equal(latest(commonObservations([a,series([['2024-12',1]])])[0]),null);
});
test('daily comparisons use the same prior common business day',()=>{
 const a=series([['2025-03-27',1],['2025-03-28',2],['2025-04-30',3]],'D');
 const b=series([['2025-03-27',4],['2025-04-30',5]],'D');
 assert.deepEqual(commonObservations([a,b]).map(s=>change(s,1).from),['2025-03-27','2025-03-27']);
});
test('converted prices trace every input and inherit failed dependencies',()=>{
 const gold={...series([['2025-01',100]]),id:'gold',label:'黄金'};
 const fx={...series([['2025-01',7]]),id:'fx',currency:'CNY',source:{status:'retained'}};
 const cpi={...series([['2025-01',140]]),id:'cpi',unit:'2010=100'};
 const result=convertMonthly(gold,fx,cpi);
 assert.deepEqual(provenance(result).map(p=>p.id),['gold','fx','cpi']);
 assert.equal(result.values[0][2],'derived');assert.match(result.note,/2010=100/);
 assert.match(freshness(result,new Date('2025-02-01')),/失败/);
 assert.equal(convertMonthly(gold,series([['2025-01',0]])),null);
 assert.equal(convertMonthly(gold,fx,series([['2025-01',0]])),null);
 assert.equal(convertMonthly(gold,{...fx,frequency:'D'}),null);
 const derived={...gold,inputs:['fx']};assert.match(freshness(derived,new Date('2025-02-01'),new Map([['fx',fx]])),/失败/);
});
test('retained historical source parts remain visible in series health',()=>{
 const s={...series([['2025-01',1]]),sourceParts:[{status:'retained'},{status:'ok'}]};
 assert.match(freshness(s,new Date('2025-02-01')),/失败/);
 const years={...series([['2024-12-31',1],['2025-10-01',2]],'D'),sourceParts:[{dataset:'US Treasury:nominal:2024'},{dataset:'US Treasury:nominal:2025'}]};
 assert.deepEqual(provenance(years).map(p=>p.latestPeriod),['2024-12-31','2025-10-01']);
});
test('chart cursor selects an actual period and clamps at either end',()=>{
 const times=[10,20,40];assert.equal(nearestIndex(times,0),0);assert.equal(nearestIndex(times,45),2);
 assert.equal(nearestIndex(times,31),2);assert.equal(nearestIndex(times,30),1);assert.equal(nearestIndex([],1),-1);
});
test('long chart histories do not create a DOM node per observation; forecasts stay dashed',()=>{
 resetCharts();
 const s={...series(Array.from({length:10000},(_,i)=>[new Date(Date.UTC(1990,0,i+1)).toISOString().slice(0,10),100+i]),'D'),displayName:'测试 <script>',color:'#123456',source:{name:'Test'}};
 const html=renderChart([s]);assert.equal((html.match(/<circle/g)||[]).length,1);assert.match(html,/type="range"/);assert.ok(!html.includes('测试 <script>'));
 const forecast=renderChart([{...s,frequency:'A',values:[['2025',1],['2026',2,'forecast']]}]);assert.match(forecast,/stroke-dasharray="5 5"/);
});
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
test('release counts separate forecasts, historical observations, coverage and legacy records',()=>{
 const run={changes:[{kind:'observations',points:[{kind:'historical-revision'},{kind:'forecast-revision'},{kind:'forecast-realized'},{kind:'status-changed'}]},{kind:'coverage-added'},{historicalRevision:true}]};
 assert.deepEqual(releaseTotals([run]),{series:3,history:2,forecast:1,status:1,coverage:1,legacy:1});
});
test('release details retain real zero and small revisions, with honest missing values',()=>{
 const change={kind:'observations',unit:'%',currency:'USD',points:[{period:'2025',kind:'historical-revision',before:['2025',1.00000001],after:['2025',1.00000002]},{period:'2026',kind:'new-observation',before:null,after:['2026',0]}]};
 const html=renderPointChanges(change);
 assert.match(html,/1\.00000001/);assert.match(html,/1\.00000002/);assert.match(html,/0<small>来源公布值/);assert.match(html,/未有记录/);
});
test('release pagination exposes every changed period without rendering hidden full histories',()=>{
 const change={kind:'observations',points:Array.from({length:120},(_,i)=>({period:String(1900+i),kind:'historical-revision',before:[String(1900+i),0],after:[String(1900+i),1]}))};
 const first=renderPointChanges(change),last=renderPointChanges(change,2);
 assert.equal((first.match(/<tr>/g)||[]).length,51);assert.equal((last.match(/<tr>/g)||[]).length,21);
 assert.match(first,/1900/);assert.doesNotMatch(first,/2019/);assert.match(last,/2019/);assert.match(last,/共 120 条/);
 const run=renderRunChanges({changes:[{...change,area:'US',label:'恶意 <script>'}]},{US:'美国'});
 assert.doesNotMatch(run,/<table/);assert.match(run,/&lt;script&gt;/);
});
test('legacy history revisions never fabricate the changed period from identical endpoints',()=>{
 const html=renderPointChanges({historicalRevision:true,before:['2031',999],after:['2031',999]});
 assert.match(html,/未记录实际修订/);assert.doesNotMatch(html,/999/);
});
test('export provenance retains source definitions and excluded quarters',()=>{
 const input={...series([['2026-Q1',1]],'Q'),id:'HK.currency',definition:'外币计价外债',note:'分项核对不一致时留空',excludedPeriods:['2016-Q1','2016-Q2']};
 const proof=JSON.parse(JSON.stringify(provenance(input)))[0];
 assert.deepEqual(proof.excludedPeriods,['2016-Q1','2016-Q2']);assert.equal(proof.definition,input.definition);assert.equal(proof.note,input.note);
});
test('regional links restore the chosen metric, full history and explicit forecasts',()=>{
 const view={area:'HK',countryMetric:'gdp_growth',years:0,forecasts:true};
 const hash=countryViewHash(view);
 assert.equal(hash,'#countries/HK?metric=gdp_growth&years=0&forecasts=1');
 assert.deepEqual(readCountryView(hash.split('?')[1],new Set(['gdp_growth','debt_P'])),{countryMetric:'gdp_growth',years:0,forecasts:true});
 assert.equal(countryViewHash({...view,years:5,forecasts:false}),'#countries/HK?metric=gdp_growth&years=5');
});
test('unavailable metrics and invalid link controls fall back to a valid historical view',()=>{
 const metrics=new Set(['debt_P','external_debt']);
 for(const query of ['', 'metric=not_available&years=-1&forecasts=true','metric=%3Cscript%3E&years=&forecasts=0','years=1000000']){
  assert.deepEqual(readCountryView(query,metrics),{countryMetric:'debt_P',years:10,forecasts:false});
 }
 assert.deepEqual(readCountryView('metric=external_debt&years=5',metrics),{countryMetric:'external_debt',years:5,forecasts:false});
});
