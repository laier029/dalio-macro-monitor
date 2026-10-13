export function observed(series, forecasts=false) { return (series?.values||[]).filter(p=>forecasts||p[2]!=='forecast'); }
export function latest(series, forecasts=false) { return observed(series, forecasts).at(-1)||null; }
export function periodDate(p) {
  if(/^\d{4}$/.test(p)) return new Date(`${p}-12-31T00:00:00Z`);
  if(p.includes('-Q')) return new Date(Date.UTC(+p.slice(0,4),+p.at(-1)*3,0));
  if(p.length===7) return new Date(Date.UTC(+p.slice(0,4),+p.slice(5,7),0));
  return new Date(`${p}T00:00:00Z`);
}
export function lagPoint(series, months, forecasts=false) {
  const pts=observed(series,forecasts), end=pts.at(-1); if(!end)return null;
  const freq=series.frequency;
  if(freq==='Q' && months%3 || freq==='A' && months%12) return null;
  const d=periodDate(end[0]);
  const targetMonth=d.getUTCFullYear()*12+d.getUTCMonth()-months;
  const year=Math.floor(targetMonth/12), month=targetMonth%12;
  const target=new Date(Date.UTC(year,month,Math.min(d.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate())));
  if(freq!=='D') return pts.find(p=> {const x=periodDate(p[0]);return x.getUTCFullYear()===year&&x.getUTCMonth()===month;})||null;
  return [...pts].reverse().find(p=> {const diff=target-periodDate(p[0]);return diff>=0&&diff<=10*86400000;})||null;
}
export function change(series, months, mode='percent') {
  const end=latest(series), start=lagPoint(series,months); if(!end||!start)return null;
  let value=mode==='bps'?(end[1]-start[1])*100:mode==='pp'?end[1]-start[1]:start[1]===0?null:mode==='fx'?(start[1]/end[1]-1)*100:(end[1]/start[1]-1)*100;
  return value===null?null:{value,from:start[0],to:end[0]};
}
export function normalize(series) {
  const pts=observed(series);if(!pts.length||!pts[0][1])return {...series,values:[]};
  return {...series,values:pts.map(p=>[p[0],p[1]/pts[0][1]*100]),unit:'期初=100'};
}
// Exact shared periods only: neither interpolation nor forward-filling is permitted.
export function commonObservations(list) {
  if(!list.length||list.some(s=>!s||s.frequency!==list[0].frequency))return [];
  let common=new Set(observed(list[0]).map(p=>p[0]));
  for(const s of list.slice(1)) {const dates=new Set(observed(s).map(p=>p[0]));common=new Set([...common].filter(p=>dates.has(p)));}
  return list.map(s=>({...s,values:observed(s).filter(p=>common.has(p[0]))}));
}
export function nearestIndex(sortedTimes,time) {
  if(!sortedTimes.length)return -1;
  let lo=0,hi=sortedTimes.length-1;
  while(lo<hi){const mid=Math.floor((lo+hi)/2);if(sortedTimes[mid]<time)lo=mid+1;else hi=mid;}
  return lo>0&&time-sortedTimes[lo-1]<=sortedTimes[lo]-time?lo-1:lo;
}
export function provenance(series,lookup=new Map()) {
  const inputs=series.dependencies||series.inputs?.map(id=>lookup.get(id)).filter(Boolean);
  return (inputs?.length?inputs:[series]).flatMap(input=>(input.sourceParts||[input.source]).map(source=>({
    id:input.id,label:input.label,unit:input.unit,frequency:input.frequency,
    definition:input.definition,note:input.note,excludedPeriods:input.excludedPeriods,
    latestPeriod:input.sourceParts?observed(input).filter(p=>p[0].startsWith(source.dataset?.split(':').at(-1))).at(-1)?.[0]:input.latestPeriod||latest(input)?.[0],source
  })));
}
export function convertMonthly(series, fx, cpi=null) {
  if(series?.frequency!=='M'||fx?.frequency!=='M'||(cpi&&cpi.frequency!=='M'))return null;
  const rates=new Map(observed(fx).map(p=>[p[0],p[1]]));
  const prices=cpi?new Map(observed(cpi).map(p=>[p[0],p[1]])):null;
  const values=observed(series).filter(p=>rates.get(p[0])>0&&Number.isFinite(rates.get(p[0]))&&(!prices||prices.get(p[0])>0&&Number.isFinite(prices.get(p[0])))).map(p=>[p[0],p[1]*rates.get(p[0])/(prices?prices.get(p[0])/100:1),'derived']);
  if(!values.length)return null;
  const dependencies=[series,fx,...(cpi?[cpi]:[])].map(s=>({id:s.id,label:s.label,unit:s.unit,frequency:s.frequency,latestPeriod:latest(s)?.[0],source:s.source,sourceParts:s.sourceParts}));
  const formula=`同月月均美元价格 × 同月本币/美元月均汇率${cpi?' ÷（同月 CPI / 100）':''}`;
  return {...series,values,currency:fx.currency,unit:series.unit.replace('美元',fx.currency)+(cpi?'（CPI 调整）':''),
    dependencies,inputs:dependencies.map(s=>s.id),formula,
    note:`${formula}。${cpi?`CPI 基期为 ${cpi.unit}，调整值以该基期购买力表示。`:''}月均乘积是近似换算；不是逐日换算的月均，也不含投资成本。`};
}
export function ageDays(series,now=new Date()) {
  const p=latest(series);return p?Math.floor((now-periodDate(p[0]))/86400000):null;
}
export function freshness(series,now=new Date(),lookup=new Map()) {
  if(!series)return '缺失';
  if(series.source?.status!=='ok'||provenance(series,lookup).some(p=>p.source?.status!=='ok'))return '更新失败 · 保留旧值';
  if(!latest(series))return '无共同观察值';
  const max={D:14,M:95,Q:220,A:850}[series.frequency];
  return ageDays(series,now)>max?'发布滞后 · 请核实':'按源频率';
}
