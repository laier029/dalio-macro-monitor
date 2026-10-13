import {periodDate,normalize,commonObservations,nearestIndex} from './core.mjs';

const charts=new Map();
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const number=(v,n=2)=>Number(v).toLocaleString('zh-CN',{maximumFractionDigits:n,minimumFractionDigits:n});
export function resetCharts(){charts.clear();}

export function renderChart(series,{height=250,width=740,normalizeBase=false}={}) {
  let lines=series.filter(s=>s.values.length);
  if(normalizeBase)lines=commonObservations(lines).map(s=>({...normalize(s),raw:new Map(s.values.map(p=>[p[0],p])),rawUnit:s.unit}));
  lines=lines.filter(s=>s.values.length);
  if(!lines.length)return '<div class="chart-empty">这个时间范围没有可比较的数据。</div>';
  const id=`history-chart-${charts.size}`,W=width,H=height,L=49,R=18,T=18,B=32;
  const dates=[...new Set(lines.flatMap(l=>l.values.map(p=>p[0])))].sort((a,b)=>periodDate(a)-periodDate(b));
  const times=dates.map(p=>+periodDate(p)),xmin=times[0],xmax=times.at(-1);
  let ymin=Infinity,ymax=-Infinity;
  for(const l of lines)for(const p of l.values){ymin=Math.min(ymin,p[1]);ymax=Math.max(ymax,p[1]);}
  if(ymin===ymax){ymin-=1;ymax+=1;}
  const pad=(ymax-ymin)*.12;ymin-=pad;ymax+=pad;
  const x=p=>L+(+periodDate(p)-xmin)/(xmax-xmin||1)*(W-L-R),y=v=>T+(ymax-v)/(ymax-ymin)*(H-T-B);
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id}-title ${id}-description"><title id="${id}-title">${escape(lines.map(l=>l.displayName).join('、'))}历史趋势</title><desc id="${id}-description">${normalizeBase?'共同期初 = 100':escape(lines[0].unit)}。可在图下拖动观察期，或用左右方向键逐期读取数值。</desc>`;
  for(let i=0;i<5;i++){const v=ymin+(ymax-ymin)*i/4,yy=y(v);svg+=`<line class="grid" x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}"/><text x="${L-8}" y="${yy+3}" text-anchor="end">${number(v,Math.abs(v)<10?1:0)}</text>`;}
  const ticks=W<400?3:5;
  for(let i=0;i<ticks;i++){const t=xmin+(xmax-xmin)*i/(ticks-1),d=new Date(t),xx=L+(W-L-R)*i/(ticks-1);svg+=`<text x="${xx}" y="${H-7}" text-anchor="middle">${d.getUTCFullYear()}${xmax-xmin<86400000*900?'-'+String(d.getUTCMonth()+1).padStart(2,'0'):''}</text>`;}
  for(const l of lines){
    let path='',last=null,forecast=false;
    const flush=()=>{if(path)svg+=`<path class="series-line" stroke="${l.color}" ${forecast?'stroke-dasharray="5 5"':''} d="${path}"/>`;path='';};
    for(const p of l.values){
      const nextForecast=p[2]==='forecast',gap=last&&(periodDate(p[0])-periodDate(last[0]))/86400000>({D:10,M:40,Q:105,A:370}[l.frequency]);
      if(nextForecast!==forecast||gap){flush();if(last&&!gap)path=`M${x(last[0])},${y(last[1])} `;}
      path+=`${path?'L':'M'}${x(p[0]).toFixed(2)},${y(p[1]).toFixed(2)} `;forecast=nextForecast;last=p;
    }
    flush();
  }
  svg+=`<line class="chart-crosshair" y1="${T}" y2="${H-B}"/>${lines.map(l=>`<circle class="chart-marker" r="4" fill="${l.color}"/>`).join('')}<rect class="chart-pointer" x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent"/></svg>`;
  charts.set(id,{lines:lines.map(l=>({...l,points:new Map(l.values.map(p=>[p[0],p]))})),dates,times,x,y,L,R,W,xmin,xmax});
  const sourceNames=[...new Set(lines.map(l=>l.source.name))].join(' / ');
  return `<div class="chart-widget" id="${id}"><div class="chart">${svg}</div><div class="chart-reader"><div class="chart-reader-heading"><label for="${id}-cursor">观察期 <strong data-chart-date></strong></label><span>移动、轻点图表或拖动下方滑块</span></div><input id="${id}-cursor" class="chart-slider" type="range" min="0" max="${dates.length-1}" value="${dates.length-1}" step="1" aria-label="${escape(lines.map(l=>l.displayName).join('、'))}图表观察期" ${dates.length===1?'disabled':''}><div class="chart-readout">${lines.map(l=>`<div class="chart-reading"><span class="reading-label"><i style="background:${l.color}"></i>${escape(l.displayName)}</span><strong data-chart-value></strong><small data-chart-raw></small></div>`).join('')}</div></div><p class="chart-caption">${normalizeBase?`共同起点 ${escape(dates[0])} = 100 · `:''}${escape(sourceNames)} · ${lines.some(l=>l.values.some(p=>p[2]==='forecast'))?'虚线为预测 · ':''}缺失值留空，读数不插值。方向键逐期，Home / End 到首末期。</p></div>`;
}

export function bindCharts(root=document){
  for(const [id,model] of charts){
    const el=root.querySelector(`#${id}`);if(!el)continue;
    const {lines,dates,times,x,y,L,R,W,xmin,xmax}=model;
    const slider=el.querySelector('.chart-slider'),svg=el.querySelector('svg'),hit=el.querySelector('.chart-pointer');
    const crosshair=el.querySelector('.chart-crosshair'),markers=[...el.querySelectorAll('.chart-marker')],readings=[...el.querySelectorAll('.chart-reading')];
    let selected=-1;
    const update=position=>{
      position=Math.max(0,Math.min(dates.length-1,position));if(selected===position)return;selected=position;
      const date=dates[position];slider.value=position;el.querySelector('[data-chart-date]').textContent=date;
      crosshair.setAttribute('x1',x(date));crosshair.setAttribute('x2',x(date));
      const spoken=[];
      lines.forEach((line,i)=>{
        const point=line.points.get(date),value=readings[i].querySelector('[data-chart-value]'),raw=readings[i].querySelector('[data-chart-raw]');
        markers[i].style.display=point?'':'none';
        if(!point){value.textContent='当期无值';raw.textContent='未插值或沿用其他日期';spoken.push(`${line.displayName} 当期无值`);return;}
        const flag=point[2]==='forecast'?' · 预测':point[2]==='historical-estimate'?' · 历史/估计':point[2]==='derived'?' · 项目计算':'';
        value.textContent=`${number(point[1])} ${line.unit}${flag}`;
        const original=line.raw?.get(date);raw.textContent=original?`对应数值 ${number(original[1])} ${line.rawUnit}`:'';
        markers[i].setAttribute('cx',x(date));markers[i].setAttribute('cy',y(point[1]));
        spoken.push(`${line.displayName} ${value.textContent}${original?'，'+raw.textContent:''}`);
      });
      slider.setAttribute('aria-valuetext',`${date}；${spoken.join('；')}`);
    };
    const fromPointer=event=>{
      // Screen coordinates must be transformed because narrow panels scale the SVG.
      const matrix=svg.getScreenCTM();if(!matrix)return;
      const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());
      const fraction=Math.max(0,Math.min(1,(point.x-L)/(W-L-R)));
      update(nearestIndex(times,xmin+fraction*(xmax-xmin)));
    };
    slider.addEventListener('input',()=>update(+slider.value));
    hit.addEventListener('pointerdown',event=>{fromPointer(event);hit.setPointerCapture(event.pointerId);});
    hit.addEventListener('pointermove',event=>{if(event.pointerType==='mouse'||event.buttons)fromPointer(event);});
    update(dates.length-1);
  }
}
