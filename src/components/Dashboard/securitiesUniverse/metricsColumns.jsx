import React from 'react';
import { Percent, LayoutGrid, DollarSign, Activity } from 'lucide-react';

export const METRICS_COLUMNS = [
  {
    key: 'ticker',
    label: 'Ticker',
    icon: (
      <div
        style={{
          height: '17px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '12px',
          fontWeight: 600,
        }}
        className="text-blue-500"
      >
        ABC
      </div>
    ),
    width: '45px',
    sortable: true,
  },
  {
    key: 'bias',
    label: 'Bias',
    icon: (
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        className="text-blue-500"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M7 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h2" />
        <line x1="12" y1="4" x2="12" y2="20" />
        <path d="M17 4h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2" />
      </svg>
    ),
    width: '60px',
    infoParams: 'trend',
    sortable: true,
  },
  {
    key: 'riskRangeHistory',
    label: 'Risk Range',
    icon: (
      <div
        style={{
          height: '22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '17px',
          fontWeight: 600,
        }}
        className="text-blue-500"
      >
        RR
      </div>
    ),
    width: '400px',
    infoParams: 'riskRange',
    sortable: true,
  },
  {
    key: 'ivolPrem',
    label: 'IVOL Prem',
    icon: <Percent size={22} className="text-blue-500" />,
    width: '65px',
    infoParams: 'ivolPrem',
    sortable: true,
  },
  {
    key: 'ttmZScore',
    label: 'TTM Z-Score',
    icon: (
      <div
        style={{
          height: '22px',
          width: '22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '17px',
          fontWeight: 600,
        }}
        className="text-blue-500"
      >
        Z
      </div>
    ),
    width: '55px',
    infoParams: 'ttmZScore',
    sortable: true,
  },
  {
    key: 'ivolZScore',
    label: 'IVOL High',
    icon: <Percent size={22} className="text-blue-500" />,
    width: '60px',
    infoParams: 'ivolZScore',
    sortable: true,
  },
  {
    key: 'zScore',
    label: 'Z-Score',
    icon: (
      <div
        style={{
          height: '22px',
          width: '22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '17px',
          fontWeight: 600,
        }}
        className="text-blue-500"
      >
        Z
      </div>
    ),
    width: '50px',
    infoParams: 'zScore',
    sortable: true,
  },
  {
    key: 'beta',
    label: 'Beta',
    icon: (
      <div
        style={{
          height: '22px',
          width: '22px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '17px',
          fontWeight: 600,
        }}
        className="text-blue-500"
      >
        β
      </div>
    ),
    width: '40px',
    infoParams: 'beta',
    sortable: true,
  },
  {
    key: 'quadRanking',
    label: 'Quad',
    icon: <LayoutGrid size={22} className="text-blue-500" />,
    width: '50px',
    infoParams: 'quad',
    sortable: true,
  },
  {
    key: 'priceChanges',
    label: 'Price Change',
    icon: <DollarSign size={22} className="text-blue-500" />,
    width: '80px',
    sortable: true,
  },
  {
    key: 'atr',
    label: 'ATR',
    icon: (
      <svg width="29" height="29" viewBox="0 0 100 100" aria-hidden style={{ display: 'block' }}>
        <title>ATR (stop sign)</title>
        <polygon
          points="30,5 70,5 95,30 95,70 70,95 30,95 5,70 5,30"
          fill="#dc2626"
          stroke="#dc2626"
          strokeWidth="3"
          strokeLinejoin="miter"
        />
        <text
          x="50"
          y="51"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#ffffff"
          fontSize="26"
          fontWeight="800"
          fontFamily="system-ui, -apple-system, Impact, 'Arial Black', sans-serif"
          letterSpacing="-0.06em"
          style={{ userSelect: 'none' }}
        >
          STOP
        </text>
      </svg>
    ),
    width: '70px',
    infoParams: 'atr',
    sortable: false,
  },
  {
    key: 'signal',
    label: 'Sig',
    icon: <Activity size={22} className="text-blue-500" />,
    width: '50px',
    sortable: true,
  },
];
