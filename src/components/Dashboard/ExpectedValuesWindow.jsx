import React, { useMemo, useState } from 'react';
import { Title, Text, Card } from '@tremor/react';
import expectedValuesData from '../../constants/expectedValuesData';
import quadProbabilityScenarioData from '../../constants/quadProbabilityScenarios';
import PopoverSelect from '../common/PopoverSelect';
import PortfolioQuadExposureCard from './PortfolioQuadExposureCard';
import './ExpectedValuesWindow.css';

const {
  computeQuadProbabilityOverlay,
  normalizeQuadProbabilities,
} = require('../../utils/quadProbabilityOverlay');

const { quadData, quarterlyExpectedValues } = expectedValuesData;
const {
  DEFAULT_QUAD_PROBABILITY_PERIOD_ID,
  DEFAULT_QUAD_PROBABILITY_SCENARIO_ID,
  QUAD_PROBABILITY_SCENARIOS,
} = quadProbabilityScenarioData;

const QUAD_INPUTS = [
  { key: 'q1', label: 'Q1' },
  { key: 'q2', label: 'Q2' },
  { key: 'q3', label: 'Q3' },
  { key: 'q4', label: 'Q4' },
];

const CLASSIFICATION_FILTERS = [
  'All',
  'All-weather',
  'Robust overlap',
  'Probability aligned',
  'Fragile',
  'Avoid',
];

const CLASSIFICATION_CLASSES = {
  'All-weather': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  'Robust overlap': 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  'Probability aligned': 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200',
  Fragile: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  Avoid: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

const ALL_EV_GROUPS = [
  'EV by Quadrant',
  'Shallow GDP Delta',
  'Deep GDP Delta',
  'Fed Easing',
  'Fed On Hold',
  'Fed Tightening',
  'Quad 1 Prior',
  'Quad 2 Prior',
  'Quad 3 Prior',
  'Quad 4 Prior',
  'China Quad',
];

const parseAllEvMatrixRow = (line) => (
  line.slice(line.indexOf('|') + 1)
    .split(',')
    .map((value) => {
      const trimmed = value.trim();
      if (trimmed === '####') return trimmed;
      const number = Number(trimmed);
      return Number.isFinite(number) ? number : null;
    })
);

const ALL_EV_MATRIX_VALUES = [
  'SPY|6.2,4.6,-0.1,-0.7,5.7,4.9,1.5,2.9,9.0,2.6,-4.5,-4.8,8.5,7.7,0.6,-5.5,2.6,1.5,-2.8,-0.6,6.5,3.8,3.5,2.2,8.4,6.4,0.4,4.0,2.7,7.1,2.2,-8.5,4.8,-0.6,-3.2,-2.5,7.2,4.1,5.1,-0.3,3.4,4.2,-0.4,2.0',
  'XLC|7.4,1.4,-1.0,-0.0,8.8,3.4,0.7,6.0,7.7,-1.6,-7.3,-7.2,10.2,4.9,1.2,-3.5,1.4,-2.6,-5.0,3.2,9.3,0.9,3.2,1.1,10.5,4.4,-1.8,6.2,3.7,4.9,1.5,-4.8,4.9,-6.0,-3.2,-0.6,8.5,-0.6,5.4,-1.9,3.7,2.8,-0.2,1.7',
  'XLY|7.5,4.6,0.0,-0.7,5.9,4.8,1.3,4.0,13.5,2.7,-4.5,-6.4,10.6,7.4,-1.0,-3.1,3.7,0.7,-1.6,-0.7,7.0,4.9,4.3,0.7,11.3,7.0,1.0,3.6,1.5,7.8,0.1,-9.3,4.0,-2.4,-3.1,-2.7,9.8,4.1,9.0,0.8,4.1,4.1,0.1,2.8',
  'XLP|4.5,2.1,0.1,1.8,2.7,-1.7,0.5,3.0,6.7,3.9,-0.2,1.6,6.4,4.8,0.8,-2.9,4.2,-0.8,0.2,8.6,2.5,1.6,-0.8,2.6,5.6,2.5,0.4,5.4,3.6,2.5,-1.5,-6.4,3.5,1.9,0.3,2.0,4.9,0.5,2.6,1.4,1.5,3.2,1.2,2.0',
  'XLE|5.6,4.6,2.8,-1.6,2.0,2.0,5.7,4.5,5.8,2.7,-2.5,-8.2,5.4,11.9,8.2,-11.3,7.0,2.6,-4.3,1.2,4.7,2.8,7.6,3.4,3.4,1.5,3.3,-0.7,1.0,9.8,8.9,-24.5,7.0,2.8,-2.3,0.8,8.8,-0.3,6.8,0.5,6.7,5.2,-2.9,1.9',
  'XLF|5.1,4.8,-0.8,-0.2,5.0,2.4,-1.8,1.6,8.7,2.6,-2.2,-3.2,7.0,8.4,-1.9,-8.4,2.1,4.1,-1.6,1.4,5.2,0.8,2.2,4.4,9.9,3.9,0.5,5.6,1.5,12.0,4.9,-15.0,2.8,-4.4,-6.7,-1.3,4.8,6.3,5.2,1.0,2.0,4.6,-2.1,2.4',
  'XLV|4.2,3.9,-0.3,2.2,3.6,0.2,0.7,4.7,5.6,5.1,-2.0,-0.2,6.7,7.7,1.3,-2.1,2.5,-0.7,-1.1,7.3,2.3,3.6,-1.0,3.3,5.3,5.6,0.5,5.7,1.8,2.6,2.2,-0.5,7.0,4.4,-2.1,3.0,3.1,1.2,-1.2,0.0,1.8,3.6,-0.1,3.2',
  'XLI|6.2,5.1,-0.4,0.0,4.9,3.6,0.7,2.8,8.6,4.1,-4.3,-2.8,8.6,8.6,0.4,-5.6,3.1,2.6,-3.2,-0.7,5.9,3.2,3.3,3.6,7.5,6.6,0.4,4.5,3.7,8.2,1.2,-13.1,5.3,-0.2,-3.1,-1.5,7.1,3.9,3.4,1.7,2.9,5.6,-0.3,1.1',
  'XLK|8.8,7.7,0.7,-2.0,8.1,13.6,3.8,2.4,13.4,2.3,-6.3,-7.4,12.7,9.1,1.1,-5.5,1.5,3.9,-2.8,-8.6,10.4,9.5,6.2,2.2,12.2,10.9,-0.5,2.9,4.7,9.6,4.9,-5.3,4.5,0.7,-2.6,-8.0,10.8,9.5,8.1,2.1,4.7,5.3,0.8,3.7',
  'XLB|6.0,4.1,-0.7,0.7,2.9,3.8,3.6,-1.1,9.7,1.3,-7.1,-0.7,6.7,8.5,3.3,-6.5,5.9,1.7,-5.1,5.4,5.0,0.8,1.4,3.6,4.6,7.5,2.8,0.6,3.9,6.2,-0.7,-12.5,3.9,-3.0,-4.0,0.6,8.9,5.0,-0.7,3.6,5.9,4.6,-1.1,-0.1',
  'XLRE|5.7,2.9,0.5,0.8,6.4,1.0,1.1,5.1,7.1,6.2,-1.4,-5.6,8.0,7.8,1.0,-12.5,4.1,-2.2,-1.0,6.8,4.4,0.5,2.2,3.6,6.2,3.3,-0.2,9.6,2.0,4.5,1.0,-11.0,5.7,0.7,-0.1,-3.1,7.3,0.2,4.0,3.1,4.8,3.7,-0.7,2.2',
  'XLU|3.6,0.8,2.7,1.3,5.7,-0.4,3.0,5.0,1.2,0.3,2.6,-0.9,4.9,3.8,3.1,-5.8,3.6,-3.7,1.1,5.9,2.0,1.4,5.1,4.3,1.6,3.5,-0.1,10.6,2.4,-0.3,8.9,-7.5,9.2,-0.2,1.3,0.9,2.8,-1.2,4.6,-1.5,2.8,3.5,2.0,0.6',
  'IWF|7.1,5.9,-0.1,-1.7,6.5,7.9,1.8,3.5,10.8,3.3,-5.8,-6.7,9.8,8.0,0.7,-6.0,1.9,2.2,-3.4,-5.2,8.3,6.9,4.4,1.9,10.1,8.6,0.2,3.6,2.7,8.0,2.2,-6.5,4.3,0.4,-3.6,-5.1,8.7,4.6,6.8,-0.2,3.4,4.7,0.0,2.1',
  'IWD|5.4,3.4,0.0,0.2,4.8,1.9,1.2,2.7,7.8,1.9,-3.3,-3.3,7.3,7.5,0.8,-5.6,3.6,1.0,-2.5,3.1,4.6,0.4,3.3,2.9,6.8,4.5,0.5,4.6,2.3,6.8,2.9,-11.5,5.4,-2.6,-3.1,-0.3,6.1,3.7,4.1,0.9,3.6,4.0,-1.1,1.7',
  'RSP|7.4,5.5,0.0,-1.9,6.8,6.6,2.1,3.0,11.7,2.3,-6.1,-7.8,10.0,9.1,1.5,-7.7,2.8,2.3,-4.3,-4.6,8.3,4.1,5.4,2.5,10.2,7.6,0.8,4.0,2.2,9.7,3.7,-10.5,4.9,-2.6,-4.9,-5.1,9.4,5.4,7.7,-0.1,4.2,5.1,-1.2,1.8',
  'DEF|5.3,3.9,-0.1,0.3,4.6,3.5,0.9,3.1,7.2,3.0,-3.2,-2.3,7.5,6.4,0.1,-3.8,2.6,0.8,-1.7,2.1,4.9,3.8,2.4,2.4,7.0,5.5,0.0,4.0,2.8,5.1,1.4,-7.3,5.0,0.7,-1.9,-0.7,5.6,2.9,3.3,1.1,2.8,3.7,0.1,2.1',
  'SPHB|8.6,8.2,-1.0,-2.9,8.9,9.9,1.6,2.3,13.9,3.7,-7.6,-6.6,13.6,13.6,1.6,-8.5,2.3,3.6,-6.8,-9.0,7.8,5.8,5.8,2.4,10.6,8.0,-0.8,1.3,1.9,16.9,6.2,-14.7,6.8,-3.2,-8.1,-8.6,11.7,7.8,10.0,3.1,4.4,6.2,-1.6,2.3',
  'SPLV|3.9,2.3,0.8,2.2,3.8,-0.6,1.4,4.1,4.8,3.4,-0.5,0.2,5.0,5.3,0.5,-2.7,4.3,-0.3,0.1,7.2,2.0,1.3,2.5,3.7,4.1,3.8,-0.5,6.2,2.8,2.5,2.1,-10.6,5.2,0.8,0.8,2.1,3.6,1.3,2.5,2.9,3.1,3.3,0.6,1.7',
  'MTUM|7.4,5.1,0.9,-1.5,7.6,8.1,3.0,4.5,9.2,3.2,-4.5,-7.4,8.0,6.2,0.9,-7.2,4.0,1.3,-2.0,-5.2,9.4,7.4,5.7,3.3,10.9,6.5,1.8,6.0,3.1,8.5,2.2,-7.5,5.8,-0.7,-2.7,-4.4,7.9,3.4,8.4,-1.3,3.8,4.5,0.2,2.7',
  'QUAL|6.6,4.7,0.1,0.9,5.9,2.6,2.0,3.2,9.0,4.4,-3.8,-2.1,9.0,7.5,1.2,-3.8,3.5,1.7,-2.3,2.5,6.3,3.9,2.9,3.2,7.9,5.6,0.8,4.6,3.4,6.5,1.7,-7.4,6.6,1.8,-2.5,-0.6,7.3,2.7,4.6,2.1,3.4,4.8,0.6,2.3',
  'SDY|5.4,3.2,-0.2,2.2,3.7,0.3,0.6,3.1,8.5,2.8,-2.0,0.5,7.7,7.4,0.0,-2.3,4.3,0.6,-1.0,6.6,3.4,0.3,1.1,3.6,6.5,4.9,-0.2,5.4,2.7,5.3,0.3,-10.8,5.4,-1.2,-0.8,2.0,6.0,1.8,1.2,3.4,3.4,3.8,0.4,2.3',
  'OEF|6.4,4.9,0.0,-1.0,5.8,6.1,1.4,2.8,9.0,2.5,-4.5,-4.7,8.9,7.4,0.2,-5.3,1.9,1.8,-2.5,-0.4,7.2,4.7,3.9,1.5,8.7,6.7,0.4,3.6,3.0,7.2,2.2,-7.0,4.4,0.0,-3.0,-2.7,7.5,4.0,4.9,-0.4,3.2,4.1,-0.1,2.3',
  'QQQ|7.6,7.7,0.6,-2.1,8.0,14.8,3.5,2.7,10.8,2.3,-7.1,-7.1,11.8,9.2,1.0,-5.6,-0.1,3.0,-4.5,-8.8,9.2,10.5,7.5,2.0,9.3,9.8,-2.2,2.4,4.8,12.0,6.2,-3.9,5.4,-0.4,-2.8,-6.9,9.1,7.5,9.0,0.5,4.6,5.2,0.9,1.9',
  'MDY|6.5,5.1,0.6,-0.5,5.0,4.1,1.8,3.2,11.4,3.1,-4.0,-4.8,8.5,9.2,2.0,-5.4,4.8,2.4,-3.6,-1.5,5.5,2.6,5.8,2.8,9.1,5.8,0.2,4.5,1.2,10.1,4.6,-14.0,5.2,-1.7,-2.8,-3.3,8.1,3.6,5.8,2.4,4.8,5.6,-1.1,1.3',
  'IWM|6.0,5.7,-0.5,-1.1,6.2,6.9,1.6,3.4,9.8,2.3,-6.0,-6.1,7.2,9.5,0.5,-4.6,4.6,2.7,-4.8,-1.5,5.7,4.0,5.6,1.2,7.9,8.0,-0.5,5.0,0.1,11.0,1.8,-14.2,4.7,-3.8,-3.5,-4.3,8.3,5.6,6.4,1.6,5.3,4.3,-1.3,1.1',
  'AGG|1.3,0.6,0.4,2.0,1.6,1.2,0.6,0.9,1.6,1.0,0.4,2.5,1.6,0.4,0.3,2.4,1.4,0.4,0.9,3.1,0.7,0.9,-0.5,1.4,0.8,0.6,0.6,2.3,1.5,-0.4,0.2,2.1,1.4,1.4,0.6,1.8,1.4,1.8,-0.9,1.8,1.2,0.9,1.3,0.8',
  'BKLN|2.2,1.9,0.4,0.8,1.9,1.5,1.3,1.9,3.4,2.2,-1.1,-2.1,2.6,2.3,0.9,-3.9,1.1,1.4,-0.5,1.5,2.7,1.8,1.5,3.4,2.4,2.2,1.2,1.1,0.3,2.3,0.9,-5.9,1.8,0.7,-0.9,-1.3,3.3,2.4,1.9,4.2,2.3,1.6,0.0,1.2',
  'BIZD|5.3,5.8,-1.1,0.0,4.2,1.4,-3.5,5.1,10.6,11.5,-3.4,-4.2,7.3,10.6,-1.8,-21.5,-1.0,1.7,-2.5,5.4,6.4,0.1,3.5,5.9,7.7,2.1,-0.5,3.5,-2.2,10.4,4.4,-21.4,3.5,2.0,-5.2,-3.8,8.3,6.2,5.4,10.6,6.2,4.5,-5.5,3.7',
  'PFF|2.0,2.9,-0.3,-0.1,2.7,2.2,0.7,0.4,2.9,4.6,-2.0,-6.9,2.7,3.3,0.6,-7.4,0.8,2.0,-1.8,2.2,2.1,3.4,0.8,1.7,1.5,3.5,-0.4,3.8,0.6,4.0,2.1,-9.5,2.1,0.0,-2.0,-0.6,3.2,1.3,2.6,0.7,4.9,1.2,-0.9,0.0',
  'LQD|1.9,0.9,0.0,2.2,2.0,1.6,0.5,1.7,2.8,1.3,-0.5,2.5,2.5,1.1,0.3,1.7,1.5,0.6,0.3,3.5,1.5,1.1,-1.0,2.1,1.5,1.2,0.4,2.6,1.6,0.0,0.1,-1.1,1.9,1.4,-0.2,2.0,2.3,2.8,-0.9,2.8,1.7,1.2,1.1,0.9',
  'HYG|3.1,2.1,0.0,1.4,2.9,2.1,1.4,3.2,4.9,2.5,-2.2,-2.2,3.6,3.2,1.3,-3.1,2.4,1.4,-1.3,1.5,3.2,1.4,0.5,4.1,3.1,3.3,0.6,2.1,1.5,2.2,0.7,-5.7,2.6,0.0,-1.4,-0.6,4.3,4.0,1.9,4.6,2.5,2.5,-0.4,1.4',
  'CWB|5.0,5.8,-0.7,0.3,5.3,6.1,2.0,2.5,8.5,5.7,-5.3,-4.6,6.8,6.6,0.7,-8.0,3.1,3.6,-4.6,1.0,4.4,7.3,2.7,2.6,4.9,7.5,1.9,1.3,1.2,5.6,0.5,-6.7,4.4,2.7,-5.0,-1.6,7.6,4.8,4.6,5.0,6.8,3.4,-0.2,1.0',
  'EMB|2.7,1.8,0.7,2.0,1.0,4.0,2.3,2.5,5.6,1.6,-1.8,0.8,2.1,2.1,1.4,-2.1,3.0,0.5,-0.2,3.4,3.1,2.9,1.3,4.1,3.8,2.3,-0.2,2.6,1.6,2.0,2.3,-3.5,-0.9,0.5,0.2,1.5,4.2,3.4,2.6,3.4,1.5,2.8,1.0,1.2',
  'EMLC|1.5,2.1,-0.9,0.3,1.9,2.4,1.0,-0.4,2.3,2.4,-3.5,1.5,0.7,2.8,1.4,-3.9,-1.3,0.1,-1.8,0.5,4.0,2.1,-6.0,1.9,2.5,2.4,-1.3,0.2,-2.1,1.2,-1.1,-2.9,2.3,2.9,-1.6,-1.4,2.8,3.3,-3.8,3.3,2.0,2.1,-0.5,-0.4',
  'SHY|0.7,0.4,0.5,1.2,0.9,0.7,0.5,0.3,0.5,0.6,0.7,1.6,0.8,0.1,0.3,1.9,0.6,0.4,0.8,1.4,0.6,0.9,0.2,0.7,0.6,0.4,0.7,0.9,0.8,0.0,0.3,1.9,0.7,1.0,0.5,1.1,0.7,0.7,0.0,1.2,0.8,0.6,0.9,0.6',
  'IEF|1.2,0.2,0.6,2.4,1.6,0.8,0.3,1.3,1.0,1.1,1.5,3.5,1.5,-0.2,-0.3,3.8,1.6,0.3,1.6,4.0,0.4,0.8,-1.0,1.0,0.5,-0.1,0.4,3.0,1.8,-1.2,0.1,4.9,2.1,2.0,1.5,2.9,0.9,1.6,-1.7,1.0,1.0,0.7,2.2,0.7',
  'TLT|1.3,-0.2,0.4,3.1,1.7,1.0,0.2,2.0,1.4,0.5,1.6,5.0,2.1,-1.1,-0.1,5.0,2.0,0.0,1.8,6.1,-0.3,-0.7,-1.3,1.1,0.1,-0.9,0.1,4.9,2.8,-2.3,0.2,7.9,2.5,2.6,1.7,3.7,0.8,2.1,-2.9,0.6,0.8,0.5,2.9,0.9',
  'EDV|1.5,-0.7,0.5,3.9,1.6,1.0,-0.2,3.2,1.6,0.1,2.9,7.4,2.5,-1.8,-0.3,8.4,3.0,-0.2,2.5,8.6,-1.2,0.3,-1.7,-0.3,-0.7,-2.3,-0.7,6.9,4.6,-3.3,0.4,11.1,3.3,3.4,2.9,6.0,0.4,3.1,-3.8,-1.4,0.8,0.0,4.0,1.3',
  'STIP|0.7,1.0,0.8,0.6,0.7,1.0,1.2,0.2,1.2,1.4,0.4,-0.7,0.8,1.2,1.4,-1.8,0.6,0.4,0.4,0.7,0.7,1.3,0.5,1.2,0.8,1.2,1.0,0.6,0.4,0.7,0.6,-0.1,0.4,1.1,0.9,-1.1,1.1,1.0,0.6,1.8,1.3,1.0,0.8,0.1',
  'TIP|1.0,1.5,0.9,1.3,0.6,1.8,1.7,0.9,2.2,2.4,0.4,-0.2,0.9,1.6,1.8,-0.9,1.5,1.0,0.8,2.7,0.6,2.0,-0.4,1.7,0.2,1.6,1.3,2.0,0.8,0.2,0.3,0.9,0.9,3.2,1.2,0.4,1.6,2.0,-0.5,2.4,2.0,1.3,1.3,0.1',
  'MBB|1.0,0.6,0.6,1.8,1.3,1.2,0.8,0.2,1.2,1.0,0.6,2.4,0.9,0.5,2.3,1.4,1.4,0.3,1.1,2.4,0.6,1.0,-0.2,1.3,0.6,0.9,1.0,1.9,1.3,-0.2,0.3,2.3,0.8,1.2,0.7,1.5,1.1,1.3,-0.7,1.9,1.2,0.9,1.0,0.9',
  'MUB|1.4,0.6,0.4,1.7,1.5,0.8,0.8,1.1,2.1,1.3,0.1,1.9,1.8,0.8,-0.1,1.0,1.2,0.3,1.0,3.1,1.1,0.8,0.0,1.6,1.0,0.7,0.4,1.7,1.4,-0.1,0.2,0.5,1.7,1.4,0.5,1.3,1.6,0.9,0.0,2.2,1.5,0.8,0.9,1.0',
  'BAB|2.1,0.5,0.6,1.7,1.3,2.4,1.2,1.1,3.9,1.1,1.1,0.4,2.1,0.5,0.6,0.2,2.2,-0.5,1.3,4.7,1.8,1.9,-1.6,1.4,1.0,0.0,0.3,3.1,2.5,0.1,-1.6,1.3,1.6,1.2,2.0,0.3,2.7,2.5,-3.6,2.4,1.9,0.8,1.6,0.9',
  'DBC|2.1,5.2,2.8,-3.5,0.4,3.0,4.5,0.0,1.1,7.2,-0.5,-8.9,-0.9,6.4,9.1,-13.6,4.3,3.6,-3.2,-0.6,3.8,5.3,4.5,1.9,0.9,5.6,4.1,-3.8,-0.5,6.1,7.8,-16.9,1.8,6.0,-1.9,-2.3,4.3,-2.0,4.7,-1.5,3.8,4.0,0.0,-1.5',
  'CRBRAW|1.1,3.7,0.0,-1.0,1.1,0.5,0.5,-2.9,1.1,5.5,-1.6,-1.7,-1.1,5.9,2.5,-6.2,2.0,2.9,-1.6,-1.1,3.0,1.6,-0.8,2.2,0.7,5.1,1.6,-2.4,0.5,5.6,1.5,-2.5,-0.6,1.6,-2.3,-2.1,2.4,-2.9,-0.8,1.1,1.6,3.0,-1.1,-1.1',
  'DBA|0.0,3.1,2.2,-1.3,1.5,-5.5,1.3,-0.1,-3.1,8.7,1.0,-3.3,-3.9,7.1,6.5,-4.7,3.1,0.7,-0.8,1.9,2.2,0.2,1.7,-0.2,1.9,2.7,3.6,-0.3,-3.1,4.4,3.0,-7.2,-0.6,4.0,0.9,-3.5,0.6,-3.7,0.2,1.6,1.1,1.7,2.4,-1.1',
  'BNO|1.8,11.1,6.5,-9.1,3.4,4.9,12.7,1.8,0.8,18.5,-1.5,-18.4,-3.5,9.3,12.5,-30.7,2.8,7.8,-1.2,-3.7,14.3,17.7,12.3,3.8,-0.2,9.2,11.4,-18.9,-3.6,11.1,6.0,-66.0,6.1,16.8,1.9,-7.9,3.7,-0.1,9.4,-0.6,9.0,5.8,-2.4,-0.3',
  'DBP|-0.9,5.2,0.0,0.6,2.3,7.0,1.2,0.2,-6.7,6.8,-3.4,2.5,-8.1,6.0,4.0,-5.6,4.5,1.6,-3.5,1.4,9.0,8.1,0.7,4.6,3.7,8.5,1.6,-3.9,1.6,2.4,2.2,0.3,-0.7,6.0,-3.2,3.0,-5.4,4.2,3.0,0.1,-4.6,5.0,2.1,-1.1',
  'SLV|5.9,3.9,-1.3,4.9,7.1,6.0,-0.4,-2.0,8.2,5.0,-7.3,0.6,-0.4,5.0,6.1,2.5,8.9,-2.0,-5.2,1.0,11.5,8.3,-4.5,7.6,3.5,12.3,-0.5,-2.3,2.5,-0.8,-0.1,16.0,-3.9,0.9,-2.8,6.0,13.7,1.9,-0.8,5.4,7.1,3.2,3.5,0.1',
  'GBTC|75.1,53.2,157.2,5.4,124.5,60.7,654.4,24.5,118.4,29.5,-20.1,-22.8,136.6,42.3,####,-17.2,29.2,87.9,-5.4,48.2,24.5,37.7,16.5,3.1,14.9,21.6,94.6,22.0,140.1,79.2,5.8,-16.5,228.5,22.8,295.2,15.6,24.5,84.7,46.9,-15.8,41.0,239.9,0.2,2.4',
  'USO|7.0,9.6,4.7,-6.8,0.0,6.1,9.3,2.8,8.6,11.2,-2.2,-19.8,7.2,12.0,11.1,-25.0,9.6,8.2,-1.8,-4.9,4.5,7.9,7.4,3.8,-0.7,5.5,10.4,-11.5,-1.3,14.1,6.6,-37.2,10.0,12.1,-1.1,-6.4,14.8,-1.5,3.3,-2.2,11.0,6.5,-2.0,-0.4',
  'UNG|1.3,3.8,9.5,-3.0,1.4,-3.3,11.0,15.2,1.9,15.8,9.4,-4.9,-2.2,-1.4,20.1,-21.0,6.6,4.2,-4.4,40.7,0.9,10.1,19.4,-5.5,-8.0,5.3,4.1,-4.7,10.2,2.0,23.2,-6.7,4.4,7.9,-0.6,15.3,1.4,-7.0,38.1,-19.6,2.6,4.5,4.3,1.2',
  'IRONORE|-2.4,11.3,-4.8,-0.3,-7.4,18.7,-2.9,4.8,10.3,9.5,-5.8,5.8,-0.4,2.0,-8.1,-4.9,-11.2,15.6,-2.7,1.0,1.3,20.9,-6.1,1.3,3.2,8.2,-11.0,-14.3,-14.4,14.8,-4.0,-0.4,-38.4,-7.3,-3.3,1.3,4.8,25.8,-1.6,11.6,3.6,6.0,-1.5,-2.0',
  'CPER|4.7,6.2,-0.4,1.0,3.7,2.0,3.9,-1.1,8.2,6.7,-4.7,-8.5,3.0,10.4,2.0,-10.5,4.3,5.9,-5.7,-4.2,7.2,1.0,5.6,9.7,5.2,9.0,1.1,-0.9,1.3,8.1,2.4,-1.7,2.1,3.5,-3.8,-1.4,7.4,-3.6,1.2,5.2,6.0,6.4,-2.0,-0.7',
  'UUP|-0.5,-0.3,0.3,0.9,-2.1,-0.7,-1.4,-3.3,0.0,0.5,2.1,-1.3,-0.5,-0.1,-1.1,2.2,0.8,0.0,1.0,0.7,-1.6,-0.8,1.0,0.1,-1.5,-1.8,-1.2,2.5,0.9,1.2,1.8,1.7,-0.6,-0.4,0.8,0.6,-0.4,-0.9,0.2,0.0,-0.7,-0.6,0.4,1.9',
  'GLD|2.8,3.2,1.6,3.5,1.7,6.5,2.2,-1.3,5.2,3.5,0.4,4.0,-0.8,2.5,4.7,2.3,5.4,0.5,0.4,-0.1,4.9,6.8,-0.6,5.3,-0.7,8.1,2.1,3.4,3.3,-2.1,1.1,7.9,-1.9,4.3,0.8,3.0,7.6,4.3,4.1,2.9,3.2,2.9,4.2,0.8',
  'CEW|0.2,0.0,-1.2,-1.8,1.3,0.4,0.2,-2.1,0.4,-0.5,-3.1,-2.1,-0.7,0.6,0.8,-5.5,0.1,-0.5,-2.4,-1.4,1.1,-0.2,-2.5,0.3,0.5,0.8,-0.9,-2.7,-1.7,0.6,-0.9,-6.1,0.0,-1.8,-2.0,-1.7,1.0,0.2,0.2,-0.6,0.0,0.0,-1.2,-1.8',
].map(parseAllEvMatrixRow);

const selectableScenarios = QUAD_PROBABILITY_SCENARIOS.filter((scenario) => (
  Array.isArray(scenario.periods) && scenario.periods.length > 0
));

const findScenario = (scenarioId) => (
  selectableScenarios.find((scenario) => scenario.id === scenarioId) ||
  selectableScenarios[0] ||
  QUAD_PROBABILITY_SCENARIOS[0]
);

const findPeriod = (scenario, periodId) => (
  scenario?.periods?.find((period) => period.id === periodId) ||
  scenario?.periods?.[0] ||
  { id: '', label: 'No period', probabilities: { q1: 25, q2: 25, q3: 25, q4: 25 } }
);

const cloneProbabilities = (probabilities = {}) => QUAD_INPUTS.reduce((acc, { key }) => {
  acc[key] = probabilities[key] ?? 0;
  return acc;
}, {});

const formatSignedPercent = (value, decimals = 1) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toFixed(decimals)}%`;
};

const formatScore = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  const sign = number > 0 ? '+' : '';
  return `${sign}${number.toFixed(2)}`;
};

const formatProbabilityMass = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return `${(number * 100).toFixed(0)}%`;
};

const valueTone = (value) => {
  const number = Number(value);
  if (number > 0) return 'text-emerald-600 dark:text-emerald-300';
  if (number < 0) return 'text-red-600 dark:text-red-300';
  return 'text-gray-500 dark:text-gray-400';
};

const allEvCellTone = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'bg-gray-50 text-gray-400 dark:bg-gray-900/40 dark:text-gray-500';
  if (number > 0) return 'bg-emerald-100 text-gray-950 dark:bg-emerald-900/40 dark:text-emerald-100';
  if (number < 0) return 'bg-red-100 text-gray-950 dark:bg-red-900/40 dark:text-red-100';
  return 'bg-white text-gray-700 dark:bg-gray-900 dark:text-gray-300';
};

const formatAllEvCellValue = (value) => {
  if (value === '####') return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${number.toFixed(1)}%`;
};

const getAllEvCellValue = (rowIndex, groupIndex, quadIndex) => (
  ALL_EV_MATRIX_VALUES[rowIndex]?.[(groupIndex * QUAD_INPUTS.length) + quadIndex] ?? null
);

const transcribedQuarterlyExpectedValues = quarterlyExpectedValues.map((item, rowIndex) => ({
  ...item,
  ...QUAD_INPUTS.reduce((acc, { key }, quadIndex) => {
    const value = getAllEvCellValue(rowIndex, 0, quadIndex);
    acc[key] = Number.isFinite(Number(value)) ? Number(value) : item[key];
    return acc;
  }, {}),
}));

const QUAD_COLORS = {
  1: { bg: '#059669', text: '#ffffff' },
  2: { bg: '#7CB342', text: '#ffffff' },
  3: { bg: '#FFC107', text: '#111827' },
  4: { bg: '#dc2626', text: '#ffffff' },
};

const MONTHLY_QUAD_REFERENCE = [
  { period: 'Sep-25', q1: 6, q2: 8, q3: 48, q4: 38, quad: 3 },
  { period: 'Oct-25', q1: 3, q2: 21, q3: 61, q4: 15, quad: 2 },
  { period: 'Nov-25', q1: 3, q2: 27, q3: 63, q4: 7, quad: 3 },
  { period: 'Dec-25', q1: 8, q2: 3, q3: 23, q4: 66, quad: 4 },
  { period: 'Jan-26', q1: 75, q2: 2, q3: 15, q4: 8, quad: 1 },
  { period: 'Feb-26', q1: 50, q2: 19, q3: 8, q4: 23, quad: 1 },
  { period: 'Mar-26', q1: 7, q2: 9, q3: 46, q4: 38, quad: 3 },
  { period: 'Apr-26', q1: 65, q2: 3, q3: 7, q4: 25, quad: 1 },
  { period: 'May-26', q1: 34, q2: 42, q3: 13, q4: 11, quad: 2 },
  { period: 'Jun-26', q1: 29, q2: 24, q3: 21, q4: 26, quad: 1 },
  { period: 'Jul-26', q1: 15, q2: 18, q3: 37, q4: 30, quad: 3 },
  { period: 'Aug-26', q1: 25, q2: 30, q3: 25, q4: 20, quad: 2 },
];

const US_QUARTERLY_PERIODS = [
  '4Q22',
  '1Q23',
  '2Q23',
  '3Q23',
  '4Q23',
  '1Q24',
  '2Q24',
  '3Q24',
  '4Q24',
  '1Q25',
  '2Q25',
  '3Q25',
  '4Q25',
  '1Q26',
  '2Q26E',
  '3Q26E',
  '4Q26E',
  '1Q27E',
];

const US_QUARTERLY_ESTIMATE_PERIODS = ['2Q26E', '3Q26E', '4Q26E', '1Q27E'];

const US_QUARTERLY_REFERENCE = [
  {
    label: 'Growth',
    rows: [
      { label: 'Base Effects', values: ['2.42%', '2.92%', '7.42%', '3.75%', '3.54%', '3.17%', '2.62%', '2.79%', '2.35%', '2.59%', '2.96%', '3.01%', '2.9%', '2.44%', '2.6%', '2.56%', '2.19%', '2.29%'] },
      { label: 'Real GDP YoY', values: ['1.32%', '2.31%', '2.79%', '3.23%', '3.39%', '2.86%', '3.13%', '2.79%', '2.4%', '2.02%', '2.08%', '2.34%', '1.99%', '2.57%', '2.51%', '1.96%', '2.43%', '2.34%'] },
      { label: 'GIP Model Quad', type: 'quad', values: [4, 1, 1, 1, 1, 4, 1, 4, 3, 4, 1, 2, 4, 1, 3, 3, 2, 4] },
    ],
    probabilityRows: [
      { label: 'Unconditional Probability Of Forecasted Delta', values: ['77.5%', '80.0%', '80.0%', '80.0%'] },
      { label: 'Conditional Probability Of Forecasted Delta', values: ['52.3%', '73.0%', '69.7%', '53.7%'] },
      { label: 'Conditional Probability Of Quad 1', quad: 1, values: ['1.2%', '11.0%', '14.8%', '32.1%'] },
      { label: 'Conditional Probability Of Quad 2', quad: 2, values: ['46.5%', '16.0%', '54.9%', '14.2%'] },
      { label: 'Conditional Probability Of Quad 3', quad: 3, values: ['51.0%', '43.4%', '23.9%', '16.4%'] },
      { label: 'Conditional Probability Of Quad 4', quad: 4, values: ['1.3%', '29.6%', '6.4%', '37.3%'] },
    ],
  },
  {
    label: 'Inflation',
    rows: [
      { label: 'Base Effects', values: ['3.96%', '4.93%', '6.74%', '6.83%', '6.9%', '6.89%', '6.31%', '5.92%', '5.17%', '4.53%', '3.59%', '3.07%', '2.99%', '2.99%', '2.82%', '2.75%', '2.73%', '2.71%'] },
      { label: 'Headline CPI YoY', values: ['7.1%', '5.81%', '3.98%', '3.51%', '3.24%', '3.24%', '3.2%', '2.62%', '2.75%', '2.74%', '2.45%', '2.88%', '2.71%', '2.69%', '4.04%', '4.15%', '4.49%', '4.26%'] },
      { label: 'GIP Model Quad', type: 'quad', values: [4, 1, 1, 1, 1, 4, 1, 4, 3, 4, 1, 2, 4, 1, 3, 3, 2, 4] },
    ],
    probabilityRows: [
      { label: 'Unconditional Probability Of Forecasted Delta', values: ['60.0%', '67.5%', '67.5%', '67.5%'] },
      { label: 'Conditional Probability Of Forecasted Delta', values: ['97.5%', '59.4%', '78.8%', '69.4%'] },
      { label: 'Conditional Probability Of Quad 1', quad: 1, values: ['1.2%', '11.0%', '14.8%', '32.1%'] },
      { label: 'Conditional Probability Of Quad 2', quad: 2, values: ['46.5%', '16.0%', '54.9%', '14.2%'] },
      { label: 'Conditional Probability Of Quad 3', quad: 3, values: ['51.0%', '43.4%', '23.9%', '16.4%'] },
      { label: 'Conditional Probability Of Quad 4', quad: 4, values: ['1.3%', '29.6%', '6.4%', '37.3%'] },
    ],
  },
];

const GLOBAL_FORECAST_PERIODS = [
  '2Q24',
  '3Q24',
  '4Q24',
  '1Q25',
  '2Q25',
  '3Q25',
  '4Q25',
  '1Q26',
  '2Q26E',
  '3Q26E',
  '4Q26E',
  '1Q27E',
];

const GLOBAL_QUAD_REFERENCE = [
  { country: 'Argentina', values: [2, 4, 1, 1, 1, 4, 4, 2, 2, 1, 4, 4] },
  { country: 'Australia', values: [4, 4, 2, 1, 2, 2, 2, 2, 3, 2, 4, 4] },
  { country: 'Austria', values: [1, 1, 1, 2, 1, 2, 3, 4, 2, 3, 3, 2] },
  { country: 'Belgium', values: [3, 4, 4, 1, 1, 4, 4, 4, 3, 2, 2, 2] },
  { country: 'Brazil', values: [1, 2, 3, 3, 3, 4, 1, 4, 2, 4, 2, 2] },
  { country: 'Canada', values: [1, 1, 1, 3, 4, 3, 3, 4, 2, 3, 1, 1] },
  { country: 'Chile', values: [3, 2, 2, 3, 1, 4, 4, 4, 2, 1, 3, 2] },
  { country: 'China', values: [3, 3, 1, 1, 3, 4, 3, 2, 3, 1, 1, 3] },
  { country: 'Colombia', values: [1, 1, 1, 4, 4, 2, 3, 2, 2, 3, 2, 4] },
  { country: 'Czech Republic', values: [2, 1, 3, 1, 4, 2, 4, 4, 3, 3, 1, 3] },
  { country: 'Denmark', values: [2, 4, 3, 4, 3, 2, 4, 1, 3, 3, 1, 2] },
  { country: 'Emerging Markets', values: [3, 4, 1, 4, 4, 4, 3, 3, 3, 2, 3, 2] },
  { country: 'Eurozone', values: [1, 1, 2, 2, 4, 3, null, null, 3, 3, 4, 1] },
  { country: 'Finland', values: [4, 2, 2, 3, 3, 3, 1, 2, 3, 4, 4, 4] },
  { country: 'France', values: [4, 1, 4, 1, 1, 2, 2, 4, 3, 3, 2, 2] },
  { country: 'Germany', values: [1, 1, 3, 2, 4, 2, 2, 3, 3, 3, 1, 4] },
  { country: 'Greece', values: [1, 2, 4, 3, 3, 1, 1, 3, 3, 3, 3, 1] },
  { country: 'Hong Kong', values: [1, 3, 1, 2, 2, 1, 2, 2, 3, 1, 3, 4] },
  { country: 'India', values: [4, 4, 2, 4, 4, 1, 4, 3, 3, 3, 4, 1] },
  { country: 'Indonesia', values: [4, 4, 1, 4, 2, 3, 2, 2, 4, 2, 3, 4] },
  { country: 'Ireland', values: [1, 1, 1, 2, 3, 3, 3, 3, 2, 3, 1, 4] },
  { country: 'Israel', values: [3, 2, 1, 3, 4, 1, 1, 4, 2, 4, 3, 2] },
  { country: 'Italy', values: [1, 3, 3, 2, 4, 1, 1, 3, 3, 4, 2, 4] },
  { country: 'Japan', values: [2, 2, 3, 2, 1, 4, 4, 1, 3, 3, 2, 3] },
  { country: 'Malaysia', values: [2, 4, 4, 4, 1, 2, 2, 3, 3, 3, 3, 2] },
  { country: 'Mexico', values: [2, 3, 4, 1, 3, 4, 2, 3, 2, 2, 3, 2] },
  { country: 'Netherlands', values: [1, 2, 2, 1, 4, 1, 2, 4, 2, 3, 4, 2] },
  { country: 'New Zealand', values: [4, 4, 3, 2, 3, 2, 2, 4, 2, 3, 1, 4] },
  { country: 'Norway', values: [1, 1, 4, 2, 2, 3, 1, 3, 2, 4, 3, 4] },
  { country: 'Peru', values: [1, 1, 2, 4, 3, 1, 3, 2, 3, 3, 1, 1] },
  { country: 'Philippines', values: [2, 4, 1, 1, 1, 3, 3, 3, 3, 2, 2, 1] },
  { country: 'Poland', values: [1, 3, 2, 3, 1, 1, 1, 4, 3, 1, 3, 2] },
  { country: 'Portugal', values: [null, 1, 2, 4, 1, 2, 4, 2, 3, 3, 4, 2] },
  { country: 'Russia', values: [3, 3, 2, 3, 4, 4, 1, 4, 1, 2, 3, 1] },
  { country: 'Saudi Arabia', values: [2, 1, 2, 3, 2, 2, 1, 4, 1, 3, 3, 1] },
  { country: 'Singapore', values: [1, 1, 4, 4, 1, 4, 2, 2, 3, 3, 2, 2] },
  { country: 'South Africa', values: [4, 1, 1, 2, 4, 2, 3, 1, 3, 3, 2, 3] },
  { country: 'South Korea', values: [4, 4, 4, 3, 1, 1, 3, 1, 3, 3, 2, 4] },
  { country: 'Spain', values: [2, 4, 2, 3, 4, 3, 3, 1, 3, 2, 1, 2] },
  { country: 'Sweden', values: [4, 4, 2, 3, 2, 3, 4, 4, 1, 1, 3, 2] },
  { country: 'Switzerland', values: [2, 1, 4, 1, 4, 3, 1, 3, 2, 2, 2, 4] },
  { country: 'Taiwan', values: [4, 3, 4, 2, 1, 1, 1, 1, 3, 3, 3, 4] },
  { country: 'Thailand', values: [2, 1, 2, 3, 4, 4, 2, 1, 3, 2, 4, 1] },
  { country: 'Turkey', values: [3, 1, 1, 4, 1, 4, 4, 4, 1, 1, 2, 1] },
  { country: 'United Kingdom', values: [1, 1, 2, 3, 3, 3, 4, 1, 4, 3, 4, 1] },
  { country: 'United States', values: [1, 4, 3, 4, 1, 2, 4, 1, 3, 3, 2, 4] },
  { country: 'MODE/MEAN', values: [1, 1, 2, 3, 4, 2, 4, 4, 3, 3, 3, 2], summary: true },
];

const quadCellStyle = (quad) => {
  const colors = QUAD_COLORS[quad] || { bg: '#f3f4f6', text: '#111827' };
  return {
    backgroundColor: colors.bg,
    color: colors.text,
  };
};

const QuadLogoMark = () => (
  <div
    aria-hidden="true"
    style={{
      fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif",
      lineHeight: 0.9,
      fontSize: '24px',
      userSelect: 'none',
    }}
  >
    <div>
      <span style={{ color: QUAD_COLORS[1].bg }}>Q</span>
      <span style={{ color: QUAD_COLORS[2].bg }}>U</span>
    </div>
    <div>
      <span style={{ color: QUAD_COLORS[3].bg }}>A</span>
      <span style={{ color: QUAD_COLORS[4].bg }}>D</span>
    </div>
  </div>
);

const USMonthlyReferenceTable = () => (
  <Card className="dark:bg-gray-800">
    <Title className="mb-2 text-base dark:text-white">US Monthly</Title>
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table className="min-w-[510px] w-full text-left text-[10px]">
        <thead className="bg-gray-50 text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
          <tr>
            <th className="px-2 py-1">Period</th>
            <th className="px-2 py-1 text-right">Q1</th>
            <th className="px-2 py-1 text-right">Q2</th>
            <th className="px-2 py-1 text-right">Q3</th>
            <th className="px-2 py-1 text-right">Q4</th>
            <th className="px-2 py-1 text-center">Quad</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {MONTHLY_QUAD_REFERENCE.map((row) => (
            <tr key={row.period} className={row.period === 'Jul-26' ? 'bg-blue-50 dark:bg-blue-900/20' : ''}>
              <td className="px-2 py-1 text-gray-900 dark:text-gray-100">{row.period}</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.q1}%</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.q2}%</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.q3}%</td>
              <td className="px-2 py-1 text-right tabular-nums">{row.q4}%</td>
              <td className="px-2 py-1 text-center">
                <span className="inline-flex h-4 w-4 items-center justify-center rounded text-[10px]" style={quadCellStyle(row.quad)}>
                  {row.quad}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

const USQuarterlyReferenceTable = ({ block }) => (
  <Card className="dark:bg-gray-800">
    <Title className="mb-2 text-base dark:text-white">US Quarterly - {block.label}</Title>
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table className="min-w-[860px] w-full text-left text-[9px]">
        <thead className="bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
          <tr>
            <th className="sticky left-0 z-10 bg-gray-50 px-2 py-1 dark:bg-gray-900">{block.label}</th>
            {US_QUARTERLY_PERIODS.map((period) => (
              <th
                key={period}
                className={`px-1.5 py-1 text-center ${US_QUARTERLY_ESTIMATE_PERIODS.includes(period) ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200' : ''}`}
              >
                {period}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {block.rows.map((row) => (
            <tr key={row.label}>
              <td className="sticky left-0 z-10 bg-white px-2 py-1 text-gray-900 dark:bg-gray-800 dark:text-gray-100">{row.label}</td>
              {row.values.map((value, index) => (
                <td
                  key={`${row.label}-${US_QUARTERLY_PERIODS[index]}`}
                  className="px-1.5 py-1 text-center tabular-nums"
                  style={row.type === 'quad' ? quadCellStyle(value) : undefined}
                >
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <div className="mt-2 overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table className="min-w-[455px] w-full text-left text-[9px]">
        <thead className="bg-gray-50 text-gray-500 dark:bg-gray-900 dark:text-gray-400">
          <tr>
            <th className="px-2 py-1">{block.label} Probabilities</th>
            {US_QUARTERLY_ESTIMATE_PERIODS.map((period) => (
              <th key={period} className="px-2 py-1 text-center">{period}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {block.probabilityRows.map((row) => (
            <tr key={row.label}>
              <td
                className="px-2 py-1 text-gray-900 dark:text-gray-100"
                style={row.quad ? { color: QUAD_COLORS[row.quad]?.bg } : undefined}
              >
                {row.label}
              </td>
              {row.values.map((value, index) => (
                <td key={`${row.label}-${index}`} className="px-2 py-1 text-center tabular-nums">
                  {value}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

const GlobalQuadForecastReferenceTable = () => (
  <Card className="dark:bg-gray-800">
    <div className="mb-2 flex items-center gap-2">
      <QuadLogoMark />
      <Title className="text-base dark:text-white">Global Quad Forecast</Title>
    </div>
    <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
      <table className="min-w-[790px] w-full border-collapse text-left text-[10px]">
        <thead className="bg-gray-50 text-gray-600 dark:bg-gray-900 dark:text-gray-300">
          <tr>
            <th className="sticky left-0 z-20 min-w-[120px] bg-gray-50 px-2 py-1 dark:bg-gray-900">
              Country
            </th>
            {GLOBAL_FORECAST_PERIODS.map((period) => {
              const highlighted = period === '2Q26E';
              return (
                <th
                  key={period}
                  className={`min-w-[52px] px-2 py-1 text-center ${
                    highlighted
                      ? 'border-l-2 border-r-2 border-blue-400 bg-blue-50 text-blue-500 dark:bg-blue-900/30 dark:text-blue-200'
                      : ''
                  }`}
                >
                  {period}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {GLOBAL_QUAD_REFERENCE.map((row) => (
            <tr key={row.country} className={row.summary ? 'border-t-2 border-gray-300 dark:border-gray-600' : ''}>
              <td
                className={`sticky left-0 z-10 border-t border-gray-200 bg-white px-2 py-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 ${
                  row.summary ? 'text-gray-950 dark:text-white' : 'text-gray-700 dark:text-gray-200'
                }`}
              >
                {row.country}
              </td>
              {row.values.map((value, index) => {
                const period = GLOBAL_FORECAST_PERIODS[index];
                const highlighted = period === '2Q26E';
                return (
                  <td
                    key={`${row.country}-${period}`}
                    className={`border-t border-gray-200 px-2 py-1 text-center tabular-nums dark:border-gray-700 ${
                      highlighted ? 'border-l-2 border-r-2 border-blue-400' : ''
                    }`}
                    style={value ? quadCellStyle(value) : { backgroundColor: '#f3f4f6', color: '#94a3b8' }}
                  >
                    {value || '--'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

const REFERENCE_PANEL_OPTIONS = [
  { id: 'regime-cheat-sheet', label: 'Regime Cheat Sheet' },
  { id: 'us-monthly', label: 'US Monthly' },
  { id: 'us-quarterly-growth', label: 'US Quarterly Growth' },
  { id: 'us-quarterly-inflation', label: 'US Quarterly Inflation' },
  { id: 'global-forecast', label: 'Global Forecast' },
  { id: 'all-ev-matrix', label: 'All EV Matrix' },
];

const RegimeCheatSheetPanel = () => (
  <Card className="dark:bg-gray-800">
    <Title className="mb-3 text-base dark:text-white">Regime Cheat Sheet</Title>
    <div className="grid grid-cols-1 gap-2 lg:grid-cols-4">
      {quadData.map((quad) => (
        <div key={quad.quad} className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900/40">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="inline-flex h-5 w-5 items-center justify-center rounded text-[10px]"
              style={quadCellStyle(Number(quad.quad.match(/\d/)?.[0]))}
            >
              {quad.quad.match(/\d/)?.[0]}
            </span>
            <div className="text-[11px] text-gray-950 dark:text-gray-100">{quad.quad.replace(':', ' -')}</div>
          </div>
          <dl className="space-y-2 text-[10px] leading-snug">
            <div>
              <dt className="text-emerald-600 dark:text-emerald-300">Best assets</dt>
              <dd className="text-gray-700 dark:text-gray-300">{quad.bestAssetClasses}</dd>
            </div>
            <div>
              <dt className="text-red-600 dark:text-red-300">Worst assets</dt>
              <dd className="text-gray-700 dark:text-gray-300">{quad.worstAssetClasses}</dd>
            </div>
            <div>
              <dt className="text-emerald-600 dark:text-emerald-300">Best sectors</dt>
              <dd className="text-gray-700 dark:text-gray-300">{quad.bestEquitySectors}</dd>
            </div>
            <div>
              <dt className="text-emerald-600 dark:text-emerald-300">Best factors</dt>
              <dd className="text-gray-700 dark:text-gray-300">{quad.bestEquityStyleFactors}</dd>
            </div>
            <div>
              <dt className="text-emerald-600 dark:text-emerald-300">Best FI</dt>
              <dd className="text-gray-700 dark:text-gray-300">{quad.bestFixedIncomeSectors}</dd>
            </div>
          </dl>
        </div>
      ))}
    </div>
  </Card>
);

const OverlayRankingTable = ({ rows }) => (
  <div className="overflow-x-auto rounded-md border border-gray-200 dark:border-gray-700">
    <table
      className="min-w-[655px] w-full text-left text-[10px]"
      aria-label="Quad probability overlay rankings"
    >
      <thead className="bg-gray-50 text-[9px] uppercase tracking-[0.1em] text-gray-500 dark:bg-gray-900 dark:text-gray-400">
        <tr>
          <th className="px-2 py-1">Rank</th>
          <th className="px-2 py-1">Ticker</th>
          <th className="px-2 py-1">Exposure</th>
          <th className="px-2 py-1">Class</th>
          <th className="px-2 py-1 text-right">Score</th>
          <th className="px-2 py-1 text-right">Wtd EV</th>
          <th className="px-2 py-1 text-right">Pos Mass</th>
          <th className="px-2 py-1 text-right">Top-2 Floor</th>
          {QUAD_INPUTS.map(({ label }) => (
            <th key={label} className="px-2 py-1 text-right">{label}</th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
        {rows.map((row) => (
          <tr key={`${row.name}-${row.ticker || row.rank}`} className="hover:bg-gray-50 dark:hover:bg-gray-900/70">
            <td className="px-2 py-1 text-gray-500 dark:text-gray-400">{row.rank}</td>
            <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{row.ticker || '--'}</td>
            <td className="px-2 py-1 text-gray-900 dark:text-gray-100">{row.name}</td>
            <td className="px-2 py-1">
              <span className={`rounded px-1.5 py-0.5 text-[9px] ${CLASSIFICATION_CLASSES[row.classification] || ''}`}>
                {row.classification}
              </span>
            </td>
            <td className={`px-2 py-1 text-right tabular-nums ${valueTone(row.overlayScore)}`}>
              {formatScore(row.overlayScore)}
            </td>
            <td className={`px-2 py-1 text-right tabular-nums ${valueTone(row.weightedEV)}`}>
              {formatSignedPercent(row.weightedEV)}
            </td>
            <td className="px-2 py-1 text-right tabular-nums text-gray-700 dark:text-gray-200">
              {formatProbabilityMass(row.positiveProbMass)}
            </td>
            <td className={`px-2 py-1 text-right tabular-nums ${valueTone(row.topTwoFloor)}`}>
              {formatSignedPercent(row.topTwoFloor)}
            </td>
            {QUAD_INPUTS.map(({ key }) => (
              <td key={key} className={`px-2 py-1 text-right tabular-nums ${valueTone(row.ev[key])}`}>
                {formatSignedPercent(row.ev[key])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const AllEvMatrixPanel = () => (
  <Card className="dark:bg-gray-800">
    <Title className="mb-3 text-base dark:text-white">All EV Matrix</Title>
    <div className="overflow-x-auto pb-4 custom-scrollbar">
      <table className="w-full text-left border-collapse table-fixed">
        <thead>
          <tr>
            <th className="sticky left-0 z-20 bg-[#111] dark:bg-[#000] p-1 border border-gray-700 text-center font-bold text-white shadow-[2px_0_4px_rgba(0,0,0,0.1)] w-[120px] md:w-[150px] text-xs">
              Exposure
            </th>
            {ALL_EV_GROUPS.map((header, idx) => (
              <th key={idx} colSpan={4} className="p-1 border border-gray-600 bg-[#222] dark:bg-[#111] text-center text-xs font-semibold text-white">
                {header}
              </th>
            ))}
          </tr>
          <tr>
            <th className="sticky left-0 z-20 bg-[#222] dark:bg-[#111] border border-gray-600 p-1 shadow-[2px_0_4px_rgba(0,0,0,0.1)]"></th>
            {ALL_EV_GROUPS.map((_, groupIdx) => (
              <React.Fragment key={groupIdx}>
                {QUAD_INPUTS.map(({ label }) => (
                  <th
                    key={`${groupIdx}-${label}`}
                    className={`p-0 border border-gray-400 text-center text-[9px] font-bold ${
                      label === 'Q1'
                        ? 'bg-[#059669] text-black'
                        : label === 'Q2'
                          ? 'bg-[#fde047] text-black'
                          : label === 'Q3'
                            ? 'bg-[#dc2626] text-black'
                            : 'bg-[#dc2626] text-white'
                    }`}
                  >
                    {label.replace('Q', '')}
                  </th>
                ))}
              </React.Fragment>
            ))}
          </tr>
        </thead>
        <tbody>
          {transcribedQuarterlyExpectedValues.map((item, idx) => (
            <tr key={idx} className="hover:bg-gray-100 dark:hover:bg-gray-800/80 transition-colors">
              <td className="sticky left-0 z-10 bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 p-0.5 shadow-[2px_0_4px_rgba(0,0,0,0.1)] overflow-hidden">
                <div className="flex items-center justify-between gap-1">
                  <Text className="font-semibold text-gray-900 dark:text-gray-100 text-[9px] leading-tight truncate">{item.name}</Text>
                  {item.ticker && (
                    <span className="font-bold text-gray-600 dark:text-gray-400 text-[9px] leading-tight flex-shrink-0">
                      ({item.ticker})
                    </span>
                  )}
                </div>
              </td>
              {ALL_EV_GROUPS.map((_, groupIdx) => (
                <React.Fragment key={groupIdx}>
                  {QUAD_INPUTS.map(({ key }, quadIdx) => {
                    const value = getAllEvCellValue(idx, groupIdx, quadIdx);
                    return (
                      <td
                        key={`${groupIdx}-${key}`}
                        className={`h-5 border border-gray-300 p-0 text-center font-mono text-[9px] dark:border-gray-700 ${
                          allEvCellTone(value)
                        }`}
                      >
                        {formatAllEvCellValue(value)}
                      </td>
                    );
                  })}
                </React.Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </Card>
);

const ReferencePanel = ({ selectedReferencePanel }) => {
  if (selectedReferencePanel === 'us-monthly') return <USMonthlyReferenceTable />;
  if (selectedReferencePanel === 'us-quarterly-growth') return <USQuarterlyReferenceTable block={US_QUARTERLY_REFERENCE[0]} />;
  if (selectedReferencePanel === 'us-quarterly-inflation') return <USQuarterlyReferenceTable block={US_QUARTERLY_REFERENCE[1]} />;
  if (selectedReferencePanel === 'global-forecast') return <GlobalQuadForecastReferenceTable />;
  if (selectedReferencePanel === 'all-ev-matrix') return <AllEvMatrixPanel />;
  return <RegimeCheatSheetPanel />;
};

const evDropdownButtonClassName = 'mt-1 h-[30px] rounded-md border-gray-300 bg-white px-2 py-1 text-left text-xs text-gray-900 shadow-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
const evDropdownMenuClassName = 'rounded-md border-gray-300 bg-white text-xs shadow-xl dark:border-gray-600 dark:bg-gray-900';
const evDropdownOptionClassName = 'px-2 py-1.5 text-xs text-gray-900 dark:text-gray-100';

const ExpectedValuesWindow = ({
  show,
  right,
  width,
  theme,
  zIndex = 1200,
  portfolioData = null,
  portfolioLoading = false,
  portfolioRefreshing = false,
  portfolioError = null,
  selectedAccount = '',
}) => {
  const defaultScenario = findScenario(DEFAULT_QUAD_PROBABILITY_SCENARIO_ID);
  const defaultPeriod = findPeriod(defaultScenario, DEFAULT_QUAD_PROBABILITY_PERIOD_ID);
  const [scenarioId, setScenarioId] = useState(defaultScenario.id);
  const [periodId, setPeriodId] = useState(defaultPeriod.id);
  const [probabilityInputs, setProbabilityInputs] = useState(() => (
    cloneProbabilities(defaultPeriod.probabilities)
  ));
  const [classificationFilter, setClassificationFilter] = useState('All');
  const [selectedReferencePanel, setSelectedReferencePanel] = useState('regime-cheat-sheet');

  const selectedScenario = findScenario(scenarioId);
  const selectedPeriod = findPeriod(selectedScenario, periodId);
  const probabilitySummary = useMemo(
    () => normalizeQuadProbabilities(probabilityInputs),
    [probabilityInputs]
  );
  const overlayRows = useMemo(
    () => computeQuadProbabilityOverlay(transcribedQuarterlyExpectedValues, probabilityInputs),
    [probabilityInputs]
  );
  const filteredOverlayRows = useMemo(() => {
    if (classificationFilter === 'All') return overlayRows;
    return overlayRows.filter((row) => row.classification === classificationFilter);
  }, [classificationFilter, overlayRows]);
  const topQuadLabels = probabilitySummary.topQuads
    .slice(0, 2)
    .map((key) => key.toUpperCase())
    .join(' / ');
  const totalIsOff = Math.abs((probabilitySummary.totalPct || 0) - 100) >= 0.1;
  const topQuad = probabilitySummary.topQuads[0];
  const secondQuad = probabilitySummary.topQuads[1];
  const selectedPeriodIndex = selectedScenario?.periods?.findIndex(
    (period) => period.id === selectedPeriod.id
  ) ?? -1;
  const previousPeriod = selectedPeriodIndex > 0
    ? selectedScenario.periods[selectedPeriodIndex - 1]
    : null;
  const previousQuad = previousPeriod
    ? normalizeQuadProbabilities(previousPeriod.probabilities).topQuads[0]
    : null;

  const applyScenarioPeriod = (nextScenarioId, nextPeriodId) => {
    const nextScenario = findScenario(nextScenarioId);
    const nextPeriod = findPeriod(nextScenario, nextPeriodId);
    setScenarioId(nextScenario.id);
    setPeriodId(nextPeriod.id);
    setProbabilityInputs(cloneProbabilities(nextPeriod.probabilities));
  };

  const handleProbabilityChange = (key, value) => {
    setProbabilityInputs((current) => ({
      ...current,
      [key]: value,
    }));
  };

  if (!show) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: right,
        width: width,
        height: '100vh',
        zIndex,
        backgroundColor: theme === 'dark' ? '#111827' : '#ffffff',
        borderLeft: '1px solid #d1d5db',
        borderRight: '1px solid #d1d5db',
        borderRadius: '0.75rem 0 0 0',
        boxShadow: '-2px 0 8px rgba(0, 0, 0, 0.08), 2px 0 8px rgba(0, 0, 0, 0.08)',
        transition: 'width 0.3s ease-in-out, right 0.3s ease-in-out, border-radius 0.3s ease-in-out',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
      className="dark:border-gray-700"
    >
      <div className="ev-window-content">
        <div className="ev-window-layout">
          <aside className="ev-window-sidebar custom-scrollbar">
            <Card className="ev-control-card dark:bg-gray-800">
              <Title className="mb-2 text-sm dark:text-white">Decision Inputs</Title>
              <div className="ev-control-stack">
                <label className="ev-control-label text-gray-500 dark:text-gray-400">
                  Scenario
                  <PopoverSelect
                    ariaLabel="Scenario"
                    value={scenarioId}
                    options={selectableScenarios.map((scenario) => ({
                      value: scenario.id,
                      label: scenario.label,
                    }))}
                    onChange={(nextScenarioId) => {
                      const nextScenario = findScenario(nextScenarioId);
                      applyScenarioPeriod(nextScenario.id, nextScenario.periods?.[0]?.id);
                    }}
                    buttonClassName={evDropdownButtonClassName}
                    menuClassName={evDropdownMenuClassName}
                    optionClassName={evDropdownOptionClassName}
                    menuMatchButtonWidth
                    menuOffset={4}
                  />
                </label>

                <label className="ev-control-label text-gray-500 dark:text-gray-400">
                  Period
                  <PopoverSelect
                    ariaLabel="Period"
                    value={periodId}
                    options={selectedScenario.periods.map((period) => ({
                      value: period.id,
                      label: period.label,
                    }))}
                    onChange={(nextPeriodId) => applyScenarioPeriod(scenarioId, nextPeriodId)}
                    buttonClassName={evDropdownButtonClassName}
                    menuClassName={evDropdownMenuClassName}
                    optionClassName={evDropdownOptionClassName}
                    menuMatchButtonWidth
                    menuOffset={4}
                  />
                </label>

                <div
                  className={`rounded-md border px-2 py-1.5 text-xs ${
                    totalIsOff
                      ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-200'
                      : 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200'
                  }`}
                >
                  Total {probabilitySummary.totalPct?.toFixed(1) ?? '0.0'}%
                  {totalIsOff ? ' - normalized for score' : ''}
                </div>

                <div className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-200">
                  Top pair: {topQuadLabels}
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  {QUAD_INPUTS.map(({ key, label }) => {
                    const isTopQuad = key === topQuad;
                    const isSecondQuad = key === secondQuad;
                    return (
                      <label
                        key={key}
                        className={`rounded-md border bg-white px-2 py-1.5 text-[10px] uppercase tracking-[0.12em] text-gray-500 dark:bg-gray-900 dark:text-gray-400 ${
                          isTopQuad
                            ? 'border-black ring-1 ring-black dark:border-white dark:ring-white'
                            : isSecondQuad
                              ? 'border-gray-500 dark:border-gray-300'
                              : 'border-gray-300 dark:border-gray-700'
                        }`}
                      >
                        {label}
                        <div className="mt-0.5 flex items-center">
                          <input
                            aria-label={`${label} probability`}
                            type="number"
                            min="0"
                            step="1"
                            value={probabilityInputs[key]}
                            onChange={(event) => handleProbabilityChange(key, event.target.value)}
                            className="w-full bg-transparent text-right text-sm text-gray-900 outline-none dark:text-gray-100"
                          />
                          <span className="pl-1 text-xs text-gray-500 dark:text-gray-400">%</span>
                        </div>
                      </label>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => applyScenarioPeriod(scenarioId, periodId)}
                  className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  Reset
                </button>
              </div>

              <div className="ev-control-section border-t border-gray-200 dark:border-gray-700">
                <div className="ev-control-heading text-gray-500 dark:text-gray-400">Classification</div>
                <div className="grid grid-cols-2 gap-1">
                  {CLASSIFICATION_FILTERS.map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setClassificationFilter(filter)}
                      className={`rounded-md border px-2 py-1 text-left text-[11px] transition-colors ${
                        classificationFilter === filter
                          ? 'border-blue-500 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-200'
                          : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                      }`}
                    >
                      {filter}
                    </button>
                  ))}
                </div>
              </div>

              <div className="ev-control-section border-t border-gray-200 dark:border-gray-700">
                <div className="ev-control-heading text-gray-500 dark:text-gray-400">Reference</div>
                <div className="grid grid-cols-2 gap-1">
                  {REFERENCE_PANEL_OPTIONS.map((panel) => (
                    <button
                      key={panel.id}
                      type="button"
                      onClick={() => setSelectedReferencePanel(panel.id)}
                      className={`rounded-md border px-2 py-1 text-left text-[11px] transition-colors ${
                        selectedReferencePanel === panel.id
                          ? 'border-gray-900 bg-gray-900 text-white dark:border-gray-100 dark:bg-gray-100 dark:text-gray-950'
                          : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                      }`}
                    >
                      {panel.label}
                    </button>
                  ))}
                </div>
              </div>
            </Card>
          </aside>

          <main className="ev-window-main custom-scrollbar">
            <PortfolioQuadExposureCard
              portfolioData={portfolioData}
              isLoading={portfolioLoading}
              isRefreshing={portfolioRefreshing}
              error={portfolioError}
              currentQuad={topQuad}
              previousQuad={previousQuad}
              currentPeriodLabel={selectedPeriod.label}
              previousPeriodLabel={previousPeriod?.label || ''}
              selectedAccount={selectedAccount}
            />

            <Card className="dark:bg-gray-800">
              <div className="mb-3">
                <Title className="text-xl dark:text-white">Quad Probability Overlay</Title>
                <Text className="text-sm font-semibold text-gray-600 dark:text-gray-300">
                  {selectedScenario.label} {selectedPeriod.label}
                </Text>
              </div>
              <OverlayRankingTable rows={filteredOverlayRows} />
            </Card>

            <ReferencePanel selectedReferencePanel={selectedReferencePanel} />
          </main>
        </div>
      </div>
    </div>
  );
};

export default ExpectedValuesWindow;
