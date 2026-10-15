import React from 'react';
import {
  PROCESS_METHOD_IDS,
  getProcessDocument,
  getProcessMethodDocuments,
} from '../../constants/processDocuments';
import PositionSizingNote, { POSITION_SIZING_SECTIONS } from './PositionSizingNote';

const LibraryArticleContext = React.createContext({
  sectionPrefix: '',
  embedded: false,
  chapterNumber: null,
});

const scopeRegionId = (id, sectionPrefix = '') => (
  sectionPrefix ? `${sectionPrefix}--${id}` : id
);

const EditableRegion = React.memo(({
  as: Element = 'section',
  id,
  label,
  className,
  editor,
  children,
}) => {
  const isEditing = Boolean(editor?.isEditing);
  const hasOverride = Object.prototype.hasOwnProperty.call(editor?.regions || {}, id);
  const content = hasOverride
    ? { dangerouslySetInnerHTML: { __html: editor.regions[id] } }
    : { children };

  return (
    <Element
      id={id}
      className={className}
      data-testid={Element === 'section' ? 'process-library-section' : undefined}
      data-editable-region={id}
      contentEditable={isEditing ? true : undefined}
      suppressContentEditableWarning
      role={isEditing ? 'textbox' : undefined}
      aria-label={isEditing ? 'Edit ' + label + ' section' : undefined}
      aria-multiline={isEditing ? 'true' : undefined}
      tabIndex={isEditing ? 0 : undefined}
      onInput={isEditing ? (event) => editor.onRegionInput(id, event.currentTarget.innerHTML) : undefined}
      onBlur={isEditing ? editor.onRegionBlur : undefined}
      onPaste={isEditing ? (event) => editor.onRegionPaste(id, event) : undefined}
      onKeyDown={isEditing ? editor.onRegionKeyDown : undefined}
      {...content}
    />
  );
});

EditableRegion.displayName = 'EditableRegion';

const ArticleFrame = ({
  document,
  editor,
  children,
  sectionPrefix: sectionPrefixProp,
  embedded: embeddedProp,
  chapterNumber: chapterNumberProp,
}) => {
  const parentContext = React.useContext(LibraryArticleContext);
  const sectionPrefix = sectionPrefixProp ?? parentContext.sectionPrefix;
  const embedded = embeddedProp ?? parentContext.embedded;
  const chapterNumber = chapterNumberProp ?? parentContext.chapterNumber;
  const Frame = embedded ? 'section' : 'article';
  const title = embedded && chapterNumber
    ? `${chapterNumber}. ${document.title}`
    : document.title;
  const contextValue = {
    sectionPrefix,
    embedded,
    chapterNumber,
  };

  return (
    <LibraryArticleContext.Provider value={contextValue}>
      <Frame
        id={embedded ? sectionPrefix : undefined}
        className={
          'wp-paper process-library-article'
          + (embedded ? ' process-library-article--chapter' : '')
          + (editor?.isEditing ? ' is-editing' : '')
        }
        data-testid={embedded ? 'process-method-chapter' : 'process-document'}
        aria-label={document.title}
      >
        <EditableRegion
          as="header"
          id={scopeRegionId('title-page', sectionPrefix)}
          label="Title"
          className={
            'process-library-article__header'
            + (embedded ? ' process-library-article__chapter-header' : '')
          }
          editor={editor}
        >
          {!embedded && document.parentId && (
            <p className="process-library-article__eyebrow">
              <a href="#/process/methods">Methods</a>
            </p>
          )}
          {embedded ? (
            <h2 id={scopeRegionId(document.id + '-title', sectionPrefix)}>{title}</h2>
          ) : (
            <h1 id={scopeRegionId(document.id + '-title', sectionPrefix)}>{title}</h1>
          )}
          <p>{embedded ? METHOD_PURPOSES[document.id] : document.subtitle}</p>
        </EditableRegion>
        {children}
      </Frame>
    </LibraryArticleContext.Provider>
  );
};

const Region = ({ id, label, editor, children }) => {
  const { sectionPrefix } = React.useContext(LibraryArticleContext);
  return (
    <EditableRegion id={scopeRegionId(id, sectionPrefix)} label={label} editor={editor}>
      {children}
    </EditableRegion>
  );
};

const METHOD_PURPOSES = {
  'signals-and-risk-ranges': 'Trade, Trend, PVV, LRR/HRR, range structure, and entry location.',
  'position-sizing': 'Beta and ATR boundaries, conviction, targets, rounding, and incremental changes.',
  'stops-exits-and-reversals': 'Signal-based reductions, exits, reversals, and the hard-stop boundary.',
  'macro-regime-and-quad-overlay': 'USD correlations, volatility, rates, Quads, and expected-value ranking.',
  'security-selection-and-pods': 'Fundamental Pods, rate-of-change comparisons, factors, and candidate ranking.',
  'portfolio-construction-and-diversification': 'Gross, net, sleeve, concentration, and correlation review.',
  'data-controls-and-execution': 'Provenance, freshness, live-data gates, and read-only output.',
  'validation-and-change-control': 'Formula checks, boundaries, missing-data behavior, and reproducibility.',
};

export const METHODS_SECTIONS = [
  ['overview', 'How to use the Methods'],
  ['method-index', 'Method index'],
  ['technical-boundaries', 'Technical boundaries'],
];

export const getMethodChapterId = (methodId) => `method-${methodId}`;

export const getMethodSectionId = (methodId, sectionId) => (
  scopeRegionId(sectionId, getMethodChapterId(methodId))
);

export const METHODS_READER_SECTIONS = [
  ...METHODS_SECTIONS,
  ...getProcessMethodDocuments().map((method) => [
    getMethodChapterId(method.id),
    method.title,
  ]),
];

const PositionSizingMethodArticle = ({ document, editor }) => {
  const { sectionPrefix, chapterNumber } = React.useContext(LibraryArticleContext);
  const bodyId = scopeRegionId('document-body', sectionPrefix);
  const isEditing = Boolean(editor?.isEditing);

  return (
    <section
      id={sectionPrefix}
      className={'wp-paper process-library-article process-library-article--chapter' + (isEditing ? ' is-editing' : '')}
      data-testid="process-method-chapter"
      aria-label={document.title}
    >
      <EditableRegion
        as="header"
        id={scopeRegionId('title-page', sectionPrefix)}
        label="Title"
        className="process-library-article__header process-library-article__chapter-header"
        editor={editor}
      >
        <h2 id={scopeRegionId('chapter-title', sectionPrefix)}>
          {chapterNumber}. {document.title}
        </h2>
        <p>{METHOD_PURPOSES[document.id]}</p>
      </EditableRegion>
      <EditableRegion
        as="div"
        id={bodyId}
        label="Position Sizing document"
        className="process-library-article__position-sizing-body"
        editor={editor}
      >
        <PositionSizingNote
          document={document}
          sectionPrefix={sectionPrefix}
        />
      </EditableRegion>
    </section>
  );
};

function getMethodChapterComponent(methodId) {
  if (methodId === 'position-sizing') return PositionSizingMethodArticle;
  return PROCESS_LIBRARY_ARTICLES[methodId]?.component || null;
}

const MethodsArticle = ({ document, editor }) => {
  const methods = getProcessMethodDocuments();
  return (
    <ArticleFrame document={document} editor={editor}>
      <Region id="overview" label="How to use the Methods" editor={editor}>
        <h2>How to use the Methods</h2>
        <p>
          The Process explains the order of decisions. These appendices explain how each decision is calculated,
          including inputs, equations, boundaries, examples, and data controls. A Method describes the calculation it
          owns; it does not replace the order established by the Process.
        </p>
        <p>
          The technical pages use production calculations where an engine exists and identify descriptive research
          calculations where the dashboard does not yet produce a binding rule.
        </p>
      </Region>
      <Region id="method-index" label="Method index" editor={editor}>
        <h2>Method index</h2>
        <table className="wp-table process-library-article__index">
          <thead>
            <tr><th>Method</th><th>Purpose</th></tr>
          </thead>
          <tbody>
            {methods.map((method) => (
              <tr key={method.id}>
                <td>
                  <a href={`#/process/methods?section=${encodeURIComponent(getMethodChapterId(method.id))}`}>
                    {method.title}
                  </a>
                </td>
                <td>{METHOD_PURPOSES[method.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>
      <Region id="technical-boundaries" label="Technical boundaries" editor={editor}>
        <h2>Technical boundaries</h2>
        <p>
          Every derived value should retain its source, observation window, and as-of time. Missing or stale inputs
          remain unavailable; they are not converted into a bearish or bullish signal. The Process produces
          read-only recommendations and does not route, stage, or transmit orders.
        </p>
      </Region>
      {methods.map((method, index) => {
        const MethodArticle = getMethodChapterComponent(method.id);
        if (!MethodArticle) return null;
        return (
          <LibraryArticleContext.Provider
            key={method.id}
            value={{
              sectionPrefix: getMethodChapterId(method.id),
              embedded: true,
              chapterNumber: index + METHODS_SECTIONS.length,
            }}
          >
            <MethodArticle document={method} editor={editor} />
          </LibraryArticleContext.Provider>
        );
      })}
    </ArticleFrame>
  );
};

export const SIGNALS_AND_RISK_RANGES_SECTIONS = [
  ['overview', 'Overview'],
  ['directional-signals', 'Directional signals'],
  ['pvv', 'PVV and published ranges'],
  ['risk-ranges', 'Risk ranges'],
  ['entry-location', 'Entry location'],
  ['structure-and-records', 'Structure and records'],
  ['tail', 'Tail'],
  ['data-controls', 'Data controls'],
];

const SignalsAndRiskRangesArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="overview" label="Overview" editor={editor}>
      <h2>Overview</h2>
      <p>
        This Method is the quantitative timing layer. It turns independent directional signals and a published
        risk range into a directional and entry-location decision. It does not replace the macro qualification gate,
        calculate position size, or define portfolio limits.
      </p>
    </Region>
    <Region id="directional-signals" label="Directional signals" editor={editor}>
      <h2>Directional signals</h2>
      <dl>
        <dt>Trade</dt>
        <dd>The independently published short-duration direction, covering three weeks or less.</dd>
        <dt>Trend</dt>
        <dd>The independently published longer-duration direction, covering three months or more.</dd>
      </dl>
      <p>
        Trade and Trend retain separate sources, editions, and as-of times. A new position requires both signals to
        support the same non-neutral side. A missing signal remains unknown; it is not converted to neutral or treated
        as a break.
      </p>
    </Region>
    <Region id="pvv" label="PVV and published ranges" editor={editor}>
      <h2>PVV and published ranges</h2>
      <p>
        PVV means Price, Volume, and Volatility. The Process consumes the published PVV output as a time-indexed
        range rather than inferring a range from the current spot price:
      </p>
      <p className="wp-equation">
        <code>PVVₜ = f(P≤ₜ, V≤ₜ, σ≤ₜ) = [LRRₜ, HRRₜ]</code>
      </p>
      <p>
        The source model owns the exact function <code>f</code>. This Method validates the returned endpoints, common
        edition, source, and as-of time; it requires <code>LRRₜ &lt; HRRₜ</code> before normalizing spot or applying an
        entry rule. A missing or invalid PVV range blocks an open or add rather than becoming a neutral signal.
      </p>
    </Region>
    <Region id="risk-ranges" label="Risk ranges" editor={editor}>
      <h2>Risk ranges</h2>
      <p>
        LRR is the published low endpoint and HRR is the published high endpoint. A valid range requires both
        endpoints from the same edition with LRR below HRR. Normalize spot within the range:
      </p>
      <p className="wp-equation"><code>p = (spot − LRR) / (HRR − LRR)</code></p>
      <p>
        A price outside the interval remains visible but cannot authorize an open or add.
      </p>
    </Region>
    <Region id="entry-location" label="Entry location" editor={editor}>
      <h2>Entry location</h2>
      <ul>
        <li>A long may open or add only when 0 ≤ p ≤ 0.5.</li>
        <li>A short may open or add only when 0.5 ≤ p ≤ 1.</li>
        <li>The midpoint is included for either side when directional conditions are satisfied.</li>
        <li>Location permission does not by itself authorize a position or determine its size.</li>
      </ul>
      <p>
        The long range score is <code>1 − 2p</code>; the short range score is <code>2p − 1</code>. Each score measures
        how favorable the current entry location is within its permitted half.
      </p>
    </Region>
    <Region id="structure-and-records" label="Structure and records" editor={editor}>
      <h2>Structure and records</h2>
      <p>
        Long structure counts consecutive higher HRRs and higher LRRs. Short structure counts consecutive lower HRRs
        and lower LRRs. Each endpoint streak is independent, capped at five editions, and reset by a tie or missing
        edition.
      </p>
      <p className="wp-equation">
        <code>structure = 0.5 × (high streak / 5 + low streak / 5)</code>
      </p>
      <p>
        A long record extension occurs when current HRR exceeds the prior traded-price ATH. A short record extension
        occurs when current LRR is below the prior traded-price ATL. These are strength inputs; neither creates
        directional eligibility by itself.
      </p>
    </Region>
    <Region id="tail" label="Tail" editor={editor}>
      <h2>Tail</h2>
      <p>
        Tail is long-duration context for the overview. It is not an entry, exit, sizing, or portfolio authorization
        input in the current process.
      </p>
    </Region>
    <Region id="data-controls" label="Data controls" editor={editor}>
      <h2>Data controls</h2>
      <p>
        Signals and ranges retain source, edition, and as-of time. Historical ranges must include every available
        edition needed for streak comparisons. Record tests use completed traded-price history strictly before the
        current range edition.
      </p>
    </Region>
  </ArticleFrame>
);

export const STOPS_EXITS_AND_REVERSALS_SECTIONS = [
  ['overview', 'Overview'],
  ['signal-lifecycle', 'Signal lifecycle'],
  ['reversals', 'Reversals'],
  ['hard-stops', 'Hard stops'],
  ['unresolved-work', 'Unresolved work'],
];

const StopsExitsAndReversalsArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="overview" label="Overview" editor={editor}>
      <h2>Overview</h2>
      <p>
        Signal changes manage an existing position after the candidate has been accepted. They are separate from
        entry location and from the ATR sizing cap.
      </p>
    </Region>
    <Region id="signal-lifecycle" label="Signal lifecycle" editor={editor}>
      <h2>Signal lifecycle</h2>
      <ul>
        <li>When Trend breaks but Trade still supports the held side, reduce the existing position directly to MIN.</li>
        <li>When Trade breaks for the held side, set the position target to zero regardless of Trend.</li>
        <li>A missing signal is unknown and disables executable output; it is not reported as a confirmed break.</li>
      </ul>
    </Region>
    <Region id="reversals" label="Reversals" editor={editor}>
      <h2>Reversals</h2>
      <p>
        A reversal exits the held side first. The opposite side is a new candidate and must independently satisfy
        the macro gate, directional signals, and entry-location rule.
      </p>
    </Region>
    <Region id="hard-stops" label="Hard stops" editor={editor}>
      <h2>Hard stops</h2>
      <p>
        No canonical hard-stop formula is defined here. ATR is a maximum-position constraint in Position Sizing and
        must not be presented as a hard-stop rule.
      </p>
    </Region>
    <Region id="unresolved-work" label="Unresolved work" editor={editor}>
      <h2>Unresolved work</h2>
      <p>
        Any future hard-stop policy must specify placement, update frequency, trailing behavior, gap treatment, order
        type, precedence relative to Trade and Trend, and behavior for instruments with discontinuous trading.
      </p>
    </Region>
  </ArticleFrame>
);

export const QUAD_FRAMEWORK_SECTIONS = [
  ['overview', 'Overview'],
  ['usd-correlations', 'USD correlations'],
  ['volatility', 'Volatility'],
  ['interest-rates', 'Interest rates'],
  ['quads', 'Quad classification'],
  ['expected-value', 'Expected value'],
  ['qualification-gate', 'Qualification gate'],
];

const QuadFrameworkArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="overview" label="Overview" editor={editor}>
      <h2>Overview</h2>
      <p>
        This Method documents the quantitative top-down layer: dollar direction, cross-asset relationships, volatility,
        rates, Quad classification, and expected-value ranking. Its output is a candidate map and a qualification
        decision, not an automatic order.
      </p>
    </Region>
    <Region id="usd-correlations" label="USD correlations" editor={editor}>
      <h2>USD correlations</h2>
      <p>
        Normalize each completed daily closing-level history, align observations by common trading date, and
        calculate the trending Pearson correlation between DXY and each comparison asset:
      </p>
      <p className="wp-equation">
        <code>ρ(Pᴰˣʸ,Pᵃˢˢᵉᵗ) = cov(Pᴰˣʸ,Pᵃˢˢᵉᵗ) / (σDXY × σasset)</code>
      </p>
      <p>
        The operational matrix reports exact 15-, 30-, 90-, 120-, and 180-session windows. It also reports rolling
        30-session statistics over the latest 252 samples. These price-level correlations describe the trending
        relationship in the current regime; they are not return correlations or fixed assumptions.
      </p>
    </Region>
    <Region id="volatility" label="Volatility" editor={editor}>
      <h2>Volatility</h2>
      <p>
        Realized volatility annualizes the dispersion of completed returns:
      </p>
      <p className="wp-equation"><code>RV = stdev(returns) × √252</code></p>
      <p>
        Compare realized volatility with implied volatility using <code>IV − RV</code>. Track the direction of that
        spread, volatility-of-volatility, and the width of the published risk range
        <code> HRR − LRR</code>. Narrowing ranges indicate cooling conditions; widening ranges indicate more room is
        required for the same directional idea.
      </p>
      <p>
        For a configured series with low and high cutoffs, classify the regime as low when <code>x &lt; low</code>,
        normal when <code>low ≤ x &lt; high</code>, and elevated when <code>x ≥ high</code>. Cutoffs are series-specific
        and descriptive unless a canonical Method assigns them decision authority.
      </p>
    </Region>
    <Region id="interest-rates" label="Interest rates" editor={editor}>
      <h2>Interest rates</h2>
      <p>
        Read the two-year and ten-year yields as policy and growth inputs. The basic curve measure is:
      </p>
      <p className="wp-equation"><code>curve spread = yield10Y − yield2Y</code></p>
      <p>
        Rate-of-change observations use <code>ROC(x) = (xₜ / xₜ₋ₙ) − 1</code> when levels are positive. The rate
        direction and curve change must confirm the intended Quad and candidate exposure.
      </p>
    </Region>
    <Region id="quads" label="Quad classification" editor={editor}>
      <h2>Quad classification</h2>
      <p>
        Growth and inflation are classified by their level and rate of change. The four conceptual states are
        growth accelerating/inflation decelerating, growth accelerating/inflation accelerating, growth
        decelerating/inflation accelerating, and growth decelerating/inflation decelerating. Policy is the
        interpretation layer that connects the state to rates and asset-class behavior.
      </p>
      <p>
        Monthly and quarterly views are evaluated separately so that a shorter-term transition does not erase the
        longer-term regime.
      </p>
    </Region>
    <Region id="expected-value" label="Expected value" editor={editor}>
      <h2>Expected value</h2>
      <p>
        For each asset or exposure, use the expected-value table for all four Quads. If the user supplies Quad
        probabilities, normalize the non-negative inputs:
      </p>
      <p className="wp-equation"><code>pᵢ = max(0, raw pᵢ) / Σ max(0, raw pᵢ)</code></p>
      <p className="wp-equation"><code>weighted EV = Σ pᵢ × EVᵢ</code></p>
      <p>
        Candidate ranking can also use the positive probability mass and the weakest EV among the highest-probability
        Quads. Positive EV produces long candidates; negative EV produces short candidates or exclusions.
      </p>
    </Region>
    <Region id="qualification-gate" label="Qualification gate" editor={editor}>
      <h2>Qualification gate</h2>
      <p>
        A Quad candidate advances only when USD, volatility, rates, and correlation support the proposed direction.
        If equities are positive EV, SPX is rising, DXY is falling, and DXY/SPX correlation is approximately −0.9,
        the equity long is rejected when the move depends on a fragile dollar condition. The gate is binary for the
        proposed direction; it is not a discretionary score.
      </p>
    </Region>
  </ArticleFrame>
);

export const SECURITY_SELECTION_AND_PODS_SECTIONS = [
  ['overview', 'Overview'],
  ['universe-and-ranking', 'Universe and ranking'],
  ['pods', 'Pod definitions'],
  ['pod-calculations', 'Pod calculations'],
  ['factors-and-candidate-review', 'Factors and candidate review'],
  ['data-controls', 'Data controls'],
];

const SecuritySelectionAndPodsArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="overview" label="Overview" editor={editor}>
      <h2>Overview</h2>
      <p>
        Fundamentals are the bottom-up qualification layer. The quantitative process first narrows the universe;
        Pods then test whether the underlying business supports the proposed long or short.
      </p>
    </Region>
    <Region id="universe-and-ranking" label="Universe and ranking" editor={editor}>
      <h2>Universe and ranking</h2>
      <p>
        Start with a supported security universe, stable identifiers, sufficient history, and attributable financial
        data. Rank candidates against comparable securities and the current Quad rather than treating a single
        absolute metric as a decision.
      </p>
      <p>
        A security can appear in the universe without being directionally eligible, inside a permitted entry
        location, or sized for the portfolio.
      </p>
    </Region>
    <Region id="pods" label="Pod definitions" editor={editor}>
      <h2>Pod definitions</h2>
      <dl>
        <dt>Pod 1</dt><dd>Revenue growth and the change in that growth.</dd>
        <dt>Pod 2</dt><dd>EBITDA, earnings, or cash-flow growth and the change in that growth.</dd>
        <dt>Pod 3</dt><dd>Free cash flow, ROIC, and capital allocation.</dd>
      </dl>
    </Region>
    <Region id="pod-calculations" label="Pod calculations" editor={editor}>
      <h2>Pod calculations</h2>
      <p className="wp-equation"><code>growthₜ = (metricₜ / metricₜ₋ₙ) − 1</code></p>
      <p className="wp-equation"><code>growth change = growthₜ − growthₜ₋ₘ</code></p>
      <p>
        Use the same fiscal-period alignment and source hierarchy for the current and comparison periods. Base
        effects are part of the calculation: an easier prior comparison can mechanically accelerate the reported
        rate even before the absolute level changes materially.
      </p>
      <p>
        Pod 3 adds operating quality to the growth read. Free-cash-flow margin is
        <code> FCF / revenue</code>; ROIC is <code>NOPAT / invested capital</code>. These measures support the
        business-quality review and are not a substitute for the macro gate or quantitative timing signals.
      </p>
    </Region>
    <Region id="factors-and-candidate-review" label="Factors and candidate review" editor={editor}>
      <h2>Factors and candidate review</h2>
      <p>
        Compare factor exposures such as sales growth, EPS growth, leverage, beta, liquidity, short interest, and
        size against the prevailing Quad. A long is stronger when the Pods and the favored factor exposures agree. A
        short is stronger when Pods 1 and 2 deteriorate together and the factor exposure is also out of favor.
      </p>
      <p>
        The review is evidence-based rather than narrative-based. No single factor or Pod overrides a failed macro
        qualification or a broken Trade/Trend state.
      </p>
    </Region>
    <Region id="data-controls" label="Data controls" editor={editor}>
      <h2>Data controls</h2>
      <p>
        Financial periods, restatements, estimates, missing values, and source dates must remain visible. A missing
        fundamental input is unavailable; it does not become a negative score.
      </p>
    </Region>
  </ArticleFrame>
);

export const PORTFOLIO_CONSTRUCTION_SECTIONS = [
  ['overview', 'Overview'],
  ['exposure-measures', 'Exposure measures'],
  ['construction-sequence', 'Construction sequence'],
  ['correlation-review', 'Correlation review'],
  ['limits', 'Limits and remediation'],
];

const PortfolioConstructionArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="overview" label="Overview" editor={editor}>
      <h2>Overview</h2>
      <p>
        Portfolio construction is the final aggregation step. It asks whether individually qualified securities can
        coexist without creating an unacceptable concentration or exposure.
      </p>
    </Region>
    <Region id="exposure-measures" label="Exposure measures" editor={editor}>
      <h2>Exposure measures</h2>
      <p className="wp-equation"><code>gross = long market value + absolute(short market value)</code></p>
      <p className="wp-equation"><code>net = long market value − absolute(short market value)</code></p>
      <p>
        Review cash, currency, asset class, sector, factor, issuer, and sleeve exposures using attributable account
        and position data.
      </p>
    </Region>
    <Region id="construction-sequence" label="Construction sequence" editor={editor}>
      <h2>Construction sequence</h2>
      <p>
        Evaluate security-level eligibility and sizing before aggregate effects. Portfolio review may reduce or reject
        a candidate; it may not increase the security above its calculated MAX or repair missing security data.
      </p>
    </Region>
    <Region id="correlation-review" label="Correlation review" editor={editor}>
      <h2>Correlation review</h2>
      <p>
        Portfolio correlation uses aligned daily returns rather than the USD table's trending price-level method:
        <code> ρ(x,y) = cov(x,y) / (σx × σy)</code>. Review both direct holdings and shared exposures such as USD,
        equity beta, rates, commodities, and volatility.
      </p>
      <p>
        Two securities with different tickers can still be the same portfolio risk. That is why the second candidate
        can be reduced or rejected even when its individual score is attractive.
      </p>
    </Region>
    <Region id="limits" label="Limits and remediation" editor={editor}>
      <h2>Limits and remediation</h2>
      <p>
        The dashboard reports gross, net, cash, sleeve, issuer, sector, asset-class, factor, correlation, and
        liquidity measures. Any binding threshold must define its calculation basis, hierarchy, breach behavior,
        exceptions, and treatment of derivatives and short exposure.
      </p>
    </Region>
  </ArticleFrame>
);

export const DATA_CONTROLS_AND_EXECUTION_SECTIONS = [
  ['purpose', 'Purpose'],
  ['research-data', 'Research data'],
  ['live-data-gate', 'Live-data gate'],
  ['output', 'Output'],
  ['failure-behavior', 'Failure behavior'],
];

const DataControlsAndExecutionArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="purpose" label="Purpose" editor={editor}>
      <h2>Purpose</h2>
      <p>
        This Method separates research evidence from data that can support actionable dollar and share calculations.
        It defines the fail-closed boundary for unavailable or unverified inputs.
      </p>
    </Region>
    <Region id="research-data" label="Research data" editor={editor}>
      <h2>Research data</h2>
      <p>
        Signals, ranges, beta, ATR, records, macro observations, fundamental data, and portfolio analytics retain
        source, as-of time, observation count where applicable, quality state, and method version.
      </p>
    </Region>
    <Region id="live-data-gate" label="Live-data gate" editor={editor}>
      <h2>Live-data gate</h2>
      <p>
        Actionable dollars and quantity require a fresh, connected, verified IBKR spot price and net liquidation
        value, supported instrument metadata, and dated research provenance.
      </p>
    </Region>
    <Region id="output" label="Output" editor={editor}>
      <h2>Output</h2>
      <p>
        Outputs are read-only. Research may include a non-executable target weight, but share quantity remains
        unavailable until the live-data gate passes.
      </p>
    </Region>
    <Region id="failure-behavior" label="Failure behavior" editor={editor}>
      <h2>Failure behavior</h2>
      <p>
        Offline, delayed, frozen, stale, cached, mock, seeded, synthetic, inferred, fallback, or portfolio-derived
        substitutes cannot authorize action. The interface states the blocker without replacing the missing value or
        reporting a false negative signal.
      </p>
    </Region>
  </ArticleFrame>
);

export const VALIDATION_AND_CHANGE_CONTROL_SECTIONS = [
  ['validation', 'Validation'],
  ['shadow-mode', 'Shadow mode'],
  ['change-control', 'Change control'],
];

const ValidationAndChangeControlArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="validation" label="Validation" editor={editor}>
      <h2>Validation</h2>
      <p>
        Deterministic Methods require tests for formulas, boundaries, precedence, missing data, and provenance.
        Document examples should come from the same production calculation used by the dashboard when an engine
        exists. Interface checks cover routing, accessibility, responsive layout, and printing.
      </p>
    </Region>
    <Region id="shadow-mode" label="Shadow mode" editor={editor}>
      <h2>Shadow mode</h2>
      <p>
        New recommendation logic can run read-only before it is treated as an operational recommendation. Results,
        blockers, input versions, and subsequent outcomes are retained for review; no order is transmitted.
      </p>
    </Region>
    <Region id="change-control" label="Change control" editor={editor}>
      <h2>Change control</h2>
      <p>
        A rule change identifies its owner, effective date, dependencies, migration effect, and tests. Historical
        evaluations retain the Method used at the time.
      </p>
    </Region>
  </ArticleFrame>
);

export const PROCESS_LIBRARY_ARTICLES = {
  'methods-index': { sections: METHODS_SECTIONS, component: MethodsArticle },
  'signals-and-risk-ranges': {
    sections: SIGNALS_AND_RISK_RANGES_SECTIONS,
    component: SignalsAndRiskRangesArticle,
  },
  'stops-exits-and-reversals': {
    sections: STOPS_EXITS_AND_REVERSALS_SECTIONS,
    component: StopsExitsAndReversalsArticle,
  },
  'macro-regime-and-quad-overlay': {
    sections: QUAD_FRAMEWORK_SECTIONS,
    component: QuadFrameworkArticle,
  },
  'security-selection-and-pods': {
    sections: SECURITY_SELECTION_AND_PODS_SECTIONS,
    component: SecuritySelectionAndPodsArticle,
  },
  'portfolio-construction-and-diversification': {
    sections: PORTFOLIO_CONSTRUCTION_SECTIONS,
    component: PortfolioConstructionArticle,
  },
  'data-controls-and-execution': {
    sections: DATA_CONTROLS_AND_EXECUTION_SECTIONS,
    component: DataControlsAndExecutionArticle,
  },
  'validation-and-change-control': {
    sections: VALIDATION_AND_CHANGE_CONTROL_SECTIONS,
    component: ValidationAndChangeControlArticle,
  },
};

const getMethodChapterSections = (methodId) => {
  if (methodId === 'position-sizing') return POSITION_SIZING_SECTIONS;
  return PROCESS_LIBRARY_ARTICLES[methodId]?.sections || [];
};

export const getMethodsReaderEditableRegions = () => [
  ...METHODS_SECTIONS.map(([sectionId]) => sectionId),
  ...PROCESS_METHOD_IDS.flatMap((methodId) => (
    methodId === 'position-sizing'
      ? []
      : getMethodChapterSections(methodId).map(([sectionId]) => getMethodSectionId(methodId, sectionId))
  )),
  getMethodSectionId('position-sizing', 'document-body'),
];

export const METHOD_DOCUMENT_IDS = PROCESS_METHOD_IDS;

export const PROCESS_LIBRARY_RENDERERS = Object.fromEntries(
  Object.entries(PROCESS_LIBRARY_ARTICLES).map(([documentId, definition]) => [
    documentId,
    {
      sections: documentId === 'methods-index' ? METHODS_READER_SECTIONS : definition.sections,
      editableRegions: documentId === 'methods-index'
        ? getMethodsReaderEditableRegions()
        : definition.sections,
      render: (document, editor) => {
        const Article = definition.component;
        return <Article document={document} editor={editor} />;
      },
    },
  ]),
);

export const ProcessLibraryArticle = ({ document: documentProp, documentId, editor }) => {
  const document = documentProp || getProcessDocument(documentId);
  const definition = document ? PROCESS_LIBRARY_ARTICLES[document.id] : null;
  if (!document || !definition) {
    throw new Error('Unknown Process library article: ' + (documentId || documentProp?.id || '<missing>'));
  }
  const Article = definition.component;
  return <Article document={document} editor={editor} />;
};

export default ProcessLibraryArticle;
