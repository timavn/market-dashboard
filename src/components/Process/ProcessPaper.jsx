import React, {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  getProcessDocument,
  getProcessMethodDocuments,
} from '../../constants/processDocuments';
import { useSurfaceActivity } from '../common/PersistentSurface';

export const PROCESS_SECTIONS = [
  ['strategy-overview', 'Strategy Overview'],
  ['dollar-and-cross-asset-context', '1. Dollar and Cross-Asset Context'],
  ['volatility', '2. Volatility'],
  ['interest-rates', '3. Interest Rates'],
  ['quads-and-expected-value', '4. Quads and Expected Value'],
  ['candidate-qualification', '5. Candidate Qualification'],
  ['quantitative-selection-and-timing', '6. Quantitative Selection and Timing'],
  ['fundamental-qualification', '7. Fundamental Qualification'],
  ['portfolio-decision', '8. Portfolio Decision'],
  ['methods', 'Methods'],
];

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

const PROCESS_TERM_DEFINITIONS = {
  quad: {
    definition: 'One of four macro regimes built from the direction of growth and inflation. A Quad organizes which assets may have favorable or unfavorable conditions; it is a regime label, not a guarantee.',
    example: 'If growth is accelerating and inflation is falling, the process starts with the assets that historically fit that combination, then checks the rest of the gates.',
  },
  'expected value': {
    definition: 'An estimate of the average outcome after possible outcomes are weighted by their probabilities. Positive expected value means favorable on average, not certain on every attempt.',
    example: 'A 60% chance of gaining 10% and a 40% chance of losing 5% has an expected value of +4%.',
  },
  long: {
    definition: 'A position that benefits when the asset price rises. In the simplest case, the investor owns the asset and hopes to sell it later at a higher price.',
  },
  short: {
    definition: 'A position that benefits when the asset price falls, usually through borrowing the asset or using a derivative. The Process treats a short as a separate direction, not just a failed long.',
  },
  correlation: {
    definition: 'A measure of how two assets have moved in relation to each other. +1 means they have tended to move together, -1 means in opposite directions, and 0 means no consistent linear relationship.',
    example: 'A USD/SPX correlation near -0.9 means stocks and the dollar have recently moved almost opposite each other; it does not prove that one causes the other.',
  },
  'realized volatility': {
    definition: 'How much prices actually moved over a past period, calculated from historical returns. It describes observed movement, not a forecast.',
  },
  'implied volatility': {
    definition: 'The amount of future movement implied by option prices. It reflects expectations and demand for protection, so it is not a promise that the move will occur.',
  },
  'volatility-of-volatility': {
    definition: 'How quickly volatility itself is changing. Rising volatility-of-volatility means the risk environment is becoming less stable, even if the underlying price has not moved much yet.',
  },
  'front end': {
    definition: 'The short-maturity part of the interest-rate curve, usually represented by maturities such as two years or less. It is especially sensitive to expected central-bank policy.',
  },
  'curve spread': {
    definition: 'The difference between yields at two maturities, such as the ten-year yield minus the two-year yield. Its direction helps show how investors view future growth, inflation, and policy.',
  },
  yield: {
    definition: 'The income or interest rate an investment provides relative to its price. For a bond, the quoted yield helps describe the return implied by its current price and payments.',
  },
  reflationary: {
    definition: 'Describes an environment in which economic growth is recovering and inflation is moving higher from weak levels. Different assets respond differently to that combination.',
  },
  duration: {
    definition: 'A measure of how sensitive a bond or bond fund is to changes in interest rates. Longer-duration investments usually move more when yields change.',
  },
  'rate of change': {
    definition: 'How quickly a number is changing from one period to the next, usually shown as a percentage. The level tells you where the business is; the rate of change tells you whether it is speeding up or slowing down.',
    example: 'Revenue rising from $100 million to $110 million is +10%. If it then rises to $115 million, growth is still positive but has slowed to about +4.5%.',
  },
  'macro qualification gate': {
    definition: 'A pass/fail check that the broad market environment supports the proposed long or short direction before the process spends time on one security.',
    example: 'A favorable Quad cannot rescue an equity long when the dollar, rates, or volatility are directly contradicting it.',
  },
  pvv: {
    definition: 'Price, Volume, and Volatility. In this Process, PVV is a published model output that supplies a low and high risk range for the security.',
  },
  'lrr–hrr': {
    definition: 'The published Low Risk Range and High Risk Range endpoints. Together they define the current interval in which the Process evaluates price location.',
    example: 'If LRR is $90 and HRR is $110, a long is considered in the favorable half at prices from $90 through $100.',
  },
  trade: {
    definition: 'The independently published short-duration direction signal, covering three weeks or less. It must agree with Trend before a new position can be opened.',
  },
  trend: {
    definition: 'The independently published longer-duration direction signal, covering three months or more. It provides the slower context that Trade must agree with.',
  },
  'entry location': {
    definition: 'Where the current price sits inside the published risk range. It answers whether the price is in a favorable half for a new long or short; it does not create direction by itself.',
  },
  'record extension': {
    definition: 'A current published range reaches beyond a prior traded-price high or low. It can strengthen an already eligible setup, but it cannot create direction on its own.',
  },
  'fixed income': {
    definition: 'Investments that are designed to pay interest or other scheduled cash flows, such as government or corporate bonds. Their prices often react to changes in interest rates.',
  },
  'oversold': {
    definition: 'A description for a price that has fallen sharply or sits near the weak end of a recent range. Oversold means stretched; it does not prove the asset is cheap or due to rebound.',
  },
  'cash flow': {
    definition: 'The actual cash entering and leaving a business. It can differ from accounting earnings because earnings include timing rules and non-cash items.',
  },
  'capital allocation': {
    definition: 'How management decides to use the cash a business generates, such as reinvesting in operations, buying another company, paying down debt, or returning cash to shareholders.',
  },
  pod: {
    definition: 'A group of related fundamental measures reviewed together. The Pods keep revenue, profitability or cash generation, and business quality from being reduced to one isolated number.',
  },
  comps: {
    definition: 'Short for comparables: a comparison with similar companies or with the same company in an earlier period. Comps show whether a result is strong relative to a fair reference, not just whether it is positive in isolation.',
    example: 'A retailer growing sales 10% looks stronger if similar retailers grew 3%, and weaker if they grew 20%.',
  },
  'comparison base': {
    definition: 'The earlier period or reference group used as the starting point for a comparison. For year-over-year revenue growth, the same quarter last year is the comparison base.',
    example: '$110 million this quarter compared with a $100 million base last year equals 10% growth: (110 ÷ 100) − 1.',
  },
  'easy base': {
    definition: 'A low or unusually weak prior result. Growing from an easy base can make the current percentage growth look impressive even when the underlying improvement is more ordinary.',
    example: 'Revenue recovering from $50 million to $60 million is +20%, but that percentage partly reflects how low the prior base was.',
  },
  'demanding base': {
    definition: 'A high or unusually strong prior result. A demanding base can make current percentage growth look slower even when the business is still healthy.',
    example: 'Revenue growing from $100 million to $105 million is only +5%, but that can still be a good result if last year was unusually strong.',
  },
  ebitda: {
    definition: 'Earnings before interest, taxes, depreciation, and amortization. It is a rough measure of operating profitability before financing, taxes, and certain accounting charges; it is not the same as cash flow.',
  },
  roic: {
    definition: 'Return on invested capital: operating profit after tax compared with the capital used to run the business. It helps show how efficiently the business turns invested money into operating returns.',
  },
  beta: {
    definition: 'A measure of how sensitive a security has been to broad-market moves. A beta near 1 has tended to move roughly with the market; a beta near 2 has tended to move about twice as much, with plenty of noise around the estimate.',
  },
  atr: {
    definition: 'Average True Range, a measure of a security\'s typical price movement. Here it is a maximum-position backstop, not a hard-stop or automatic exit rule.',
  },
  conviction: {
    definition: 'The strength of the qualifying evidence inside the allowed position-sizing band. Conviction helps choose the target size; it is not a claim of certainty.',
  },
  'position sizing': {
    definition: 'The amount of capital or risk assigned to a security. Good sizing controls how much one correct or incorrect idea can affect the portfolio.',
  },
  'min–max band': {
    definition: 'The permitted position-size range: MIN is the starting allocation after the gates pass, and MAX is the upper boundary after risk limits are applied.',
  },
  'asset class': {
    definition: 'A broad category of investments that tends to share common behavior, such as equities, bonds, commodities, or currencies.',
  },
  factor: {
    definition: 'A measurable characteristic shared by a group of securities, such as growth, value, size, leverage, or momentum. Factor exposure can create hidden overlap between different tickers.',
  },
  sleeve: {
    definition: 'A portfolio bucket managed as a group, such as equities, macro trades, or a sector allocation. Sleeve limits help prevent one theme from dominating the portfolio.',
  },
  'gross exposure': {
    definition: 'The total size of long and short positions counted in absolute terms. A portfolio with $60 long and $40 short has $100 of gross exposure.',
  },
  'net exposure': {
    definition: 'Long exposure minus short exposure. A portfolio with $60 long and $40 short has $20 of net long exposure.',
  },
  concentration: {
    definition: 'How much of the portfolio\'s risk or capital is clustered in one security, sector, asset class, factor, or theme.',
  },
};

const ProcessTermDefinition = ({ term, children }) => {
  const surfaceActive = useSurfaceActivity();
  const details = PROCESS_TERM_DEFINITIONS[term.toLowerCase()];
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const generatedId = useId();
  const popoverId = `process-term-definition-${generatedId.replace(/:/g, '')}`;

  useEffect(() => {
    if (!isOpen || !surfaceActive) return undefined;

    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, surfaceActive]);

  if (!details) return children || term;

  return (
    <span className="process-term-definition" ref={containerRef}>
      <button
        type="button"
        className="process-term-definition__link"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        title="Click for a plain-language definition"
        onClick={() => setIsOpen((open) => !open)}
      >
        {children || term}
      </button>
      {isOpen && (
        <span
          id={popoverId}
          className="process-term-definition__popover"
          role="dialog"
          aria-label={`${term} definition`}
        >
          <span className="process-term-definition__header">
            <strong>{term}</strong>
            <button
              type="button"
              className="process-term-definition__close"
              aria-label={`Close ${term} definition`}
              onClick={() => setIsOpen(false)}
            >
              ×
            </button>
          </span>
          <span className="process-term-definition__body">{details.definition}</span>
          {details.example && (
            <span className="process-term-definition__example">
              <strong>Example.</strong> {details.example}
            </span>
          )}
        </span>
      )}
    </span>
  );
};

const EditableSection = React.memo(({
  as: Element = 'section',
  id,
  label,
  className,
  dataTestId,
  editor,
  children,
}) => {
  const isEditing = Boolean(editor?.isEditing);
  const hasHtmlOverride = Object.prototype.hasOwnProperty.call(editor?.regions || {}, id);
  const content = hasHtmlOverride
    ? { dangerouslySetInnerHTML: { __html: editor.regions[id] } }
    : { children };

  return (
    <Element
      id={id}
      className={className}
      data-testid={dataTestId}
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

EditableSection.displayName = 'EditableSection';

const ProcessPaper = ({ document, editor }) => {
  const metadata = document || getProcessDocument('the-process');
  const methods = getProcessMethodDocuments();

  return (
    <article
      className={'wp-paper white-paper__document process-paper' + (editor?.isEditing ? ' is-editing' : '')}
      data-testid="process-document"
      aria-label={metadata.title}
    >
      <EditableSection
        as="header"
        id="title-page"
        label="Title page"
        className="wp-paper__title white-paper__title-page"
        editor={editor}
      >
        <h1 id="process-paper-title">{metadata.title}</h1>
        <p>{metadata.subtitle}</p>
      </EditableSection>

      <EditableSection
        id="strategy-overview"
        label="Strategy Overview"
        className="wp-abstract white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
        <p>
          <strong>Strategy overview.</strong> The process moves from the broadest market condition to the individual
          security and then back to portfolio risk: start with the dollar, test volatility and interest rates, classify
          the current <ProcessTermDefinition term="Quad">Quad</ProcessTermDefinition>, and use the Quad&apos;s positive
          and negative <ProcessTermDefinition term="expected value">expected values</ProcessTermDefinition> to create{' '}
          <ProcessTermDefinition term="long">long</ProcessTermDefinition> and{' '}
          <ProcessTermDefinition term="short">short</ProcessTermDefinition> candidates. Those candidates must survive the cross-asset read, quantitative timing signals, and entry
          location before bottom-up fundamentals qualify the security. The final decision combines the evidence with
          portfolio exposure and <ProcessTermDefinition term="position sizing">position-sizing</ProcessTermDefinition> limits. Quantitative analysis narrows the field; fundamental analysis
          explains whether the security deserves to remain in it.
        </p>
      </EditableSection>

      <EditableSection
        id="dollar-and-cross-asset-context"
        label="Dollar and Cross-Asset Context"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
        <h2>1. Dollar and Cross-Asset Context</h2>
        <p>
          The dollar is the first anchor because its direction changes the pressure applied to many other assets.
          Read USD strength and trend, then compare it with equities, gold, commodities, and other currencies. The
          <ProcessTermDefinition term="correlation">correlation</ProcessTermDefinition> is not a permanent rule; it is a current observation that must be checked across more than one
          horizon and against the direction of the underlying prices.
        </p>
        <ul>
          <li>Is the dollar strengthening, weakening, or changing character?</li>
          <li>Which assets are moving with it and which are moving against it?</li>
          <li>Are those relationships stable enough to support a trade, or are they breaking down?</li>
        </ul>
        <p>
          <strong>Example.</strong> If the dollar is strengthening while gold and foreign currencies weaken, the
          process begins by treating dollar-sensitive longs with caution and looking for opportunities that benefit
          from dollar strength. A candidate is not selected from its chart in isolation.
        </p>
      </EditableSection>

      <EditableSection
        id="volatility"
        label="Volatility"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>2. Volatility</h2>
          <p>
            Next, determine whether risk is expanding, contracting, or moving from one asset class to another. Compare
            <ProcessTermDefinition term="realized volatility">realized volatility</ProcessTermDefinition> with
            <ProcessTermDefinition term="implied volatility">implied volatility</ProcessTermDefinition>, watch
            <ProcessTermDefinition term="volatility-of-volatility">volatility-of-volatility</ProcessTermDefinition>, and observe whether probable ranges are widening or narrowing. This step changes how much
            <ProcessTermDefinition term="conviction">conviction</ProcessTermDefinition> the rest of the process can carry.
          </p>
        <table className="wp-table white-paper__table">
          <thead>
            <tr><th>Read</th><th>What it tells us</th><th>Process effect</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <ProcessTermDefinition term="realized volatility">Realized</ProcessTermDefinition> versus{' '}
                <ProcessTermDefinition term="implied volatility">implied volatility</ProcessTermDefinition>
              </td>
              <td>Whether expected movement is running ahead of or behind actual movement.</td>
              <td>Separate opportunity from post-move hedging or complacency.</td>
            </tr>
            <tr>
              <td>Volatility-of-volatility</td>
              <td>Whether the volatility regime itself is accelerating or calming.</td>
              <td>Expect wider or narrower risk ranges.</td>
            </tr>
            <tr>
              <td>Cross-asset volatility</td>
              <td>Whether stress is isolated or spreading.</td>
              <td>Reduce the willingness to add correlated risk when stress spreads.</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Example.</strong> A bullish equity setup with falling realized volatility and narrowing ranges can
          continue to the next step. The same setup with rapidly rising volatility and widening ranges is not
          automatically bearish, but it must clear a stricter qualification and sizing decision.
        </p>
      </EditableSection>

      <EditableSection
        id="interest-rates"
        label="Interest Rates"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>3. Interest Rates</h2>
          <p>
            Interest rates connect the macro read to policy, growth, and inflation. Read the{' '}
            <ProcessTermDefinition term="front end">front end</ProcessTermDefinition>, especially the{' '}
            <ProcessTermDefinition term="yield">two-year yield</ProcessTermDefinition>, alongside the ten-year yield and the{' '}
            <ProcessTermDefinition term="curve spread">curve spread</ProcessTermDefinition>.
            The question is not whether a single rate is high or low; it is whether the direction and{' '}
            <ProcessTermDefinition term="rate of change">rate of change</ProcessTermDefinition> confirm or contradict
            the dollar, volatility, and expected Quad.
        </p>
        <p>
          <strong>Example.</strong> If a <ProcessTermDefinition term="reflationary">reflationary</ProcessTermDefinition>{' '}
          equity candidate requires falling rates but the two-year and
          ten-year yields are both breaking higher with a widening inflation-sensitive curve, the candidate fails the
          macro check until the rate move is understood.
        </p>
      </EditableSection>

      <EditableSection
        id="quads-and-expected-value"
        label="Quads and Expected Value"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>4. Quads and Expected Value</h2>
          <p>
            Growth, inflation, and policy are translated into a <ProcessTermDefinition term="Quad">Quad</ProcessTermDefinition>{' '}
            using their direction and <ProcessTermDefinition term="rate of change">rate of change</ProcessTermDefinition>.
            Monthly and quarterly views show the current regime and the likely transition. Each Quad supplies a relative
            <ProcessTermDefinition term="expected value">expected value</ProcessTermDefinition> map: asset classes,
            sectors, factors, and <ProcessTermDefinition term="fixed income">fixed-income</ProcessTermDefinition> groups with
            positive or negative expected outcomes.
        </p>
        <table className="wp-table white-paper__table">
          <thead>
            <tr><th>Quad output</th><th>Use in the process</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Positive <ProcessTermDefinition term="expected value">expected value</ProcessTermDefinition></td>
              <td>Generate the first list of long candidates and preferred exposures.</td>
            </tr>
            <tr>
              <td>Negative <ProcessTermDefinition term="expected value">expected value</ProcessTermDefinition></td>
              <td>Generate the first list of short candidates or exposures to avoid.</td>
            </tr>
            <tr>
              <td>Probability-weighted value</td>
              <td>Rank candidates when more than one Quad remains plausible.</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Example.</strong> In a Quad where equities and credit carry positive expected value while long{' '}
          <ProcessTermDefinition term="duration">duration</ProcessTermDefinition> and the dollar carry negative expected value, the process starts with equity/credit longs and
          duration/USD shorts. That is a candidate map, not a buy list.
        </p>
      </EditableSection>

      <EditableSection
        id="candidate-qualification"
        label="Candidate Qualification"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>5. Candidate Qualification</h2>
          <p>
            Combine the Quad candidate map with the dollar, volatility, rates, and{' '}
            <ProcessTermDefinition term="correlation">correlation</ProcessTermDefinition> observations. A candidate
            must agree with the cross-asset context before it advances to security-level work. A conflict is a hard
            qualification failure for the proposed direction; it is not hidden inside a discretionary score.
        </p>
        <table className="wp-table white-paper__table wp-table--lifecycle">
          <thead>
            <tr><th>Candidate state</th><th>Decision</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Quad and cross-asset context agree</td>
              <td>Advance to quantitative security selection.</td>
            </tr>
            <tr>
              <td>Quad is favorable but USD, rates, volatility, or correlation contradicts it</td>
              <td>Reject the proposed direction for now.</td>
            </tr>
            <tr>
              <td>Inputs are missing or relationships are unstable</td>
              <td>Keep the candidate on watch; do not manufacture a conclusion.</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Example.</strong> Suppose equities are positive expected value in the current Quad, SPX is rising,
          the dollar is falling, and the observed USD/SPX correlation is approximately -0.9. The{' '}
          <ProcessTermDefinition term="correlation">correlation</ProcessTermDefinition> explains the current move but
          also shows that the equity strength depends on the dollar condition continuing. We do not buy the long: it
          fails the <ProcessTermDefinition term="macro qualification gate">macro qualification gate</ProcessTermDefinition>{' '}
          even though the Quad label and price action look bullish.
        </p>
      </EditableSection>

      <EditableSection
        id="quantitative-selection-and-timing"
        label="Quantitative Selection and Timing"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>6. Quantitative Selection and Timing</h2>
          <p>
            Once the macro candidate survives, the process moves down to the security. Use price, volume, volatility,
            <ProcessTermDefinition term="PVV">PVV</ProcessTermDefinition>&apos;s published{' '}
            <ProcessTermDefinition term="LRR–HRR">LRR–HRR range</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="Trade">Trade</ProcessTermDefinition>, and{' '}
            <ProcessTermDefinition term="Trend">Trend</ProcessTermDefinition> to decide whether the security is actually
            actionable. Trade and Trend must independently support the same side. A long can open or add only in the
            lower half of the range; a short can open or add only in the upper half.
          </p>
          <ul>
            <li>Aligned bullish Trade and Trend create long eligibility, subject to{' '}
              <ProcessTermDefinition term="entry location">entry location</ProcessTermDefinition>.</li>
            <li>Aligned bearish Trade and Trend create short eligibility, subject to{' '}
              <ProcessTermDefinition term="entry location">entry location</ProcessTermDefinition>.</li>
            <li>Conflicting, neutral, or missing signals do not create a new position.</li>
            <li>Range structure and <ProcessTermDefinition term="record extension">record extension</ProcessTermDefinition>{' '}
              strengthen an eligible setup but do not create direction alone.</li>
          </ul>
          <p>
          <strong>Examples.</strong> A long candidate with bullish Trade and Trend near the lower half of LRR–HRR can
            proceed to fundamental review. A short candidate with bearish Trade and Trend near the upper half can do the
            same. A bullish candidate already trading above the favorable <ProcessTermDefinition term="entry location">entry
            half</ProcessTermDefinition> waits rather than chases. A candidate that is{' '}
          <ProcessTermDefinition term="oversold">oversold</ProcessTermDefinition> is not automatically eligible.
        </p>
      </EditableSection>

      <EditableSection
        id="fundamental-qualification"
        label="Fundamental Qualification"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>7. Fundamental Qualification</h2>
          <p>
            Fundamental analysis now moves back up from the security to the business. The{' '}
            <ProcessTermDefinition term="Pod">Pods</ProcessTermDefinition> organize company evidence by{' '}
            <ProcessTermDefinition term="rate of change">rate of change</ProcessTermDefinition> rather than by an
            isolated valuation story. The purpose is to identify whether the quantitative candidate has improving or
            deteriorating business fundamentals that can support the direction.
          </p>
          <p>
            <strong>How comparisons work.</strong>{' '}
            <ProcessTermDefinition term="comps">Comps</ProcessTermDefinition> compare a current result with a similar
            company or with the same company in an earlier period. The reference point is the{' '}
            <ProcessTermDefinition term="comparison base">comparison base</ProcessTermDefinition>. An{' '}
            <ProcessTermDefinition term="easy base">easy base</ProcessTermDefinition> can mechanically make growth look
            unusually strong, while a <ProcessTermDefinition term="demanding base">demanding base</ProcessTermDefinition>{' '}
            can make healthy growth look slower. That is why the Process reads both the current level and the change in
            the growth rate.
          </p>
          <table className="wp-table white-paper__table">
          <thead>
            <tr><th>Pod</th><th>Evidence</th><th>Long read</th><th>Short read</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><ProcessTermDefinition term="Pod">Pod 1</ProcessTermDefinition></td>
              <td>Revenue growth and its <ProcessTermDefinition term="rate of change">rate of change</ProcessTermDefinition>.</td>
              <td>Growth is accelerating, or the <ProcessTermDefinition term="comparison base">comparison base</ProcessTermDefinition> is becoming easier.</td>
              <td>Growth is slowing, especially against a still-<ProcessTermDefinition term="demanding base">demanding base</ProcessTermDefinition>.</td>
            </tr>
            <tr>
              <td><ProcessTermDefinition term="Pod">Pod 2</ProcessTermDefinition></td>
              <td><ProcessTermDefinition term="EBITDA">EBITDA</ProcessTermDefinition>, earnings, or{' '}
                <ProcessTermDefinition term="cash flow">cash flow</ProcessTermDefinition> growth and its{' '}
                <ProcessTermDefinition term="rate of change">rate of change</ProcessTermDefinition>.</td>
              <td>Profitability or cash generation is accelerating with revenue.</td>
              <td>Profitability or cash generation is slowing with revenue.</td>
            </tr>
            <tr>
              <td><ProcessTermDefinition term="Pod">Pod 3</ProcessTermDefinition></td>
              <td>Free cash flow, <ProcessTermDefinition term="ROIC">ROIC</ProcessTermDefinition>, and{' '}
                <ProcessTermDefinition term="capital allocation">capital allocation</ProcessTermDefinition>.</td>
              <td>Returns and capital allocation reinforce the operating trend.</td>
              <td>Weak returns, cash conversion, or allocation reinforce the short.</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Examples.</strong> A long candidate is stronger when revenue growth accelerates alongside earnings
          or cash-flow growth and Pod 3 confirms quality. A short candidate is stronger when Pods 1 and 2 slow
          together, even if the stock appears oversold. Fundamentals can reject a quantitative candidate; they do not
          override a failed macro gate.
        </p>
      </EditableSection>

      <EditableSection
        id="portfolio-decision"
        label="Portfolio Decision"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
          <h2>8. Portfolio Decision</h2>
          <p>
            A qualified security becomes a portfolio decision only after its risk and interaction with existing holdings
            are measured. <ProcessTermDefinition term="Beta">Beta</ProcessTermDefinition> establishes the initial{' '}
            <ProcessTermDefinition term="MIN–MAX band">MIN–MAX band</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="ATR">ATR</ProcessTermDefinition> can reduce MAX, and{' '}
            <ProcessTermDefinition term="conviction">conviction</ProcessTermDefinition> determines the target inside
            that band. Portfolio review then checks <ProcessTermDefinition term="gross exposure">gross exposure</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="net exposure">net exposure</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="sleeve">sleeve</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="asset class">asset class</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="factor">factor</ProcessTermDefinition>,{' '}
            <ProcessTermDefinition term="concentration">concentration</ProcessTermDefinition>, and correlation exposure.
        </p>
        <table className="wp-table white-paper__table wp-table--lifecycle">
          <thead>
            <tr><th>State</th><th>Portfolio action</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>All gates pass</td>
              <td>Open at MIN and move incrementally toward the calculated target.</td>
            </tr>
            <tr>
              <td>Portfolio overlap is too concentrated</td>
              <td>Reduce or reject the candidate; do not increase security-level MAX.</td>
            </tr>
            <tr>
              <td>Trend breaks while Trade holds</td>
              <td>Reduce an existing position to MIN.</td>
            </tr>
            <tr>
              <td>Trade breaks</td>
              <td>Exit the held side to zero.</td>
            </tr>
            <tr>
              <td>Required live data are unavailable</td>
              <td>Show the research result and blocker, but produce no executable dollars or quantity.</td>
            </tr>
          </tbody>
        </table>
        <p>
          <strong>Example.</strong> Two securities may each pass their individual tests but share the same dollar,
          equity, and volatility exposure. The second position is reduced or rejected because the portfolio is the
          unit of risk, not the ticker.
        </p>
      </EditableSection>

      <EditableSection
        id="methods"
        label="Methods"
        className="white-paper__chapter"
        dataTestId="process-paper-section"
        editor={editor}
      >
        <h2>Methods</h2>
        <p>
          The main Process explains the order of decisions. Methods are the final technical breakdown: each appendix
          states the inputs, equations, boundaries, examples, and data controls used to perform one part of the
          process.
        </p>
        <p><a href="#/process/methods">Open the Methods index</a></p>
        <ul>
          {methods.map((method) => (
            <li key={method.id}>
              <a href={`#/process/methods?section=method-${encodeURIComponent(method.id)}`}>{method.title}</a>
              <span> — {METHOD_PURPOSES[method.id] || 'Technical definitions and calculations.'}</span>
            </li>
          ))}
        </ul>
      </EditableSection>
    </article>
  );
};

export default ProcessPaper;
