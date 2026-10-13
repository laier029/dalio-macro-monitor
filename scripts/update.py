"""Fetch official public data, keep provenance, and atomically publish a snapshot.

No keys required. A failed source retains its last validated series with an error
flag. A failed first build never publishes an empty dashboard.
"""
from __future__ import annotations

import argparse
import calendar
import copy
import csv
import datetime as dt
import hashlib
import io
import json
import math
from pathlib import Path
import re
import subprocess
import zipfile
from concurrent.futures import ThreadPoolExecutor

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache'
OUT = ROOT / 'site/data/dashboard.json'
NOW = dt.datetime.now(dt.timezone.utc)
AREAS = [
    dict(id='US', name='美国', en='United States', iso='USA', currency='USD', note='财政比较采用一般政府；美国国债曲线代表联邦政府的边际融资价格。'),
    dict(id='CN', name='中国内地', en='Mainland China', iso='CHN', currency='CNY', note='BIS 政府信用使用 IMF 年度数据插值且有口径例外；地方融资平台估计不与官方一般政府数据混加。BIS 利率采用一年期 LPR，并非七天逆回购利率。'),
    dict(id='HK', name='香港', en='Hong Kong', iso='HKG', currency='HKD', note='BIS 政府信用包含外汇基金负债，不用于财政借债排名。财政债务另看 IMF Fiscal Monitor；央行资产在此代表货币当局／外汇基金统计。联系汇率下需同时看美元利率。'),
    dict(id='JP', name='日本', en='Japan', iso='JPN', currency='JPY', note='财政毛债务与净债务含义不同。观察利率正常化、央行资产和私人偿债负担。'),
    dict(id='XM', name='欧元区', en='Euro area', iso='EURO', currency='EUR', note='欧元区是区域汇总，不与德国、法国相加。货币政策属于欧元体系；BIS 无欧元区合计偿债率。'),
    dict(id='DE', name='德国', en='Germany', iso='DEU', currency='EUR', note='适用欧元区政策利率；德国央行资产是欧元体系的一部分，不表示独立货币政策。'),
    dict(id='FR', name='法国', en='France', iso='FRA', currency='EUR', note='适用欧元区政策利率；法国央行资产是欧元体系的一部分，不表示独立货币政策。'),
]
AREA = {a['id']: a for a in AREAS}
ISO = {a['iso']: a['id'] for a in AREAS}
ISO['EMU'] = 'XM'
BIS_FILES = dict(credit='TC', dsr='DSR', cbta='CBTA', policy='CBPOL', property='SPP', fx='XRU', gap='CREDIT_GAP', cpi='LONG_CPI')
IMF = {
    'NGDP_RPCH': ('growth','实际 GDP 增速','%','income'),
    'PCPIPCH': ('inflation','全年平均 CPI 涨幅','%','income'),
    'LUR': ('unemployment','失业率','%','income'),
    'BCA_NGDPD': ('current_account','经常账户 / GDP','% GDP','external'),
    'GGXCNL_G01_GDP_PT': ('fiscal_balance','财政余额 / GDP','% GDP','fiscal'),
    'GGXONLB_G01_GDP_PT': ('primary_balance','初级余额 / GDP','% GDP','fiscal'),
    'GGR_G01_GDP_PT': ('revenue','财政收入 / GDP','% GDP','fiscal'),
    'G_XWDG_G01_GDP_PT': ('fiscal_debt','一般政府毛债务 / GDP · IMF','% GDP','fiscal'),
}
WDI = {
    'FI.RES.TOTL.CD': ('reserves','国际储备（含黄金）','十亿美元','external',1e9),
    'FB.AST.NPER.ZS': ('npl','银行不良贷款率','%','bank',1),
    'FB.BNK.CAPA.ZS': ('bank_capital','银行资本 / 资产','%','bank',1),
    'NY.GDP.PCAP.PP.KD': ('gdp_per_capita','人均实际 GDP · PPP','2021 国际元','order',1),
}


def numeric(value):
    try:
        v = float(value)
        return round(v, 6) if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def period_end(period):
    if re.fullmatch(r'\d{4}', period):
        return dt.date(int(period), 12, 31)
    if re.fullmatch(r'\d{4}-Q[1-4]', period):
        y, q = int(period[:4]), int(period[-1]); m = q * 3
        return dt.date(y, m, calendar.monthrange(y, m)[1])
    if re.fullmatch(r'\d{4}-\d{2}', period):
        y, m = map(int, period.split('-'))
        return dt.date(y, m, calendar.monthrange(y, m)[1])
    return dt.date.fromisoformat(period)


def points(row, start='2000'):
    return [[k, numeric(v)] for k, v in row.items()
            if re.fullmatch(r'\d{4}(?:-Q[1-4]|-\d{2}(?:-\d{2})?)?', k)
            and k >= start and numeric(v) is not None and period_end(k) <= NOW.date()]


def rows_zip(raw):
    z = zipfile.ZipFile(io.BytesIO(raw))
    name = next(n for n in z.namelist() if n.endswith('.csv'))
    csv.field_size_limit(10_000_000)
    return csv.DictReader(io.StringIO(z.read(name).decode('utf-8-sig')))


def make_series(area, metric, label, unit, freq, group, values, source, **extra):
    values = sorted(values, key=lambda p:p[0])
    if not values:
        return None
    assert len({p[0] for p in values}) == len(values), 'duplicate periods'
    return dict(id=f'{area}.{metric}', area=area, metric=metric, label=label,
                unit=unit, frequency=freq, group=group, values=values,
                currency=AREA.get(area,{}).get('currency','USD'),
                definition=label, note='', source=source, **extra)


def bis_series(key, raw, source):
    result = []
    for r in rows_zip(raw):
        a = r.get('REF_AREA') or r.get('BORROWERS_CTY')
        if a not in AREA:
            continue
        freq = r['FREQ']; kw = {}; spec = None
        if key == 'credit' and freq == 'Q' and r['TC_LENDERS']=='A' and r['UNIT_TYPE']=='770' and r['TC_ADJUST']=='A':
            sector = r['TC_BORROWERS']; val = r['VALUATION']
            if (sector == 'G' and val == 'N') or (sector in ['C','H','N','P'] and val == 'M'):
                spec = (f'debt_{sector}', {'G':'政府信用（名义估值）','C':'非金融部门总信用','H':'居民债务','N':'非金融企业债务','P':'私人非金融部门债务'}[sector]+' / GDP','% GDP','debt')
                kw['definition'] = f'BIS 对{r["Borrowing sector"]}的信用，全部贷款人，{r["Valuation method"]}，断点调整。金融部门未重复加总。'
                kw['note'] = '政府名义估值与官方总量估值不同，不自行加总分项。'
                if a=='HK' and sector in ['G','C']:kw['note']='含外汇基金等货币负债，不能解释为香港财政借债；请对照 IMF 财政毛债务。'
                if a=='CN' and sector in ['G','C']:kw['note']='政府部分含年度插值、未合并等口径例外；不等于广义地方融资平台估计。'
        elif key=='dsr' and freq=='Q':
            sector=r['DSR_BORROWERS']
            if sector in ['P','H','N']:
                spec=(f'dsr_{sector}',{'P':'私人部门偿债率','H':'居民偿债率','N':'企业偿债率'}[sector],'% 收入','service')
                kw['definition']='利息及摊还本金相对于收入，按 BIS 的利率和剩余期限等假设估算。'
                kw['note']='宜与本地区自身历史比较；不同地区绝对水平不适合直接排列风险。'
        elif key=='cbta' and freq=='Q' and r['UNIT_MEASURE']=='XDF_R_B1GQ':
            spec=('cb_assets','央行总资产 / GDP','% GDP','policy')
            kw['definition']=r.get('COMMENT_TS','') or 'BIS 央行总资产相对于名义 GDP。'
            kw['note']='资产规模不能单独代表政策松紧；亏损或负资本不自动等于央行失去履职能力。'
        elif key=='policy' and freq=='D' and a not in ['DE','FR']:
            spec=('policy','政策利率 · BIS 口径','%','policy')
            kw['definition']=r['COMPILATION'];kw['note']=AREA[a]['note']
        elif key=='property' and freq=='Q' and r['UNIT_MEASURE']=='628':
            real=r['VALUE']=='R'
            spec=('house_real' if real else 'house_price','实际住宅价格' if real else '名义住宅价格','2010=100','property')
            kw['definition']='BIS 住宅价格指数'+('，以消费物价平减。' if real else '，未计租金收入与交易成本。')
        elif key=='fx' and ((freq=='D' and r['COLLECTION']=='A') or (freq=='M' and r['COLLECTION']=='A')) and r['CURRENCY']==AREA[a]['currency']:
            spec=('fx' if freq=='D' else 'fx_monthly','本币 / 1 美元'+(' · 月均' if freq=='M' else ''),r['CURRENCY']+'/USD','fx')
            kw['definition']='每 1 美元对应的本币数量；上升表示本币对美元贬值。月均用于月度资产的币种换算。'
        elif key=='gap' and freq=='Q' and r.get('CG_DTYPE')=='C':
            spec=('credit_gap','私人信用 / GDP 缺口','百分点','debt')
            kw['definition']='私人信用与 GDP 比率偏离其长期趋势的百分点；趋势可随历史修订变化。'
        elif key=='cpi' and freq=='M' and r.get('UNIT_MEASURE')=='628':
            spec=('cpi','消费者价格指数','2010=100','income')
        if not spec:
            continue
        metric,label,unit,group=spec
        s=make_series(a,metric,label,unit,freq,group,points(r,'2016' if freq=='D' else '2000'),dict(source,key=r.get('Series'),providerDefinition=r.get('TITLE_TS') or r.get('TITLE') or label))
        if s:
            s.update(kw);result.append(s)
    # Member-state rate history ends in 1998. Explicitly use the shared euro rate.
    if key=='policy':
        euro=next((s for s in result if s['area']=='XM'),None)
        if euro:
            for a in ['DE','FR']:
                s=copy.deepcopy(euro);s.update(id=f'{a}.policy',area=a,note='共同货币政策：显示欧元区利率，并非该国独立利率。');result.append(s)
    return result


def imf_series(key, raw, source):
    d=json.loads(raw); meta=d['indicators'][key]; metric,label,unit,group=IMF[key]
    cutoff=int(meta['projection-year']); result=[]
    for iso, values in d['values'][key].items():
        if iso not in ISO or iso=='EMU':continue
        s=make_series(ISO[iso],metric,label,unit,'A',group,
            [[y,numeric(v),'forecast' if int(y)>=cutoff else 'historical-estimate'] for y,v in values.items() if y>='2000' and numeric(v) is not None],
            dict(source,key=key,vintage=meta['source'],providerModified=meta.get('last-modified')),
            forecastFrom=cutoff)
        if s:
            s['definition']=meta['description'];s['note']=f'{cutoff} 年起按来源标记为预测／估计；此前数据也可能修订。';result.append(s)
    return result


def wdi_series(key, raw, source):
    d=json.loads(raw)
    if not isinstance(d,list) or len(d)!=2 or d[0]['pages']!=1:raise ValueError('Unexpected WDI shape/pagination')
    metric,label,unit,group,scale=WDI[key]; grouped={}
    for r in d[1] or []:
        a=ISO.get(r['countryiso3code']);v=numeric(r['value'])
        if a and v is not None and '2000'<=r['date']<str(NOW.year):grouped.setdefault(a,[]).append([r['date'],round(v/scale,6)])
    result=[]
    for a,pts in grouped.items():
        s=make_series(a,metric,label,unit,'A',group,pts,dict(source,key=key,providerModified=d[0].get('lastupdated')))
        s['note']={'reserves':'含黄金按美元计价，估值变化不等于净干预或资金流；不等于财政可动用资产。','npl':'年度报送，覆盖和贷款分类标准可能不同；不插值成实时银行压力。','bank_capital':'资本与总资产比率，不是风险加权资本充足率。','gdp_per_capita':'购买力平价的人均产出，仅作长期收入背景；不是劳动生产率或国力总分。'}[metric]
        if metric=='reserves':s['currency']='USD'
        result.append(s)
    return result


def treasury_series(key, raw, source):
    data=list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
    if not data or 'Date' not in data[0]:raise ValueError('Treasury did not return a CSV')
    result=[]
    tenors={'3 Mo':('yield_3m','美国 3 个月国债收益率'),'2 Yr':('yield_2y','美国 2 年国债收益率'),'10 Yr':('yield_10y','美国 10 年国债收益率'),'30 Yr':('yield_30y','美国 30 年国债收益率')} if key=='nominal' else {'10 YR':('real_yield_10y','美国 10 年 TIPS 实际收益率')}
    for col,(metric,label) in tenors.items():
        pts=[]
        for r in data:
            v=numeric(r.get(col));date=dt.datetime.strptime(r['Date'],'%m/%d/%Y').date()
            if v is not None and date<=NOW.date():pts.append([date.isoformat(),v])
        s=make_series('US',metric,label,'%','D','rates',pts,dict(source,key=col))
        if s:
            s['note']='到期收益率／恒定期限曲线报价，不是持有期投资回报；变化按基点显示。';result.append(s)
    if not result:raise ValueError('No recognized Treasury tenors')
    return result


def pink_series(raw, source):
    from openpyxl import load_workbook
    w=load_workbook(io.BytesIO(raw),data_only=True,read_only=True)
    rows=list(w['Monthly Prices'].values)
    header=next(r for r in rows if 'Gold' in r)
    result=[]
    for name,metric,label,unit in [('Gold','gold','黄金','美元/金衡盎司'),('Crude oil, Brent','brent','布伦特原油','美元/桶'),('Copper','copper','铜','美元/吨'),('Silver','silver','白银','美元/金衡盎司')]:
        col=header.index(name);pts=[]
        for r in rows:
            if isinstance(r[0],str) and re.fullmatch(r'\d{4}M\d{2}',r[0]) and r[0]>='2000':
                v=numeric(r[col]);period=r[0].replace('M','-')
                if v is not None and period_end(period)<=NOW.date():pts.append([period,v])
        s=make_series('WORLD',metric,label,unit,'M','commodity',pts,dict(source,key='Monthly Prices / '+name))
        if s:
            s['note']='世界银行 Pink Sheet 月均名义美元价格；价格变化不含费用、保管或期货展期，不代表可投资总回报。';result.append(s)
    return result


def derived(series):
    index={s['id']:s for s in series};out=[]
    for a in AREA:
        inputs=[index.get(f'{a}.{m}') for m in ['primary_balance','fiscal_balance','revenue','fiscal_debt']]
        if not all(inputs):continue
        vintages={s['source']['vintage'] for s in inputs}
        if len(vintages)!=1:continue
        maps=[{p[0]:p for p in s['values']} for s in inputs];common=set.intersection(*(set(m) for m in maps))
        for metric,label,fn,definition in [
            ('interest_revenue','政府净利息 / 财政收入',lambda p,b,r,d:(p-b)/r*100,'（初级余额/GDP − 财政余额/GDP）÷（收入/GDP）×100。同一 IMF Fiscal Monitor 版本。净利息扣除了利息收入；不含本金偿还，可为负。'),
            ('debt_revenue','政府毛债务 / 年财政收入',lambda p,b,r,d:d/r*100,'同一 IMF Fiscal Monitor 版本、同年度的政府债务/GDP ÷ 收入/GDP ×100。存量相对于一年收入，不等于当年到期债务。')]:
            pts=[]
            for year in sorted(common):
                p,b,r,d=[m[year][1] for m in maps]
                if r>0:pts.append([year,round(fn(p,b,r,d),6),maps[0][year][2]])
            s=make_series(a,metric,label,'% 收入','A','service',pts,dict(inputs[0]['source'],key='derived:'+metric),forecastFrom=inputs[0]['forecastFrom'])
            if s:
                s['definition']=definition;s['note']='项目计算，非官方直接发布序列。';s['inputs']=[t['id'] for t in inputs];out.append(s)
    return out


def validate_source_coverage(current, previous, dataset):
    """Reject partial responses that would silently remove established coverage."""
    new={s['id']:s for s in current}
    for old in previous:
        if old.get('inputs'):
            continue
        parts=old.get('sourceParts',[old['source']])
        if not any(p['dataset']==dataset for p in parts):
            continue
        if old['id'] not in new:
            raise ValueError('Source response lost existing series: '+old['id'])
        before=old['values']
        if dataset.startswith('US Treasury:'):
            before=[p for p in before if p[0].startswith(dataset.split(':')[-1])]
        after=new[old['id']]['values']
        if before and after[-1][0]<before[-1][0]:
            raise ValueError('Source latest period moved backwards: '+old['id'])
        if len(before)>24 and len(after)<len(before)*.8:
            raise ValueError('Source history unexpectedly contracted: '+old['id'])


def fetch(spec, offline=False, previous=None):
    name,url,ext,parser=spec;path=CACHE/(name+'.'+ext)
    if offline:
        raw=path.read_bytes();fetched=dt.datetime.fromtimestamp(path.stat().st_mtime,dt.timezone.utc).isoformat()
    else:
        run=subprocess.run(['curl','--fail','--silent','--show-error','--location','--globoff','--retry','2','--retry-delay','2','--connect-timeout','20','--max-time','100',url],capture_output=True)
        if run.returncode:raise RuntimeError(run.stderr.decode()[:220])
        raw=run.stdout;fetched=NOW.isoformat()
    src=dict(name=name.split(':')[0],dataset=name,url=url,download=url,fetchedAt=fetched,sha256=hashlib.sha256(raw).hexdigest(),status='ok',releaseDate=None)
    data=parser(raw,src)
    if not data:raise ValueError('No selected series: check schema/coverage')
    validate_source_coverage(data,previous or [],name)
    if not offline:path.write_bytes(raw)
    return data,dict(src,seriesCount=len(data))


def specs(offline=False):
    jobs=[]
    for key,file in BIS_FILES.items():
        jobs.append((f'BIS:{key}',f'https://data.bis.org/static/bulk/WS_{file}_csv_col.zip','zip',lambda raw,s,k=key:bis_series(k,raw,s)))
    for key in IMF:
        jobs.append((f'IMF:{key}',f'https://www.imf.org/external/datamapper/api/v2/{key}','json',lambda raw,s,k=key:imf_series(k,raw,s)))
    for key in WDI:
        url=f'https://api.worldbank.org/v2/country/USA;CHN;HKG;JPN;DEU;FRA;EMU/indicator/{key}?format=json&per_page=10000'
        jobs.append((f'World Bank:{key}',url,'json',lambda raw,s,k=key:wdi_series(k,raw,s)))
    # Discover the current monthly workbook link, which can change each year.
    landing='https://www.worldbank.org/en/research/commodity-markets'
    body=b'' if offline else subprocess.run(['curl','-fLsS','--max-time','40',landing],capture_output=True).stdout
    match=re.search(rb'https://thedocs.worldbank.org/[^"<> ]+/CMO-Historical-Data-Monthly.xlsx',body)
    url=match[0].decode() if match else 'https://thedocs.worldbank.org/en/doc/74e8be41ceb20fa0da750cda2f6b9e4e-0050012026/related/CMO-Historical-Data-Monthly.xlsx'
    jobs.append(('World Bank:Pink Sheet',url,'xlsx',pink_series))
    for year in range(NOW.year-2,NOW.year+1):
        for key,kind in [('nominal','daily_treasury_yield_curve'),('real','daily_treasury_real_yield_curve')]:
            url=f'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type={kind}&field_tdr_date_value={year}&page&_format=csv'
            jobs.append((f'US Treasury:{key}:{year}',url,'csv',lambda raw,s,k=key:treasury_series(k,raw,s)))
    return jobs


def merge_treasury(series):
    merged={}
    for s in series:
        if s['id'] in merged:
            old=merged[s['id']]
            if s['source']['name']!='US Treasury':raise ValueError('Duplicate series '+s['id'])
            pts={p[0]:p for p in old['values']};pts.update({p[0]:p for p in s['values']})
            old['values']=[pts[k] for k in sorted(pts)]
            old.setdefault('sourceParts',[old['source']]).append(s['source'])
            if old['source']['dataset']<s['source']['dataset']:old['source']=s['source']
        else:merged[s['id']]=copy.deepcopy(s)
    return list(merged.values())


def validate(data):
    ids=[s['id'] for s in data['series']]
    assert len(set(ids))==len(ids), 'duplicate series IDs'
    for s in data['series']:
        assert s['values'] and s['source']['url'].startswith('https://')
        assert len({p[0] for p in s['values']})==len(s['values'])
        for p in s['values']:
            assert math.isfinite(p[1])
            if s.get('forecastFrom'):
                assert (len(p)>2 and p[2]=='forecast') == (int(p[0])>=s['forecastFrom'])
            else:assert period_end(p[0])<=NOW.date(), 'Future actual value'
    for a in AREA:
        assert f'{a}.debt_P' in ids and f'{a}.policy' in ids, 'Core coverage missing'
    for a in ['CN','HK','XM']:
        assert f'{a}.dsr_H' not in ids, 'Invented DSR breakdown'
    return True


def write_atomic(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n');tmp.replace(path)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--offline',action='store_true');args=parser.parse_args()
    CACHE.mkdir(exist_ok=True);old=json.loads(OUT.read_text()) if OUT.exists() else {'series':[]}
    jobs=specs(args.offline);series=[];sources=[]
    def collect(spec):
        try:return spec,fetch(spec,args.offline,old['series']),None
        except Exception as e:return spec,None,str(e)
    with ThreadPoolExecutor(max_workers=4) as pool:
        for spec,result,error in pool.map(collect,jobs):
            name,url,_,_=spec
            if result:
                values,src=result;series.extend(values);sources.append(src)
                print(f'OK {name}: {len(values)} series',flush=True)
            else:
                retained=[]
                for s in old['series']:
                    if s.get('inputs'):continue
                    parts=s.get('sourceParts',[s['source']])
                    part=next((p for p in parts if p['dataset']==name),None)
                    if part:
                        item=copy.deepcopy(s);item.pop('sourceParts',None)
                        if name.startswith('US Treasury:'):item['values']=[p for p in item['values'] if p[0].startswith(name.split(':')[-1])]
                        item['source']=dict(part,status='retained',error=error,checkedAt=NOW.isoformat());retained.append(item)
                series.extend(retained);sources.append(dict(name=name.split(':')[0],dataset=name,url=url,status='retained' if retained else 'error',error=error,checkedAt=NOW.isoformat(),seriesCount=len(retained)))
                print(f'WARNING {name}: {error}',flush=True)
    series=merge_treasury(series);series.extend(derived(series))
    # Preserve errors from any dependency, not just the first numerator.
    byid={s['id']:s for s in series}
    for s in series:
        if s.get('inputs') and any(byid[k]['source']['status']!='ok' for k in s['inputs']):s['source']['status']='retained'
    data=dict(schemaVersion=1,generatedAt=NOW.isoformat(),areas=AREAS,series=sorted(series,key=lambda s:s['id']),sources=sources)
    validate(data)
    previous={s['id']:s for s in old['series']}; changes=[]
    for s in data['series']:
        prior=previous.get(s['id'])
        if prior and prior['values']!=s['values']:
            changes.append(dict(id=s['id'],label=s['label'],area=s['area'],before=prior['values'][-1],after=s['values'][-1],historicalRevision=prior['values'][-1]==s['values'][-1]))
    history_path=ROOT/'site/data/updates.json'
    history=json.loads(history_path.read_text()) if history_path.exists() else []
    if changes or not history:
        history.insert(0,dict(date=NOW.isoformat(),baseline=not bool(previous),changes=changes))
    write_atomic(OUT,data);write_atomic(history_path,history[:90])
    # Weekly digest: exact changes since Monday, rather than rebranding quarter changes as weekly news.
    monday=(NOW-dt.timedelta(days=NOW.weekday())).date().isoformat()
    weekly=dict(weekStart=monday,generatedAt=NOW.isoformat(),runs=[r for r in history if r['date'][:10]>=monday],sourcesFailed=[s['dataset'] for s in sources if s['status']!='ok'])
    write_atomic(ROOT/'site/data/weekly.json',weekly)
    print(f'Saved {len(series)} series; {sum(s["status"]!="ok" for s in sources)} degraded sources.',flush=True)


if __name__=='__main__':main()
