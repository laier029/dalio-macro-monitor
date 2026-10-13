import copy
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile

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

if __name__=='__main__':unittest.main()
