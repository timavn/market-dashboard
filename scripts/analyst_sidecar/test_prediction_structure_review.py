from copy import deepcopy
import unittest

from prediction_structure_review import _metric, spx_structure_interpretation, structure_blocks
from prediction_research_rollup import build_prediction_research_rollup
from review_runs_v2 import render_prediction_review
from test_daily_research_rollup import snapshot, evidence, CUTOFF


CHART = 'a' * 64


def structure():
    return snapshot('market-structure', schemaVersion='market-structure-v4', contentComplete=True,
        body='The 10-day realized volatility is back in line with history, hitting 11.08.',
        data={'signals': [{'label': label, 'value': value} for label, value in (
            ('SPX Gamma Exposure', 'Neutral'), ('Systematic Flow Risk', 'Neutral'),
            ('PV Band Risk/Reward', 'Neutral'), ('Strategic Allocation', 'Risk On'))],
            'charts': [{'id': CHART, 'sha256': CHART}],
            'chartMetrics': {'spxGammaVolatilityThrottle': {
                'chartId': CHART, 'chartDate': '2026-06-03', 'extractionBasis': 'labeled-chart-ocr',
                'parserVersion': 'market-structure-chart-metrics-v3', 'gammaThrottle': -.75,
                'tenDayRealizedVolatility': 11.8}}})


class StructureReviewTests(unittest.TestCase):
    def test_monitor_context_integrates_citations_without_bypassing_wrapper_safety(self):
        universe = {'data': {'markets': [{'marketId': 'sp500', 'snapshot': {'marketId': 'sp500', 'factors': {
            'usd': {'status': 'available', 'sourceStatus': 'current', 'source': 'Yahoo Finance daily bars',
                    'asOf': '2026-06-04T16:00:00Z', 'date': '2026-06-04', 'expiresAt': '2026-06-04T20:00:00Z',
                    'r15': -.4, 'r30': .05, 'r90': -.42}}}}]}}
        research = evidence({'market-structure': structure()})
        report = build_prediction_research_rollup(research, as_of=CUTOFF, prediction_evidence=universe)
        self.assertIn('30D +0.050', str(report['markets']['sp500']))
        self.assertTrue(any(c['productLabel'] == 'Dollar context' for c in report['citations']))
        for patch in ({'mock': True}, {'isMock': True}, {'fromCache': True}, {'connected': False}, {'stale': True}):
            with self.subTest(patch=patch):
                bad = build_prediction_research_rollup(research, as_of=CUTOFF, prediction_evidence={**universe, **patch})
                self.assertNotIn('30D +0.050', str(bad))

    def test_full_source_table_survives_asset_filter_and_has_dated_chart_readings(self):
        source = structure()
        original = deepcopy(source)
        report = build_prediction_research_rollup(evidence({'market-structure': source}), as_of=CUTOFF)
        section = report['markets']['sp500']['sections'][0]
        table = section['blocks'][0]
        self.assertEqual(table['columns'], ['Signal', 'Reading', 'As of'])
        self.assertEqual(len(table['rows'][:4]), 4)
        self.assertEqual(table['rows'][3]['cells'], ['Strategic Allocation', 'Risk On', 'Jun 4, 2026'])
        self.assertEqual(table['rows'][4]['cells'], ['Gamma Volatility Throttle', '-0.75', 'Jun 3, 2026'])
        self.assertEqual(table['rows'][6]['cells'][1], '—')
        text = str(section)
        self.assertIn('11.80%', text)
        self.assertIn('11.08%', text)
        self.assertIn('compression', text)
        self.assertIn('expansion', text)
        self.assertEqual(source, original)
        self.assertEqual(report['markets']['gold']['sections'], [])

    def test_bad_chart_evidence_cannot_publish_numeric_levels(self):
        for patch in ({'chartId': 'b' * 64}, {'chartDate': '2026-06-05'}, {'chartDate': '2026-05-01'},
                      {'parserVersion': 'unknown'}, {'extractionBasis': 'guess'}, {'mock': True},
                      {'fromCache': True}, {'stale': True}, {'refreshFailed': True}, {'source': 'synthetic'}):
            source = structure()
            source['data']['chartMetrics']['spxGammaVolatilityThrottle'].update(patch)
            with self.subTest(patch=patch):
                self.assertEqual(_metric(source, 'spxGammaVolatilityThrottle'), {})
        source = structure()
        source['data']['charts'][0]['sha256'] = 'b' * 64
        self.assertEqual(_metric(source, 'spxGammaVolatilityThrottle'), {})

    def test_numeric_bounds_never_become_invented_gamma_map(self):
        source = structure()
        metric = source['data']['chartMetrics']['spxGammaVolatilityThrottle']
        metric['gammaThrottle'] = True
        metric['tenDayRealizedVolatility'] = 1000
        self.assertEqual(_metric(source, 'spxGammaVolatilityThrottle'), {})
        blocks, _ = structure_blocks(source, {}, 'cite', as_of=CUTOFF, market_date='2026-06-04')
        self.assertEqual(blocks[0]['rows'][6]['cells'][1], '—')

    def test_valid_price_level_map_retains_units_and_does_not_derive_from_throttle(self):
        source = structure()
        source['data']['chartMetrics']['spxProbableVolatilityGamma'] = {
            **source['data']['chartMetrics']['spxGammaVolatilityThrottle'],
            'zeroGamma': 7510, 'lowerPvBand': 7440, 'upperPvBand': 7600, 'strikesInPlay': [7500, 7550]}
        blocks, _ = structure_blocks(source, {}, 'cite', as_of=CUTOFF, market_date='2026-06-04')
        self.assertIn('7,510', str(blocks))
        self.assertIn('7,500, 7,550', str(blocks))
        source['data']['chartMetrics']['spxProbableVolatilityGamma']['lowerPvBand'] = 8000
        self.assertNotIn('lowerPvBand', _metric(source, 'spxProbableVolatilityGamma'))

    def test_report_uses_full_compact_table_and_combines_independent_trend_with_structure(self):
        rollup = build_prediction_research_rollup(evidence({'market-structure': structure()}), as_of=CUTOFF)
        view = {'version': 1, 'trade': None, 'trend': {'direction': 'BULLISH', 'instrument': 'SPX'},
                'riskRange': {'low': 7513, 'high': 7727, 'instrument': 'SPX', 'publishedAt': '2026-06-04', 'rewardRisk': None},
                'underlying': {'label': 'ESZ26', 'value': 7725, 'state': 'LAST CLOSE'}}
        market = {'marketId': 'sp500', 'asset': 'S&P 500', 'venue': 'ForecastEx', 'managerView': view, 'research': rollup['markets']['sp500']}
        text = render_prediction_review([{'id': 'monitored-markets', 'markets': [market]}], 'partial', rollup['citations'])
        self.assertIn('| Signal | Reading | As of |', text)
        self.assertIn('| Systematic Flow Risk | Neutral |', text)
        self.assertIn('S&P 500 Trend is Bullish', text)
        self.assertIn('strategic allocation is Risk On', text)
        self.assertIn('comparable reward/risk —', text)
        self.assertNotIn('Trade is Bullish', text)
        self.assertNotIn('0.01:1', text)
        self.assertLess(text.index('| Signal |'), text.index('S&P 500 context:'))

    def test_comparable_reward_risk_is_not_recomputed(self):
        view = {'riskRange': {'instrument': 'SPX', 'low': 7500, 'high': 7800, 'publishedAt': '2026-06-04',
                             'rewardRisk': {'ratio': 2, 'referenceValue': 7600, 'direction': 'BULLISH',
                                            'basisLabel': 'SPX', 'reward': 200, 'risk': 100}}}
        self.assertIn('2:1: 200 points of reward versus 100 points of risk', ' '.join(spx_structure_interpretation(view, {})))
