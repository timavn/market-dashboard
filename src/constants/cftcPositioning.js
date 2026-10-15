export const CFTC_STALE_AFTER_DAYS = 10;
export const CFTC_STALE_AFTER_MS = CFTC_STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

export const CFTC_SERIES_LABELS = {
  'legacy-noncommercial-combined': {
    label: 'Legacy non-commercial',
    sourceKey: 'legacy',
  },
  'disaggregated-managed-money-combined': {
    label: 'Disaggregated managed money',
    sourceKey: 'disaggregated',
  },
};

export const CFTC_HISTORY_FIELDS = [
  { key: 'average3M', label: '3M average', weeks: 13 },
  { key: 'average6M', label: '6M average', weeks: 26 },
  { key: 'average1Y', label: '1Y average', weeks: 52 },
  { key: 'maximum3Y', label: '3Y maximum', weeks: 156 },
  { key: 'minimum3Y', label: '3Y minimum', weeks: 156 },
];

export const CFTC_REPORT_COLUMNS = [
  { key: 'latest', label: 'Latest' },
  { key: 'wwChg', label: 'W/W Chg' },
  { key: 'average3M', label: '3M Avg', history: true },
  { key: 'average6M', label: '6M Avg', history: true },
  { key: 'average1Y', label: '1Y Avg', history: true },
  { key: 'maximum3Y', label: 'Max', group: '3Y', history: true },
  { key: 'minimum3Y', label: 'Min', group: '3Y', history: true },
  { key: 'zScore1Y', label: '1Y', group: 'Z-Score', score: true },
  { key: 'zScore3Y', label: '3Y', group: 'Z-Score', score: true },
];

// The show's reading order, followed by the retained dashboard references.
export const CFTC_REPORT_CONTRACT_ORDER = [
  '13874A', '1170E1', '239742', '124603', '209742',
  '043602', '042601', '044601', '020601', '045601', '132741',
  '098662', '097741', '099741', '096742', '232741', '090741', '095741', '112741', '092741',
  '067651', '088691', '085692', '023651', '111659', '022651', '084691', '076651',
  '002602', '005602', '001602', '057642', '054642', '080732', '033661', '083731', '073732', '040701',
  '133741',
];
