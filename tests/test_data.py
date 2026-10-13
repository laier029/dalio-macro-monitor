import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile

def fiscal_payload(rows):
    return json.dumps(dict(data=rows,meta={'total-count':len(rows),'total-pages':1})).encode()

def maturity_fixture():
    classes=[('Bills Maturity Value','Total Unmatured Treasury Bills','2026-10-31',100),
        ('Notes','Total Unmatured Treasury Notes','2027-09-30',200),
        ('Bonds','Total Unmatured Treasury Bonds','2027-10-31',300),
        ('Inflation-Protected Securities','Total Treasury TIPS','2028-09-30',400),
        ('Floating Rate Notes','Total Treasury Floating Rate Notes','2026-12-31',50)]
    rows=[]
    for i,(kind,label,date,amount) in enumerate(classes):
        rows.extend([dict(record_date='2026-09-30',security_class1_desc=kind,security_class2_desc=f'9123456{i}0',maturity_date=date,outstanding_amt=str(amount)),dict(record_date='2026-09-30',security_class1_desc=kind,security_class2_desc=label,maturity_date='null',outstanding_amt=str(amount))])
    rows.append(dict(record_date='2026-09-30',security_class1_desc='Total Marketable',security_class2_desc='null',maturity_date='null',outstanding_amt='1060'))
    for i,r in enumerate(rows):r['src_line_nbr']=str(i+1)
    return rows

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('update',ROOT/'scripts/update.py')
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)

class DataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data=json.loads((ROOT/'site/data/dashboard.json').read_text())
        cls.index={s['id']:s for s in cls.data['series']}

    def test_snapshot_invariants(self):
        self.assertTrue(update.validate(self.data))

    def test_maturity_profile_cannot_disagree_with_history_total(self):
        bad=copy.deepcopy(self.data)
        # This check remains compatible with snapshots predating the new source.
        item=next((s for s in bad['series'] if s.get('maturityProfile')),None)
        if not item:
            result=update.fiscal_maturity_series(fiscal_payload(maturity_fixture()),{'url':'https://example.gov/data'})
            item=result[1];bad['series'].append(item)
        item['maturityProfile']['months'][0][1]+=1
        with self.assertRaisesRegex(AssertionError,'maturity months'):update.validate(bad)

    def test_fiscal_cashflow_uses_same_vintage_and_net_interest(self):
        for a in update.AREA:
            rows=[self.index[f'{a}.{m}'] for m in ['primary_balance','fiscal_balance','revenue','interest_revenue']]
            self.assertEqual(len({s['source']['vintage'] for s in rows}),1)
            pts=[{p[0]:p[1] for p in s['values']} for s in rows]
            for y,v in pts[3].items():self.assertAlmostEqual(v,(pts[0][y]-pts[1][y])/pts[2][y]*100,places=4)
        self.assertIn('净利息',self.index['HK.interest_revenue']['definition'])

    def test_imf_forecasts_remain_tagged(self):
        for s in self.data['series']:
            if s.get('forecastFrom'):
                for p in s['values']:self.assertEqual(p[2]=='forecast',int(p[0])>=s['forecastFrom'])

    def test_discontinued_national_policy_rates_not_used(self):
        for a in ['DE','FR']:
            self.assertEqual(self.index[f'{a}.policy']['values'],self.index['XM.policy']['values'])
            self.assertIn('共同',self.index[f'{a}.policy']['note'])

    def test_bis_missing_breakdowns_not_manufactured(self):
        for a in ['CN','HK','XM']:
            self.assertNotIn(f'{a}.dsr_H',self.index)
        self.assertNotIn('XM.dsr_P',self.index)
        self.assertIn('外汇基金',self.index['HK.debt_G']['note'])

    def test_vintage_mismatch_prevents_derived_ratio(self):
        inputs=copy.deepcopy([self.index['US.'+m] for m in ['primary_balance','fiscal_balance','revenue','fiscal_debt']])
        inputs[0]['source']['vintage']='different release'
        self.assertEqual(update.derived(inputs),[])

    def test_nan_and_future_values_fail_validation(self):
        bad=copy.deepcopy(self.data);bad['series'][0]['values'][-1][1]=float('nan')
        with self.assertRaises(AssertionError):update.validate(bad)

    def test_no_duplicate_or_out_of_order_periods(self):
        for s in self.data['series']:
            dates=[p[0] for p in s['values']]
            self.assertEqual(dates,sorted(set(dates)),s['id'])

    def test_maturity_horizons_and_coverage_use_existing_principal(self):
        result=update.fiscal_maturity_series(fiscal_payload(maturity_fixture()),{'name':'US Fiscal','status':'ok'})
        byid={s['metric']:s for s in result}
        self.assertEqual(byid['maturity_due_3m']['values'][-1][1],.15)
        self.assertEqual(byid['maturity_due_12m']['values'][-1][1],.35)
        self.assertAlmostEqual(byid['maturity_share_12m']['values'][-1][1],350/1050*100,places=5)
        profile=byid['maturity_due_12m']['maturityProfile']
        self.assertEqual(profile['securityCount'],5)
        self.assertEqual(profile['excludedPrincipal'],.01)
        self.assertAlmostEqual(sum(p[1] for p in profile['months']),.35)
        self.assertEqual(profile['months'][0][0],'2026-10')
        self.assertEqual(profile['months'][-1][0],'2027-09')

    def test_reopenings_can_have_null_or_split_balances(self):
        rows=maturity_fixture();reopening=dict(rows[0],src_line_nbr='99',outstanding_amt='null');rows.append(reopening)
        result=update.fiscal_maturity_series(fiscal_payload(rows),{})
        self.assertEqual(result[1]['maturityProfile']['securityCount'],5)
        rows[0]['outstanding_amt']='60';rows[-1]['outstanding_amt']='40'
        result=update.fiscal_maturity_series(fiscal_payload(rows),{})
        self.assertEqual(result[1]['maturityProfile']['securityCount'],5)
        self.assertEqual(result[1]['values'][-1][1],.35)
        rows[-1]['outstanding_amt']='60'
        with self.assertRaisesRegex(ValueError,'does not reconcile'):update.fiscal_maturity_series(fiscal_payload(rows),{})

    def test_matured_floating_rate_notes_not_counted_as_future_rollover(self):
        rows=maturity_fixture();rows[-2]['outstanding_amt']='70';rows[-1]['outstanding_amt']='1080';base=rows[-2]
        rows.append(dict(base,src_line_nbr='98',security_class2_desc='Total Unmatured Treasury Floating Rate Notes',outstanding_amt='50'))
        rows.append(dict(base,src_line_nbr='99',security_class2_desc='Total Matured Treasury Floating Rate Notes',outstanding_amt='20'))
        result=update.fiscal_maturity_series(fiscal_payload(rows),{})
        self.assertEqual(result[1]['values'][-1][1],.35)

    def test_duplicate_fiscal_pages_and_missing_subtotals_are_rejected(self):
        rows=maturity_fixture()
        with self.assertRaisesRegex(ValueError,'Duplicate'):update.fiscal_maturity_series(fiscal_payload(rows+rows),{})
        rows.pop(1)
        with self.assertRaisesRegex(ValueError,'subtotal missing'):update.fiscal_maturity_series(fiscal_payload(rows),{})

    def test_pagination_keeps_each_response_hash_and_rejects_changed_totals(self):
        def page(rows,count=2):return json.dumps(dict(data=rows,meta={'total-count':count,'total-pages':2})).encode()
        first=page([{'record_date':'2026-08-31','src_line_nbr':'1'}]);second=page([{'record_date':'2026-09-30','src_line_nbr':'1'}])
        with patch.object(update,'request_bytes',return_value=second) as request:
            combined=update.complete_fiscal_pages(first,'https://example.gov/api?page[size]=1')
        parsed=json.loads(combined);self.assertEqual(len(parsed['data']),2)
        self.assertEqual(len(parsed['responsePages']),2);self.assertEqual(len(parsed['responsePages'][0]['sha256']),64)
        request.assert_called_once_with('https://example.gov/api?page[size]=1&page[number]=2')
        with patch.object(update,'request_bytes',return_value=page([],3)):
            with self.assertRaisesRegex(ValueError,'changed during'):update.complete_fiscal_pages(first,'https://example.gov/api?size=1')

    def test_official_ownership_discrepancy_is_preserved_and_marked(self):
        row=dict(record_date='2020-01-31',src_line_nbr='1',security_type_desc='Total Treasury Securities Outstanding',security_class_desc='_',debt_held_public_mil_amt='70',intragov_hold_mil_amt='30',total_mil_amt='101')
        result=update.fiscal_debt_series(fiscal_payload([row]),{})
        self.assertEqual(result[0]['values'],[['2020-01',.101,'source-discrepancy']])
        self.assertEqual(result[0]['reconciliationDifferencesMillions']['2020-01'],-1)

    def test_partial_source_cannot_silently_drop_existing_regions(self):
        old=[self.index['US.dsr_P'],self.index['HK.dsr_P']]
        with self.assertRaisesRegex(ValueError,'lost existing series'):
            update.validate_source_coverage(old[:1],old,'BIS:dsr')

    def test_history_regression_is_rejected(self):
        old=self.index['US.dsr_P'];new=copy.deepcopy(old)
        new['values']=new['values'][:-1]
        with self.assertRaisesRegex(ValueError,'moved backwards'):
            update.validate_source_coverage([new],[old],'BIS:dsr')

    def test_total_outage_keeps_every_existing_value_and_flags_sources(self):
        # Exercise the entire rebuild/fallback/write path without any network.
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'site/data/dashboard.json';out.parent.mkdir(parents=True)
            out.write_text(json.dumps(self.data))
            jobs=[(s['dataset'],s['url'],'json',None) for s in self.data['sources']]
            with patch.object(update,'ROOT',root),patch.object(update,'CACHE',root/'.cache'),patch.object(update,'OUT',out),patch.object(update,'specs',return_value=jobs),patch.object(update,'fetch',side_effect=RuntimeError('simulated outage')),patch('sys.argv',['update.py']),patch('builtins.print'):
                update.main()
            rebuilt=json.loads(out.read_text());actual={s['id']:s for s in rebuilt['series']}
            self.assertEqual(set(actual),set(self.index))
            for key,old in self.index.items():
                self.assertEqual(actual[key]['values'],old['values'],key)
                self.assertEqual(actual[key]['source']['status'],'retained',key)
            self.assertTrue(all(s['status']=='retained' for s in rebuilt['sources']))

    def journal_series(self, values, **overrides):
        return dict(id='US.test',label='测试',area='US',unit='%',currency='USD',frequency='A',values=values,source={'name':'Test','dataset':'test','status':'ok'},**overrides)

    def test_journal_records_actual_revised_period_behind_unchanged_forecast(self):
        old=self.journal_series([['2024',1],['2025',2,'historical-estimate'],['2031',3,'forecast']])
        new=copy.deepcopy(old);new['values'][1][1]=2.2
        changes=update.series_changes([old],[new]);p=changes[0]['points']
        self.assertEqual(p,[dict(period='2025',kind='historical-revision',before=['2025',2,'historical-estimate'],after=['2025',2.2,'historical-estimate'])])
        self.assertEqual(old['values'][1][1],2)

    def test_journal_separates_forecast_revisions_realizations_and_flag_changes(self):
        old=self.journal_series([['2024',1],['2025',2,'forecast'],['2026',3,'forecast'],['2027',4,'forecast']])
        new=self.journal_series([['2024',1,'historical-estimate'],['2025',2.1,'historical-estimate'],['2026',3.2,'forecast'],['2028',5,'forecast']])
        points={p['period']:p for p in update.series_changes([old],[new])[0]['points']}
        self.assertEqual({k:v['kind'] for k,v in points.items()},{'2024':'status-changed','2025':'forecast-realized','2026':'forecast-revision','2027':'forecast-removed','2028':'forecast-added'})
        self.assertIsNone(points['2027']['after']);self.assertIsNone(points['2028']['before'])

    def test_journal_distinguishes_new_history_backfill_and_withdrawal(self):
        old=self.journal_series([['2023',0],['2025',2]])
        new=self.journal_series([['2024',1],['2025',2],['2026',0]])
        points={p['period']:p for p in update.series_changes([old],[new])[0]['points']}
        self.assertEqual([points[k]['kind'] for k in ['2023','2024','2026']],['observation-removed','historical-backfill','new-observation'])
        self.assertEqual(points['2026']['after'][1],0)

    def test_journal_first_baseline_and_metadata_refresh_are_not_market_news(self):
        old=self.journal_series([['2025',1]])
        self.assertEqual(update.series_changes([],[old]),[])
        new=copy.deepcopy(old);new['source'].update(fetchedAt='later',status='retained',error='outage')
        self.assertEqual(update.series_changes([old],[new]),[])

    def test_journal_reports_coverage_and_incompatible_units_separately(self):
        old=self.journal_series([['2025',1]])
        added=copy.deepcopy(old);added['id']='HK.test'
        changes=update.series_changes([old],[old,added]);self.assertEqual(changes[0]['kind'],'coverage-added');self.assertEqual(changes[0]['points'],[])
        self.assertEqual(update.series_changes([old,added],[old])[0]['kind'],'coverage-removed')
        new=copy.deepcopy(old);new['unit']='百分点';new['values'][0][1]=100
        self.assertEqual(update.series_changes([old],[new])[0]['kind'],'basis-changed')

    def test_journal_preserves_every_changed_point_and_source_snapshot(self):
        old=self.journal_series([[str(1800+i),i] for i in range(120)])
        new=copy.deepcopy(old)
        for p in new['values']:p[1]+=1
        new['source']['sha256']='new-hash'
        changes=update.series_changes([old],[new]);self.assertEqual(len(changes[0]['points']),120)
        new['source']['sha256']='changed-after-comparison'
        self.assertEqual(changes[0]['source']['sha256'],'new-hash')

    def test_refresh_writes_period_changes_and_keeps_weekly_history_in_sync(self):
        values=copy.deepcopy([s for s in self.data['series'] if not s.get('inputs')])
        item=next(s for s in values if s['id']=='US.debt_P');item['values'][0][1]+=1
        period=item['values'][0][0]
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);out=root/'site/data/dashboard.json';out.parent.mkdir(parents=True)
            out.write_text(json.dumps(self.data))
            records=[dict(date=update.NOW.isoformat(),baseline=False,changes=[]) for _ in range(90)]
            (out.parent/'updates.json').write_text(json.dumps(records))
            job=('Test','https://example.gov','json',None)
            with patch.object(update,'ROOT',root),patch.object(update,'CACHE',root/'.cache'),patch.object(update,'OUT',out),patch.object(update,'specs',return_value=[job]),patch.object(update,'fetch',return_value=(values,{'dataset':'Test','status':'ok'})),patch('sys.argv',['update.py']),patch('builtins.print'):
                update.main()
            history=json.loads((out.parent/'updates.json').read_text());weekly=json.loads((out.parent/'weekly.json').read_text())
            self.assertEqual(len(history),90);self.assertEqual(history,weekly['runs'])
            self.assertEqual(history[0]['schemaVersion'],2)
            point=next(c for c in history[0]['changes'] if c['id']=='US.debt_P')['points'][0]
            self.assertEqual(point['period'],period);self.assertEqual(point['kind'],'historical-revision')

if __name__=='__main__':unittest.main()
