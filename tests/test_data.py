import copy
import importlib.util
import json
from pathlib import Path
import unittest

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

if __name__=='__main__':unittest.main()
