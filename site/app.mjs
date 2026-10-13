import {observed,latest,periodDate,change,normalize,convertMonthly,freshness} from './core.mjs';

let data, weekly, history, index, areaIndex;
const exportIndex=new Map();
const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const colors={US:'#2d7862',CN:'#c89748',HK:'#698fa6',JP:'#9b6680',XM:'#7e8f42',DE:'#526aa0',FR:'#ac7b5d',WORLD:'#2d7862'};
const assetColors=['#2d7862','#bd964e','#688da0','#9b6680'];
const frequency={D:'日度',M:'月度',Q:'季度',A:'年度'};
const groupNames={income:'收入与经济',debt:'部门债务',service:'偿债负担',fiscal:'财政收支',policy:'货币政策',external:'对外缓冲',bank:'银行状况',property:'住宅价格',order:'长期背景',fx:'汇率',rates:'融资市场',commodity:'商品价格'};
const state={route:'overview',area:'US',metric:'debt_P',years:10,forecasts:false,selected:new Set(['US','CN','HK','JP','XM']),asset:'commodity',currency:'USD',real:false};
const e=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(v,n=1)=>v===null||v===undefined?'—':Number(v).toLocaleString('zh-CN',{minimumFractionDigits:n,maximumFractionDigits:n});
const s=(a,m)=>index.get(`${a}.${m}`);
const areaName=a=>areaIndex.get(a)?.name||'全球商品';
const signed=(v,n=1)=>v===null?'—':`${v>0?'+':''}${fmt(v,n)}`;
const stamp=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'来源未提供';
const caption=series=>series?`${series.source.name} · ${frequency[series.frequency]} · ${latest(series)?.[0]||'无历史值'}`:'数据未接入';
function heading(eyebrow,title,desc,tag='公开数据 · 随源发布更新') {return `<div class="page-heading"><div><span class="eyebrow">${eyebrow}</span><h1>${title}</h1><p class="subtitle">${desc}</p></div><span class="tag green"><span class="dot"></span>${tag}</span></div>`;}
function panelHead(n,title,desc,link='') {return `<div class="panel-head"><div><span class="section-kicker">${n}</span><h2>${title}</h2>${desc?`<p>${desc}</p>`:''}</div>${link}</div>`;}
function metricValue(a,m,n=1) {const item=s(a,m),p=latest(item);return p?`${fmt(p[1],n)}<small>${e(p[0])}${p[2]?' · 历史/估计':''}</small>`:'—<small>未覆盖</small>';}
function currentDelta(item,months=12,mode='pp') {const c=change(item,months,mode);return c?`${signed(c.value)} ${mode==='bps'?'bp':mode==='pp'?'百分点':'%'}<small>${c.from} → ${c.to}</small>`:'—<small>无同口径比较期</small>';}
function sliceSeries(series,years=state.years) {
  let values=observed(series,state.route==='countries'&&state.forecasts);
  if(years && values.length){const cutoff=new Date();cutoff.setUTCFullYear(cutoff.getUTCFullYear()-years);values=values.filter(p=>periodDate(p[0])>=cutoff);}
  return {...series,values};
}
function chart(list,{height=250,normalizeBase=false,years=state.years}={}) {
  let lines=list.filter(Boolean).map((v,i)=>({...sliceSeries(v,years),color:v.color||colors[v.area]||assetColors[i%4]})).filter(v=>v.values.length);
  if(normalizeBase && lines.length){
    // Rebase only after intersecting observation periods. No forward-fill across holidays or quarters.
    const common=lines.map(l=>new Set(l.values.map(p=>p[0]))).reduce((a,b)=>new Set([...a].filter(x=>b.has(x))));
    lines=lines.map(l=>normalize({...l,values:l.values.filter(p=>common.has(p[0]))})).filter(l=>l.values.length);
  }
  if(!lines.length)return '<div class="chart-empty">这个时间范围没有可比较的数据。</div>';
  const W=window.innerWidth<=680?Math.max(280,window.innerWidth-70):740,H=height,L=42,R=24,T=22,B=32;
  const all=lines.flatMap(l=>l.values),dates=all.map(p=>+periodDate(p[0]));
  let xmin=Math.min(...dates),xmax=Math.max(...dates),ymin=Math.min(...all.map(p=>p[1])),ymax=Math.max(...all.map(p=>p[1]));
  if(ymax===ymin){ymax+=1;ymin-=1;}const pad=(ymax-ymin)*.12;ymax+=pad;ymin-=pad;
  const x=p=>L+(+periodDate(p)-xmin)/(xmax-xmin||1)*(W-L-R),y=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);
  let markup=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(lines.map(l=>areaName(l.area)+' '+l.label).join('、'))}历史趋势"><title>${e(lines.map(l=>l.label).join(' / '))} · ${normalizeBase?'共同期初=100':e(lines[0].unit)}</title>`;
  for(let i=0;i<5;i++){const v=ymin+(ymax-ymin)*i/4,yy=y(v);markup+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text x="${L-8}" y="${yy+3}" text-anchor="end">${fmt(v,Math.abs(v)<10?1:0)}</text>`;}
  for(let i=0;i<5;i++){const t=xmin+(xmax-xmin)*i/4,d=new Date(t),xx=L+(W-L-R)*i/4;markup+=`<text x="${xx}" y="${H-7}" text-anchor="middle">${d.getUTCFullYear()}${xmax-xmin<86400000*900?'-'+String(d.getUTCMonth()+1).padStart(2,'0'):''}</text>`;}
  for(const l of lines){
    const pts=l.values;
    // Break paths at missing regular periods and at the historical/forecast boundary.
    let path='',last=null,oldForecast=false;
    const flush=()=>{if(path)markup+=`<path class="series-line" stroke="${l.color}" ${oldForecast?'stroke-dasharray="5 5"':''} d="${path}"/>`;path='';};
    for(const p of pts){const forecast=p[2]==='forecast',gap=last&&(periodDate(p[0])-periodDate(last[0]))/86400000>({D:10,M:40,Q:105,A:370}[l.frequency]);
      if(forecast!==oldForecast||gap){flush();if(last&&!gap)path=`M${x(last[0])},${y(last[1])} `;}
      path+=`${path?'L':'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)} `;oldForecast=forecast;last=p;
    }flush();
    const end=pts.at(-1);markup+=`<circle cx="${x(end[0])}" cy="${y(end[1])}" r="3" fill="${l.color}"/><text x="${x(end[0])-5}" y="${y(end[1])-9}" text-anchor="end" style="fill:${l.color};font-size:10px">${fmt(end[1],1)}</text>`;
    // Native tooltips on all points; raw values remain accessible in the data table.
    for(const p of pts)markup+=`<circle class="point" cx="${x(p[0])}" cy="${y(p[1])}" r="4" fill="${l.color}"><title>${e(areaName(l.area))} · ${p[0]} · ${fmt(p[1],2)} ${e(l.unit)}${p[2]==='forecast'?' · 预测':''}</title></circle>`;
  }
  markup+='</svg>';
  const lastDates=[...new Set(lines.map(l=>l.values.at(-1)[0]))].join(' / ');
  return `<div class="chart">${markup}</div><p class="chart-caption">${normalizeBase?'共同观察期起点 = 100 · ':''}${e(lines[0].source.name)}${new Set(lines.map(l=>l.source.name)).size>1?' 等':''} · 截至 ${e(lastDates)} · ${all.some(p=>p[2]==='forecast')?'虚线为预测 · ':''}图表留断点，不补造缺失值</p>`;
}
function rangeControls(){return `<div class="segmented" aria-label="历史窗口">${[5,10,0].map(v=>`<button data-years="${v}" class="${v===state.years?'selected':''}" aria-pressed="${v===state.years}">${v?v+' 年':'全部'}</button>`).join('')}</div>`;}
function legendAreas(){return `<div class="legend">${data.areas.map(a=>`<label><input type="checkbox" data-area="${a.id}" ${state.selected.has(a.id)?'checked':''}><i style="background:${colors[a.id]}"></i>${a.name}</label>`).join('')}</div>`;}
function showSource(item){
  if(!item)return '<p class="notice amber">来源没有覆盖这一项，或接口尚待验证。空值不表示零风险。</p>';
  exportIndex.set(item.id,item);
  const p=latest(item),src=item.source;
  return `<details class="detail-source"><summary>口径、来源与原始数值</summary><div class="series-meta"><div>单位：<b>${e(item.unit)}</b> · 币种：<b>${e(item.currency)}</b></div><div>频率：<b>${frequency[item.frequency]}</b> · 最新历史期：<b>${p?.[0]}</b></div><div>来源版本：${e(src.vintage||'来源当前修订版本')}</div><div>发布日期：${e(src.releaseDate||'来源未提供独立发布日期')}</div><div>抓取时间：${stamp(src.fetchedAt)}</div><div>状态：${freshness(item)}${src.providerModified?' · 源更新 '+e(src.providerModified):''}</div></div><p>${e(item.definition)}</p><p>${e(item.note)}</p><p><a href="${e(src.url)}" target="_blank" rel="noopener">官方数据下载 ↗</a> · <span class="code">${e(src.key)}</span></p>${item.forecastFrom?`<p>${item.forecastFrom} 年起为来源预测／估计。此前历史值也可能含估算，不能用于“当时已知”的无前视回测。</p>`:''}<div class="export-row"><button class="download" data-export="${e(item.id)}">下载该序列 CSV</button><span>下表显示最新 12 个历史观察值</span></div><div class="table-wrap"><table><thead><tr><th>观察期</th><th>数值（${e(item.unit)}）</th><th>标记</th></tr></thead><tbody>${observed(item).slice(-12).reverse().map(p=>`<tr><td>${p[0]}</td><td>${fmt(p[1],4)}</td><td>${p[2]?'历史/估计，可能修订':'来源公布值，可能修订'}</td></tr>`).join('')}</tbody></table></div></details>`;
}
function trendNotes(){
  return ['CN','US','JP'].map((a,i)=>{const debt=s(a,'debt_P'),dsr=s(a,'dsr_P'),c=change(debt,12,'pp'),d=change(dsr,12,'pp');return `<div class="watch-item"><span class="number">0${i+1}</span><h3>${areaName(a)} · 私人部门</h3><p class="reading">信用 / GDP 同比 ${c?signed(c.value)+' 个百分点':'比较期不足'}。</p><p>可用于观察信用相对收入的变化。另看偿债率同比 ${d?signed(d.value)+' 个百分点':'暂无可比数据'}，两项不一致时不合并为危机判断。</p><small>${latest(debt)?.[0]} · BIS · 与一年前比较</small></div>`;}).join('');
}
function miniAssets(){return `<div class="table-wrap"><table class="asset-matrix"><thead><tr><th>资产（月均价格）</th><th>近 3 月</th><th>近 12 月</th></tr></thead><tbody>${['gold','brent','copper'].map(m=>{const t=s('WORLD',m);return `<tr><td>${t?.label||m}<small>${latest(t)?.[0]||'未接入'} · 美元</small></td>${[3,12].map(n=>changeCell(change(t,n))).join('')}</tr>`;}).join('')}</tbody></table></div>`;}
function changeCell(c,unit='%'){return `<td>${c?`<span class="change-cell ${c.value>0?'pos':c.value<0?'neg':''}" title="${c.from} → ${c.to}">${signed(c.value)}${unit}</span>`:'<span class="muted">—</span>'}</td>`;}
function overview(){
  const ok=data.sources.filter(x=>x.status==='ok').length;
  return heading('DEBT · POLICY · ASSETS','全球宏观概览','谁在借债，靠什么偿还；政策如何应对，资产如何变化。')+
    `<div class="stats"><div class="stat"><div class="stat-label">核心观察范围 <span>◎</span></div><strong>7 <small>个国家与地区</small></strong><p>美国 · 中国内地 · 香港 · 日本 · 欧洲</p></div><div class="stat"><div class="stat-label">已接入历史序列 <span>↗</span></div><strong>${data.series.length}<small>条</small></strong><p>保留原频率、来源与估计标记</p></div><div class="stat"><div class="stat-label">数据源检查 <span>◷</span></div><strong>${ok}<small>/ ${data.sources.length} 成功</small></strong><p>${ok===data.sources.length?'所有已配置数据集读取成功':'部分数据集更新失败，查看来源页'}</p></div><div class="stat"><div class="stat-label">快照日期 <span>▧</span></div><strong style="font-size:23px">${data.generatedAt.slice(0,10)}</strong><p>抓取日期不等于各指标的观察日期</p></div></div>`+
    `<div class="overview-grid"><section class="panel panel-pad">${panelHead('01 / DEBT LANDSCAPE','债务累积在哪里','跨地区历史比较 · 保留各自观察期')}<div class="controls"><label class="control">指标<select id="overview-metric">${[['debt_P','私人非金融债务 / GDP'],['debt_H','居民债务 / GDP'],['debt_N','非金融企业债务 / GDP'],['fiscal_debt','财政毛债务 / GDP · IMF']].map(([v,t])=>`<option value="${v}" ${state.metric===v?'selected':''}>${t}</option>`).join('')}</select></label>${rangeControls()}</div>${chart([...state.selected].map(a=>s(a,state.metric)))}${legendAreas()}<p class="chart-caption">欧元区与成员国不加总。不同政府、估值口径不混合排名。</p></section><section class="panel panel-pad">${panelHead('02 / EVIDENCE','值得一起看的变化','长期负担与近期压力分别观察')}${trendNotes()}</section></div>`+
    `<section class="panel"><div class="panel-pad" style="padding-bottom:0">${panelHead('03 / REGIONAL VIEW','七个观察窗口','每个数值标注自身观察期，缺失不视为低风险','<a href="#countries">进入地区详情 ↗</a>')}</div><div class="table-wrap"><table><thead><tr><th>国家 / 地区</th><th>财政毛债务 / GDP¹</th><th>居民债务 / GDP²</th><th>企业债务 / GDP²</th><th>私人偿债率²</th><th>政策利率²</th></tr></thead><tbody>${data.areas.map(a=>`<tr><td><a class="name" href="#countries/${a.id}">${a.name} <span class="muted">↗</span></a><small>${a.currency}</small></td>${['fiscal_debt','debt_H','debt_N','dsr_P','policy'].map(m=>`<td>${metricValue(a.id,m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="chart-caption panel-pad" style="padding-top:12px;padding-bottom:15px">¹ IMF Fiscal Monitor，% GDP，年度历史/估计。² BIS，债务为 % GDP，偿债率为 % 收入，利率为 %。偿债率不作跨国风险排名。</p></section>`+
    `<div class="mini-grid"><section class="panel panel-pad">${panelHead('04 / FUNDING','美国融资价格','边际成本窗口 · 不代表债券回报','<a href="#assets/rates">查看利率 ↗</a>')}<div class="value-row"><span>10 年国债收益率</span><strong>${fmt(latest(s('US','yield_10y'))?.[1],2)}<small>%</small></strong></div>${chart([s('US','yield_10y')],{height:160,years:1})}<p class="asset-note">政策利率、收益率和偿债成本的传导有时滞。当前未覆盖各国信用利差与拍卖明细。</p></section><section class="panel panel-pad">${panelHead('05 / POLICY','货币政策响应','官方利率口径不同，点击地区查看定义','<a href="#countries/US">政策与央行 ↗</a>')}${['US','CN','HK','JP','XM'].map(a=>`<div class="mini-row"><a href="#countries/${a}">${areaName(a)}${a==='CN'?' · 1 年 LPR':''}</a><span class="mono">${fmt(latest(s(a,'policy'))?.[1],2)}% <small>${latest(s(a,'policy'))?.[0]||'—'}</small></span></div>`).join('')}</section><section class="panel panel-pad">${panelHead('06 / ASSET PRICES','黄金与商品价格','统一美元计价 · 月度频率','<a href="#assets">完整资产观察 ↗</a>')}${miniAssets()}<p class="asset-note">名义价格变化，不含利息、分红或展期收益。股票及基金总回报待授权与数据核验。</p></section><section class="panel panel-pad">${panelHead('WEEKLY / SOURCE UPDATES','本周数据更新','将新发布、历史修订与旧观察值分开','<a href="#updates">查看更新记录 ↗</a>')}<div class="value-row"><span>本周记录的序列变动</span><strong>${weekly.runs.reduce((n,r)=>n+r.changes.length,0)}<small>次</small></strong></div><p class="subtitle">${history.some(h=>h.baseline)?`首次建立基线：${history.find(h=>h.baseline).date.slice(0,10)}。`:''}季度同比变化不是本周新发生的变化；只有快照间发生变化才记录在这里。</p><div class="notice mt">每日检查来源；每周汇总已记录的变化。无需账户、模型调用或行情订阅。</div></section></div>`;
}
function countries(){
  const a=state.area,area=areaIndex.get(a),all=data.series.filter(t=>t.area===a&&!['fx_monthly'].includes(t.metric));
  if(!s(a,state.countryMetric||''))state.countryMetric='debt_P';const item=s(a,state.countryMetric);
  const pillars=[['政府 · 长期负担','debt_revenue','存量 / 一年财政收入'],['政府 · 当期现金流','interest_revenue','净利息 / 财政收入'],['央行 · 资产规模','cb_assets','并非单独的政策松紧指标'],['私人部门 · 偿债','dsr_P','与自身历史比较']];
  return heading('REGIONAL OBSERVATORY',area.name,'把政府、央行与私人部门放在同一张观察地图上。',area.en)+
  `<div class="country-tabs">${data.areas.map(b=>`<a href="#countries/${b.id}" class="${a===b.id?'active':''}">${b.name}</a>`).join('')}</div><div class="notice">${area.note}</div><div class="pillars">${pillars.map(([title,m,note])=>`<section class="pillar"><div class="overline">${title}</div><strong>${fmt(latest(s(a,m))?.[1])}<small style="display:inline;margin-left:3px">${e(s(a,m)?.unit||'')}</small></strong><p>${e(s(a,m)?.label||'BIS 未覆盖合计偿债率')}</p><small>${latest(s(a,m))?.[0]||'未提供'} · ${note}</small></section>`).join('')}</div>`+
  `<section class="panel panel-pad">${panelHead('EXPLORE / HISTORY','地区指标浏览','选择指标查看趋势、定义与原始观察值')}<div class="controls"><label class="control">指标<select id="country-metric">${Object.entries(groupNames).map(([g,name])=>{const options=all.filter(t=>t.group===g);return options.length?`<optgroup label="${name}">${options.map(t=>`<option value="${t.metric}" ${t.metric===state.countryMetric?'selected':''}>${e(t.label)}</option>`).join('')}</optgroup>`:'';}).join('')}</select></label>${rangeControls()}${item.forecastFrom?`<label class="inline-check"><input type="checkbox" id="show-forecasts" ${state.forecasts?'checked':''}>显示来源预测（虚线）</label>`:''}</div><div class="value-row"><p class="subtitle">${e(item.label)} · ${e(item.unit)}</p><strong>${fmt(latest(item)?.[1],2)}<small> ${latest(item)?.[0]}</small></strong></div>${chart([item],{height:280})}<p class="asset-note">${e(item.note)}</p>${showSource(item)}</section>`+
  `<div class="two-col"><section class="panel panel-pad">${panelHead('LONG & SHORT','长短期观察线索','证据优先，不给出合成风险分数')}<div class="watch-item"><h3>政府长期</h3><p>毛债务相对财政收入：${fmt(latest(s(a,'debt_revenue'))?.[1])}%。应结合经济增长、财政收入结构、债务币种与投资者需求。</p></div><div class="watch-item"><h3>政府短期</h3><p>净利息 / 收入：${fmt(latest(s(a,'interest_revenue'))?.[1])}%。到期本金、总融资需求、持有人与拍卖数据尚未完整接入，因此不能据此判断未来 12 个月续借压力。</p></div><div class="watch-item"><h3>央行与私人部门</h3><p>央行资产 / GDP：${fmt(latest(s(a,'cb_assets'))?.[1])}%；政策利率：${fmt(latest(s(a,'policy'))?.[1],2)}%。央行损益和利率重定价情景仍待补充。私人偿债率：${fmt(latest(s(a,'dsr_P'))?.[1])}%。</p></div></section><section class="panel panel-pad">${panelHead('COVERAGE / AVAILABLE','本地区数据目录',`${all.length} 条已接入序列 · 点击切换上方图表`)}<div class="series-list">${all.map(t=>`<div class="mini-row"><button class="table-button" data-metric="${e(t.metric)}">${e(t.label)}</button><small>${latest(t)?.[0]||'仅预测'}<br>${freshness(t)}</small></div>`).join('')}</div></section></div>`;
}
function assetSeries(){
  if(state.asset==='commodity')return ['gold','brent','copper','silver'].map((m,i)=>{let t=s('WORLD',m);if(state.currency!=='USD'||state.real)t=convertMonthly(t,s({USD:'US',CNY:'CN',EUR:'XM',JPY:'JP',HKD:'HK'}[state.currency],'fx_monthly'),state.real?s({USD:'US',CNY:'CN',EUR:'XM',JPY:'JP',HKD:'HK'}[state.currency],'cpi'):null);return t?{...t,color:assetColors[i]}:null;}).filter(Boolean);
  if(state.asset==='fx')return ['CN','HK','JP','XM'].map(a=>s(a,'fx'));
  if(state.asset==='property')return data.areas.map(a=>s(a.id,state.real?'house_real':'house_price'));
  return ['yield_3m','yield_2y','yield_10y','yield_30y','real_yield_10y'].map((m,i)=>({...s('US',m),color:assetColors[i%4]})).filter(t=>t.id);
}
function assets(){
  const types={commodity:'黄金与商品',fx:'外汇',property:'住宅价格',rates:'国债与 TIPS'};const list=assetSeries();
  const notes={commodity:`月均价格，同币种、共同观察期比较。${state.real?'经消费物价指数调整的价格变化，不含持有成本。':'原始序列为美元名义价格。'}若来源月份不同，图表只保留共同月份。`,fx:'报价为本币 / 1 美元。下表变化按本币对美元的升贬值计算；正数表示本币升值。图表按报价本身归一化，上行表示本币贬值。',property:'住宅价格指数，不含租金、杠杆与交易成本。季度序列不计算 1 个月涨跌。各地住宅覆盖范围不同。',rates:'到期收益率（%）；变化单位为基点 bp。TIPS 为实际收益率，其他为名义收益率。均不是债券投资回报。'};
  return heading('ASSETS & PURCHASING POWER','资产与购买力','先对齐频率、计价货币和价格口径，再解释变化。')+
  `<div class="asset-type" aria-label="资产类别">${Object.entries(types).map(([k,v])=>`<button data-asset="${k}" class="${state.asset===k?'selected':''}" aria-pressed="${state.asset===k}">${v}</button>`).join('')}</div><div class="notice">${notes[state.asset]}</div><section class="panel panel-pad">${panelHead('COMPARE / COMMON BASIS',types[state.asset]+'比较',state.asset==='rates'?'收益率水平 · %':'共同观察期起点 = 100')}
  <div class="controls">${rangeControls()}${state.asset==='commodity'?`<label class="control">计价货币<select id="asset-currency">${['USD','CNY','EUR','JPY','HKD'].map(c=>`<option ${state.currency===c?'selected':''}>${c}</option>`).join('')}</select></label>`:''}${['commodity','property'].includes(state.asset)?`<label class="inline-check"><input id="real-prices" type="checkbox" ${state.real?'checked':''}>消费物价调整</label>`:''}</div>
  ${chart(list,{height:280,normalizeBase:state.asset!=='rates'})}<div class="legend">${list.map(t=>`<span style="font-size:11px"><i style="background:${t.color||colors[t.area]}"></i> ${state.asset==='property'||state.asset==='fx'?areaName(t.area):t.label}</span>`).join('')}</div></section>
  <section class="panel"><div class="panel-pad" style="padding-bottom:0">${panelHead('PERIOD CHANGE','近期变化',state.asset==='rates'?'利率变化 · bp':'价格或本币价值变化 · %，每格可查看比较起止期')}</div><div class="table-wrap"><table class="asset-matrix"><thead><tr><th>观察对象</th><th>最新值</th><th>近 1 月</th><th>近 3 月</th><th>近 12 月</th><th>观察期</th></tr></thead><tbody>${list.map(t=>`<tr><td>${state.asset==='property'||state.asset==='fx'?areaName(t.area):e(t.label)}<small>${e(t.unit)}</small></td><td class="mono">${fmt(latest(t)?.[1],2)}</td>${[1,3,12].map(n=>changeCell(change(t,n,state.asset==='rates'?'bps':state.asset==='fx'?'fx':'percent'),state.asset==='rates'?' bp':'%')).join('')}<td>${latest(t)?.[0]||'—'}<small>${frequency[t.frequency]} · ${freshness(t)}</small></td></tr>`).join('')}</tbody></table></div><p class="asset-note panel-pad">各行起止期以各自来源为准，不能作为同一天的可交易回报排名。日期未对齐或对应期缺失时显示“—”。</p></section>
  <section class="panel panel-pad">${panelHead('TRACE / SOURCES','资产数据来源','展开查看原始序列；币种转换与平减由本项目计算')}${list.map(t=>`<h3 class="mt">${state.asset==='property'||state.asset==='fx'?areaName(t.area)+' · ':''}${e(t.label)}</h3>${showSource(t)}`).join('')}</section>
  <div class="notice amber"><strong>尚未接入：</strong>股票指数、现金持有回报、长债与 TIPS 总回报、股债相关性。待确认公开展示授权与复权／总回报口径后接入；目前不以收益率或未复权价格代替这些回报。无历史预期数据时，不将增长、通胀的实际变化称为“经济意外”。</div>`;
}
const modules=[
 ['收入与经济环境','增长、年度通胀、失业率、月度 CPI','居民收入、工业生产与劳动生产率'],
 ['分部门债务','政府、居民、企业与私人合计信用','可比信用流量、地方融资平台专题'],
 ['偿债与财政压力','私人偿债率、净利息/收入、毛债务/收入','到期本金、总融资需求'],
 ['债务结构与持有人','暂未接入','本外币占比、剩余期限、持有人与利率重定价'],
 ['债券供给与融资市场','美国国债及 TIPS 收益率','其他地区收益率、信用利差与拍卖'],
 ['货币与财政应对','政策利率、央行资产、财政/初级余额','广义货币、央行持债与政策事件'],
 ['央行自身约束','总资产/GDP 基础窗口','损益、资本、汇缴与付息敏感性'],
 ['对外脆弱性与缓冲','经常账户、年度储备（含黄金）','外债期限、净投资头寸、COFER'],
 ['银行、房地产与传染','不良贷款率、资本/资产、名义/实际房价','风险加权资本、流动性、风险暴露'],
 ['全球资产与购买力','商品、汇率、房价、利率；月度币种换算','股票、基金总回报、回撤与相关性'],
 ['长期秩序背景','人均实际 GDP（PPP）','教育、创新、贸易份额、社会与政策事件']
];
function methods(){
 return heading('METHODOLOGY & PROVENANCE','方法、来源与覆盖','每个结论都应能回到指标、定义与观察日期。','独立研究项目')+
 `<section class="panel panel-pad">${panelHead('FRAMEWORK / THE BIG CYCLE','从债务机制到可观察证据','框架参考原著；指标选择、页面与计算由本项目设计')}<div class="flow"><span>收入与生产率</span><i>→</i><span>借贷与支出</span><i>→</i><span>偿债与续借</span><i>→</i><span>政策与损失分担</span><i>→</i><span>资产与购买力</span></div><div class="prose"><p>长期债务负担与短期融资压力分开观察。债务资产同时也是他人的负债，降杠杆可能通过节支、重组、货币支持、转移等方式发生。它们是理解数据的线索，不是确定的周期时钟。</p><p>本项目不是达利欧、桥水、BIS 或其他数据机构的官方网站，未复刻任何专有风险模型。图表为来源当前修订版本；不宣称历史时点已经知道后来修订的数值。中文说明为本项目翻译与解释，并非 BIS 官方译文。</p></div><div class="book-grid"><article class="book"><span class="book-year">2018 / DEBT CYCLES</span><h3>《债务危机》</h3><p>信用扩张、长期债务周期、通缩与通胀型去杠杆。参考第一部分印刷页 9–16、32–40。</p><a href="https://www.principles.com/big-debt-crises-consumer" target="_blank" rel="noopener">官方资料与下载 ↗</a></article><article class="book"><span class="book-year">2021 / WORLD ORDER</span><h3>《变化中的世界秩序》</h3><p>储备货币、国家长期条件与资产购买力。参考官方图表集页 5–7、13–18、28–29。</p><a href="https://www.economicprinciples.org/DalioChangingWorldOrderCharts.pdf" target="_blank" rel="noopener">官方图表集 ↗</a></article><article class="book"><span class="book-year">2025 / THE BIG CYCLE</span><h3>How Countries Go Broke</h3><p>政府与央行分别观察、长期与短期分别观察。参考第 3、5–7、17 章。</p><a href="https://economicprinciples.org/downloads/How-Countries-Go-Broke.pdf?direct=1" target="_blank" rel="noopener">官方原书 ↗</a></article></div><p class="asset-note">补充：<a href="https://www.economicprinciples.org/how-the-economic-machine-works">经济机器原理</a> · <a href="https://www.bridgewater.com/research-and-insights/the-all-weather-story">桥水全天候研究</a>。全天候强调增长、通胀相对预期的变化，本网站当前不提供预期意外指数。</p></section>`+
 `<div class="list-header"><h2>十一项监控内容的实际覆盖</h2><p class="subtitle">“已接入”代表有真实历史序列；各地区仍可能缺项。以下扩展不伪装为已实现功能。</p></div><div class="module-grid">${modules.map((m,i)=>`<article class="module"><span class="module-number">${String(i+1).padStart(2,'0')} / ${i===3?'待补充':'部分覆盖'}</span><h3>${m[0]}</h3><p><strong>当前：</strong>${m[1]}</p><p><strong>待补充：</strong>${m[2]}</p></article>`).join('')}</div>`+
 `<section class="panel panel-pad">${panelHead('DEFINITIONS / GUARDRAILS','固定的解释规则','这些差异会改变结论，不能只放在脚注里')}<div class="prose"><ul><li>香港 BIS 政府信用含外汇基金负债；跨地区财政比较使用 IMF 财政口径。两者不混为财政借债。</li><li>德国、法国使用共同欧元区政策利率。欧元区与成员国不加总，也不视为各自能独立发行欧元。</li><li>私人偿债率含估算假设，主要与本国历史比较。中国内地、香港只有合计值，不虚构居民/企业分项；欧元区无该合计序列。</li><li>政府净利息 / 收入 =（初级余额 − 财政余额）/ 财政收入。负值可表示净利息收入，不意味着没有债务。不同 IMF 版本不混算。</li><li>收益率不是持有期回报；价格变化不等于资金流。月均商品价格乘月均汇率是近似换算，不是逐日换算后取平均。</li><li>国际储备包含黄金估值，不等于政府可随时支用的资产。银行资本/资产不等于风险加权资本充足率。</li><li>增长和通胀数据当前以实际变化呈现；没有可靠历史预期数据，不合成“意外指数”。没有回测支持，不发布危机概率或总风险分。</li><li>数据新鲜度的项目提示阈值：日度超过 14 天、月度 95 天、季度 220 天、年度 850 天。它们只提示发布滞后，不代表经济风险。</li></ul></div></section>`+
 `<section class="panel panel-pad">${panelHead('PUBLIC DATA / ATTRIBUTION','官方数据与使用说明','无 API 密钥；原始统计的权利归各来源机构')}<div class="source-grid"><article class="source-card"><h3>国际清算银行 · BIS</h3><p>信用、偿债率、央行资产、政策利率、CPI、汇率与房价。中文非官方译文。</p><a href="https://data.bis.org/bulkdownload">数据目录 ↗</a> · <a href="https://data.bis.org/help/legal">使用条款</a></article><article class="source-card"><h3>国际货币基金组织 · IMF</h3><p>DataMapper 中的 WEO 与 Fiscal Monitor。来源版本及预测起点随快照保存。</p><a href="https://www.imf.org/external/datamapper/api/help">接口说明 ↗</a> · <a href="https://www.imf.org/external/terms.htm">使用条款</a></article><article class="source-card"><h3>世界银行 / 美国财政部</h3><p>世界银行 WDI、Pink Sheet；财政部官方国债名义与实际收益率。</p><a href="https://www.worldbank.org/en/research/commodity-markets">商品数据 ↗</a> · <a href="https://www.worldbank.org/ext/en/legal/terms-conditions/datasets">数据条款</a></article></div><p class="asset-note">每个序列保留来源地址、来源键、抓取时间和原始文件 SHA-256。图表与派生计算不表示来源机构认可本项目。<a href="data/dashboard.json" download>下载完整数据快照</a> · <a href="https://github.com/laier029/dalio-macro-monitor">查看实现与计算方法</a></p></section>`+
 `<section class="panel"><div class="panel-pad" style="padding-bottom:0">${panelHead('SOURCE HEALTH','最近一次数据检查','失败来源保留已验证历史值，并显示失败状态')}</div><div class="table-wrap"><table class="source-table"><thead><tr><th>数据集</th><th>状态</th><th>序列数</th><th>抓取 / 检查时间（北京时间）</th></tr></thead><tbody>${data.sources.map(x=>`<tr><td><a href="${e(x.url)}" target="_blank" rel="noopener">${e(x.dataset)} ↗</a>${x.error?`<small>${e(x.error)}</small>`:''}</td><td class="${x.status==='ok'?'status-ok':'status-error'}">${x.status==='ok'?'读取成功':x.status==='retained'?'失败 · 保留旧值':'失败 · 未接入'}</td><td>${x.seriesCount||0}</td><td>${stamp(x.fetchedAt||x.checkedAt)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function updates(){
 const entries=weekly.runs.flatMap(r=>r.changes.map(c=>({...c,date:r.date})));
 return heading('RELEASES & REVISIONS','更新记录','记录快照之间的新观察值与修订，不把旧数据重复称为新消息。')+
 `<section class="panel panel-pad">${panelHead('THIS WEEK',`${weekly.weekStart} 起的本周概览`,'以北京时间显示抓取时间；周界按 UTC 周一计算')}<div class="notice">${entries.length?`本周记录到 ${entries.length} 次序列变化。`:'本周尚无基线之后的序列变化。'} ${history.some(h=>h.baseline)?'已建立首份快照，后续更新将从该基线比较。':''}</div>${weekly.sourcesFailed.length?`<div class="notice amber">需检查的来源：${e(weekly.sourcesFailed.join('、'))}</div>`:''}${entries.length?`<div class="table-wrap"><table><thead><tr><th>地区 / 指标</th><th>上次记录</th><th>本次记录</th><th>类型</th></tr></thead><tbody>${entries.map(c=>`<tr><td><a href="#countries/${c.area}">${areaName(c.area)} · ${e(c.label)}</a></td><td>${fmt(c.before[1],2)}<small>${c.before[0]}</small></td><td>${fmt(c.after[1],2)}<small>${c.after[0]}</small></td><td>${c.historicalRevision?'历史修订':c.before[0]===c.after[0]?'同观察期修订':'新观察期'}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state">此处只显示真实发生的数据更新。<br>可以先在全球概览查看各指标的最新历史趋势。</div>'}</section>`+
 `<section class="panel panel-pad">${panelHead('SNAPSHOT HISTORY','数据变更记录','每日检查 · 周内自动汇总 · 保存最近 90 次变更记录')}${history.map(r=>`<div class="mini-row"><div>${stamp(r.date)}<small style="display:block">${r.baseline?'首次基线，不生成周变化判断':r.changes.length+' 条序列变动'}</small></div><span class="tag">${r.baseline?'基线':'更新'}</span></div>`).join('')}<p class="asset-note">GitHub Actions 每日 01:35 UTC（北京时间 09:35）尝试刷新；平台可能延迟调度。连续无活动的公开仓库可能停用定时任务。来源失败时保留旧值，不更新成零。<a href="https://github.com/laier029/dalio-macro-monitor/actions">查看运行记录 ↗</a></p></section>`;
}
function exportCsv(id){const series=exportIndex.get(id)||index.get(id);if(!series)return;const quote=v=>`"${String(v??'').replaceAll('"','""')}"`;const rows=[['地区','指标','观察期','数值','单位','标记','来源','来源版本','抓取时间'],...series.values.map(p=>[areaName(series.area),series.label,p[0],p[1],series.unit,p[2]||'source-reported',series.source.url,series.source.vintage||'',series.source.fetchedAt])];const blob=new Blob(['\ufeff'+rows.map(r=>r.map(quote).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=id+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function bind(){
 $$('[data-years]').forEach(b=>b.addEventListener('click',()=>{state.years=+b.dataset.years;render(false);}));
 $$('[data-area]').forEach(c=>c.addEventListener('change',()=>{c.checked?state.selected.add(c.dataset.area):state.selected.delete(c.dataset.area);render(false);}));
 $('#overview-metric')?.addEventListener('change',ev=>{state.metric=ev.target.value;render(false);});
 $('#country-metric')?.addEventListener('change',ev=>{state.countryMetric=ev.target.value;render(false);});
 $('#show-forecasts')?.addEventListener('change',ev=>{state.forecasts=ev.target.checked;render(false);});
 $$('[data-metric]').forEach(b=>b.addEventListener('click',()=>{state.countryMetric=b.dataset.metric;render(false);$('#country-metric').scrollIntoView({block:'center'});}));
 $$('[data-asset]').forEach(b=>b.addEventListener('click',()=>{state.asset=b.dataset.asset;state.real=false;location.hash='assets/'+state.asset;}));
 $('#asset-currency')?.addEventListener('change',ev=>{state.currency=ev.target.value;render(false);});
 $('#real-prices')?.addEventListener('change',ev=>{state.real=ev.target.checked;render(false);});
 $$('[data-export]').forEach(b=>b.addEventListener('click',()=>exportCsv(b.dataset.export)));
}
function render(scroll=true){
 exportIndex.clear();
 const labels={overview:'全球概览',countries:'地区详情',assets:'资产观察',updates:'更新记录',methods:'方法与来源'};
 document.title=labels[state.route]+' · 全球宏观观察';$('#breadcrumb').textContent=labels[state.route];
 $$('.sidebar nav a').forEach(a=>{const on=a.dataset.route===state.route;a.classList.toggle('active',on);on?a.setAttribute('aria-current','page'):a.removeAttribute('aria-current');});
 $('#main').innerHTML=({overview,countries,assets,updates,methods}[state.route])();bind();if(scroll)window.scrollTo(0,0);
}
function route(){const [page,arg]=location.hash.slice(1).split('/');state.route=['overview','countries','assets','updates','methods'].includes(page)?page:'overview';if(state.route==='countries'&&areaIndex.has(arg))state.area=arg;if(state.route==='assets'&&['commodity','fx','property','rates'].includes(arg))state.asset=arg;render();}
async function init(){
 try{[data,weekly,history]=await Promise.all(['dashboard','weekly','updates'].map(async n=>{const r=await fetch(`data/${n}.json`);if(!r.ok)throw new Error(n+': '+r.status);return r.json();}));index=new Map(data.series.map(x=>[x.id,x]));areaIndex=new Map(data.areas.map(x=>[x.id,x]));
 const age=(Date.now()-new Date(data.generatedAt))/86400000,fail=data.sources.filter(x=>x.status!=='ok').length;$('#freshness').innerHTML=`<span class="dot ${fail||age>3?'warning':''}"></span>${age>3?'快照已 '+Math.floor(age)+' 天未更新':fail?fail+' 项来源需检查':'来源已检查'} · ${data.generatedAt.slice(0,10)}`;
 window.addEventListener('hashchange',route);$('.skip').addEventListener('click',event=>{event.preventDefault();$('#main').focus();$('#main').scrollIntoView();});let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>render(false),150);});route();
 }catch(err){$('#main').innerHTML=`<div class="loading"><h1>数据暂时无法加载</h1><p>请刷新页面重试，或查看 <a href="https://github.com/laier029/dalio-macro-monitor/actions">更新任务状态</a>。</p><p class="code">${e(err.message)}</p></div>`;}
}
init();
