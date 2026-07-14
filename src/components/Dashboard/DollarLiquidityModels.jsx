import React, { useEffect, useMemo, useState } from 'react';
import { AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { DollarSign as BadgeDollarSign, Globe as Globe2, RefreshCw } from 'lucide-react';
import LoadingIndicator from '../common/LoadingIndicator';
import { MarketDataService } from '../../services/api/marketDataService';

const PERIODS = ['1m', '3m', '6m', '12m'];
const DOLLAR_LIQUIDITY_ICON = '/assets/dollar-liquidity-washington.png';

const formatPercent = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  const pct = Number(value) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
};

const formatRatio = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return Number(value).toFixed(3);
};

const formatScore = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  return `${Number(value).toFixed(1)}/100`;
};

const formatUsdLevel = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
  const numeric = Number(value);
  if (Math.abs(numeric) >= 1000) return `$${(numeric / 1000).toFixed(2)}T`;
  return `$${numeric.toFixed(0)}B`;
};

const formatDate = (date) => {
  if (!date) return 'N/A';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};

const compactDate = (date) => {
  if (!date) return '';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

const getStatusLabel = (status) => {
  if (status === 'ok') return 'Verified';
  if (status === 'partial') return 'Partial';
  return 'No verified data';
};

const getRegimeClass = (regime = '') => {
  const lower = regime.toLowerCase();
  if (lower.includes('red')) return 'is-red';
  if (lower.includes('yellow') || lower.includes('neutral')) return 'is-yellow';
  if (lower.includes('green') || lower.includes('supportive')) return 'is-green';
  return 'is-muted';
};

const DollarLiquidityHeaderIcon = () => (
  <img
    src={DOLLAR_LIQUIDITY_ICON}
    alt=""
    className="dollar-liquidity-title-image"
    aria-hidden="true"
  />
);

const MissingInputs = ({ items }) => {
  if (!items || items.length === 0) return null;
  return (
    <div className="dollar-liquidity-missing">
      <span>Missing inputs</span>
      <div>
        {items.slice(0, 5).map((item) => (
          <span key={item} className="dollar-liquidity-chip muted">{item}</span>
        ))}
        {items.length > 5 && (
          <span className="dollar-liquidity-chip muted">+{items.length - 5} more</span>
        )}
      </div>
    </div>
  );
};

const GrowthTable = ({ growth, growthGap }) => (
  <table className="dollar-liquidity-growth-table">
    <thead>
      <tr>
        <th>Window</th>
        {PERIODS.map((period) => <th key={period}>{period.toUpperCase()}</th>)}
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Growth</td>
        {PERIODS.map((period) => <td key={period}>{formatPercent(growth?.[period])}</td>)}
      </tr>
      {growthGap && (
        <tr>
          <td>Gap</td>
          {PERIODS.map((period) => <td key={period}>{formatPercent(growthGap?.[period])}</td>)}
        </tr>
      )}
    </tbody>
  </table>
);

const GlobalModelPanel = ({ model }) => {
  const latest = model?.latest;
  const history = model?.history || [];
  return (
    <section className="dollar-liquidity-model">
      <div className="dollar-liquidity-model-header">
        <div className="dollar-liquidity-title-block">
          <Globe2 size={16} />
          <div>
            <h3>Global Liquidity</h3>
            <span>G4+China USD M2</span>
          </div>
        </div>
        <span className={`dollar-liquidity-status ${model?.status || 'unavailable'}`}>
          {getStatusLabel(model?.status)}
        </span>
      </div>

      {!latest ? (
        <div className="dollar-liquidity-empty">
          <strong>No verified global model yet</strong>
          <span>Manual regional inputs are required before this becomes a complete global signal.</span>
          <MissingInputs items={model?.missingInputs} />
        </div>
      ) : (
        <>
          <div className="dollar-liquidity-headlines">
            <div>
              <span>Risk score</span>
              <strong>{formatScore(latest.riskScore)}</strong>
            </div>
            <div>
              <span>M2/GDP</span>
              <strong>{formatRatio(latest.m2ToGdp)}</strong>
            </div>
            <div>
              <span>Regime</span>
              <strong className={getRegimeClass(latest.regime)}>{latest.regime}</strong>
            </div>
          </div>
          <GrowthTable growth={latest.growth} growthGap={latest.growthGap} />
          <div className="dollar-liquidity-chart">
            <ResponsiveContainer width="100%" height={150}>
              <AreaChart data={history} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <XAxis dataKey="date" tickFormatter={compactDate} tick={{ fontSize: 10 }} minTickGap={24} />
                <YAxis tick={{ fontSize: 10 }} width={48} />
                <Tooltip labelFormatter={formatDate} formatter={(value) => [formatScore(value), 'Risk score']} />
                <Area type="monotone" dataKey="riskScore" stroke="#2563eb" fill="#bfdbfe" strokeWidth={1.5} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </section>
  );
};

const UsModelPanel = ({ model }) => {
  const latest = model?.latest;
  const history = model?.history || [];
  const components = model?.components || [];
  const componentData = useMemo(() => components.map((component) => ({
    ...component,
    displayName: component.name.replace('Money market funds', 'MMF'),
  })), [components]);

  return (
    <section className="dollar-liquidity-model">
      <div className="dollar-liquidity-model-header">
        <div className="dollar-liquidity-title-block">
          <BadgeDollarSign size={17} />
          <div>
            <h3>U.S. Dollar Liquidity</h3>
            <span>Onshore stack vs GDP</span>
          </div>
        </div>
        <span className={`dollar-liquidity-status ${model?.status || 'unavailable'}`}>
          {getStatusLabel(model?.status)}
        </span>
      </div>

      {!latest ? (
        <div className="dollar-liquidity-empty">
          <strong>No verified U.S. stack yet</strong>
          <span>Required public series were unavailable on the latest refresh.</span>
          <MissingInputs items={model?.missingInputs} />
        </div>
      ) : (
        <>
          <div className="dollar-liquidity-headlines">
            <div>
              <span>Total stack</span>
              <strong>{formatUsdLevel(latest.dollarLiquidityStack)}</strong>
            </div>
            <div>
              <span>Stack/GDP</span>
              <strong>{formatRatio(latest.stackToGdp)}</strong>
            </div>
            <div>
              <span>Regime</span>
              <strong className={getRegimeClass(latest.regime)}>{latest.regime}</strong>
            </div>
          </div>
          <GrowthTable growth={latest.growth} />
          <div className="dollar-liquidity-chart-row">
            <div className="dollar-liquidity-chart">
              <ResponsiveContainer width="100%" height={150}>
                <AreaChart data={history} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <XAxis dataKey="date" tickFormatter={compactDate} tick={{ fontSize: 10 }} minTickGap={24} />
                  <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={(value) => `${Number(value).toFixed(1)}x`} />
                  <Tooltip labelFormatter={formatDate} formatter={(value) => [formatRatio(value), 'Stack/GDP']} />
                  <Area type="monotone" dataKey="stackToGdp" stroke="#059669" fill="#bbf7d0" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="dollar-liquidity-chart">
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={componentData} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                  <XAxis dataKey="displayName" tick={{ fontSize: 9 }} interval={0} height={34} />
                  <YAxis tick={{ fontSize: 10 }} width={42} tickFormatter={(value) => `${Number(value / 1000).toFixed(1)}T`} />
                  <Tooltip formatter={(value) => [formatUsdLevel(value), 'Component']} />
                  <Bar dataKey="value" fill="#0f766e" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="dollar-liquidity-components">
            {components.map((component) => (
              <div key={component.code}>
                <span>{component.name}</span>
                <strong>{formatUsdLevel(component.value)}</strong>
                {component.provisional && <em>Provisional</em>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
};

const DollarLiquidityModels = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;

    const fetchModels = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await MarketDataService.getDollarLiquidityModels();
        if (active) setData(response);
      } catch (err) {
        if (active) setError(err.message || 'Failed to fetch dollar liquidity models');
      } finally {
        if (active) setLoading(false);
      }
    };

    fetchModels();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <section className="dashboard-card-chrome dollar-liquidity-panel">
        <div className="dollar-liquidity-panel-header">
          <div className="dollar-liquidity-title-block">
            <DollarLiquidityHeaderIcon />
            <div>
              <h2>Dollar Liquidity Models</h2>
              <span>Global and U.S. liquidity regimes</span>
            </div>
          </div>
        </div>
        <LoadingIndicator label="Loading dollar liquidity models..." size="lg" centered className="py-8" />
      </section>
    );
  }

  if (error) {
    return (
      <section className="dashboard-card-chrome dollar-liquidity-panel">
        <div className="dollar-liquidity-panel-header">
          <div className="dollar-liquidity-title-block">
            <DollarLiquidityHeaderIcon />
            <div>
              <h2>Dollar Liquidity Models</h2>
              <span>Global and U.S. liquidity regimes</span>
            </div>
          </div>
        </div>
        <div className="dollar-liquidity-empty error">
          <strong>Unable to load liquidity models</strong>
          <span>{error}</span>
        </div>
      </section>
    );
  }

  const updatedAt = data?.timestamp ? new Date(data.timestamp) : null;

  return (
    <section className="dashboard-card-chrome dollar-liquidity-panel">
      <div className="dollar-liquidity-panel-header">
        <div className="dollar-liquidity-title-block">
          <DollarLiquidityHeaderIcon />
          <div>
            <h2>Dollar Liquidity Models</h2>
            <span>Global and U.S. liquidity regimes</span>
          </div>
        </div>
        {updatedAt && (
          <span className="dollar-liquidity-updated">
            <RefreshCw size={12} />
            {updatedAt.toLocaleString()}
          </span>
        )}
      </div>
      <div className="dollar-liquidity-grid">
        <GlobalModelPanel model={data?.models?.global} />
        <UsModelPanel model={data?.models?.us} />
      </div>
    </section>
  );
};

export default DollarLiquidityModels;
