// Release records preserve the exact changed periods; old records stay explicit.
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const changeLabels={
 'new-observation':'新增历史期','historical-backfill':'补充早期数据','historical-revision':'历史修订',
 'forecast-added':'新增预测期','forecast-revision':'预测修订','forecast-removed':'撤回预测',
 'forecast-realized':'预测转为历史/估计','observation-to-forecast':'历史期改标预测',
 'observation-removed':'撤回历史值','status-changed':'标记变化',
 'coverage-added':'新增覆盖','coverage-removed':'移除覆盖','basis-changed':'单位或频率变化',legacy:'旧格式记录'
};
export const changeGroup=kind=>kind==='status-changed'?'status':kind.startsWith('forecast-')&&kind!=='forecast-realized'||kind==='observation-to-forecast'?'forecast':'history';
export function releaseTotals(runs){
 const counts={series:0,history:0,forecast:0,status:0,coverage:0,legacy:0};
 for(const run of runs)for(const change of run.changes||[]){
  counts.series++;
  if(!change.kind)counts.legacy++;
  else if(change.kind!=='observations')counts.coverage++;
  else for(const point of change.points)counts[changeGroup(point.kind)]++;
 }
 return counts;
}
const number=value=>Number.isFinite(value)?value.toLocaleString('zh-CN',{maximumFractionDigits:20}):'—';
const flag=point=>!point?'未有记录':({forecast:'预测','historical-estimate':'历史/估计',derived:'项目计算','source-discrepancy':'来源分项与总额有差异'}[point[2]]||point[2]||'来源公布值');
const pointValue=point=>point?`${number(point[1])}<small>${escape(flag(point))}</small>`:'—<small>未有记录</small>';
const summary=change=>{
 if(change.kind==='observations'){
  const counts=releaseTotals([{changes:[change]}]);
  return [['history','历史'],['forecast','预测'],['status','标记']].filter(([k])=>counts[k]).map(([k,n])=>`${n} ${counts[k]} 期`).join(' · ');
 }
 return changeLabels[change.kind||'legacy'];
};
export function renderRunChanges(run,areaNames){
 return (run.changes||[]).map((change,i)=>`<details class="release-series" data-release-series="${i}"><summary><span>${escape(areaNames[change.area]||change.area)} · ${escape(change.label)}</span><small>${escape(summary(change))}</small></summary><div class="release-points"></div></details>`).join('');
}
function sourceNote(change){
 const source=change.source||change.previousSource;
 if(!source)return '';
 const url=/^https:\/\//.test(source.url||'')?source.url:null;
 return `<p class="asset-note">来源：${url?`<a href="${escape(url)}" target="_blank" rel="noopener">${escape(source.name)} ↗</a>`:escape(source.name)} · ${escape(source.dataset)}${change.previousSource?.vintage||change.source?.vintage?`<br>来源版本：${escape(change.previousSource?.vintage||'未提供')} → ${escape(change.source?.vintage||'未提供')}`:''}</p>`;
}
export function renderPointChanges(change,page=0){
 const source=sourceNote(change),label=changeLabels[change.kind||'legacy'];
 if(!change.kind){
  return `<div class="notice">旧记录只保存序列末期。${change.historicalRevision?'未记录实际修订的观察期，不能据此展示历史修订数值。':'以下是当时保存的末期值，未区分预测变化与历史变化。'}</div>${change.historicalRevision?'':`<div class="table-wrap"><table><thead><tr><th>上次保存的末期</th><th>本次保存的末期</th></tr></thead><tbody><tr><td>${pointValue(change.before)}<small>${escape(change.before?.[0])}</small></td><td>${pointValue(change.after)}<small>${escape(change.after?.[0])}</small></td></tr></tbody></table></div>`}`;
 }
 if(change.kind==='coverage-added'||change.kind==='coverage-removed'){
  const c=change.coverage;
  return `<p>${label}：${escape(c.first)} 至 ${escape(c.last)}，共 ${c.count} 个观察值，其中 ${c.forecasts} 个预测值。</p><div class="notice">这是网站覆盖范围的变化，不代表这些经济变化发生在本周。${change.kind==='coverage-removed'?'移除覆盖不代表债务或风险降为零。':''}</div>${source}`;
 }
 if(change.kind==='basis-changed')return `<div class="notice">单位、币种或频率发生变化，前后数值不直接比较。</div><p>上次：${escape(Object.values(change.beforeBasis).join(' · '))}<br>本次：${escape(Object.values(change.afterBasis).join(' · '))}</p>${source}`;
 const size=50,total=change.points.length,lastPage=Math.max(0,Math.ceil(total/size)-1),current=Math.max(0,Math.min(lastPage,page)),start=current*size;
 return `<p class="asset-note">单位：${escape(change.unit)} · ${escape(change.currency)}。前后值属于同一观察期；空缺不填零。</p><div class="table-wrap release-table"><table tabindex="-1" aria-label="变动明细，第 ${current+1} 页"><thead><tr><th>观察期</th><th>变化类型</th><th>上次快照</th><th>本次快照</th></tr></thead><tbody>${change.points.slice(start,start+size).map(point=>`<tr><td>${escape(point.period)}</td><td><span class="tag ${changeGroup(point.kind)==='forecast'?'amber':''}">${escape(changeLabels[point.kind]||point.kind)}</span></td><td>${pointValue(point.before)}</td><td>${pointValue(point.after)}</td></tr>`).join('')}</tbody></table></div><div class="release-pagination"><span>第 ${start+1}–${Math.min(start+size,total)} 条 / 共 ${total} 条变动</span>${lastPage?`<button data-release-page="${current-1}" ${current===0?'disabled':''}>上一页</button><button data-release-page="${current+1}" ${current===lastPage?'disabled':''}>下一页</button>`:''}</div>${source}`;
}
