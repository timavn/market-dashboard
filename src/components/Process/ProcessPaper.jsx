import React from 'react';
import { SIZING_CONSTANTS } from '../../utils/signalWeightedPositionSizing';
import { getProcessDocument } from '../../constants/processDocuments';

const sizing = SIZING_CONSTANTS;
const pct = (value, digits = 0) => `${Number(value).toFixed(digits)}%`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const formatAsOf = (date) => {
  const [year, month, day] = String(date || '').split('-').map(Number);
  return year && month && day ? `${day} ${MONTHS[month - 1]} ${year}` : String(date || '');
};

export const PROCESS_SECTIONS = [
  ['abstract', 'Abstract'],
  ['objective-and-scope', 'Objective and Scope'],
  ['decision-sequence', 'Decision Sequence'],
  ['inputs-and-data-controls', 'Inputs and Data Controls'],
  ['macro-regime-and-selection', 'Macro Regime and Security Selection'],
  ['signals-and-entry-location', 'Signals and Entry Location'],
  ['security-risk-and-sizing', 'Security-Level Risk and Position Sizing'],
  ['portfolio-construction', 'Portfolio Construction'],
  ['stops-exits-and-reversals', 'Stops, Exits, and Reversals'],
  ['execution-validation-and-limitations', 'Execution, Validation, and Limitations'],
];

const ProcessEquation = ({ number, label, children }) => (
  <div
    className="wp-equation white-paper__equation"
    role="math"
    aria-label={`${label}: ${children}. Equation ${number}.`}
  >
    <code>{children}</code>
    <span>({number})</span>
  </div>
);

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
      aria-label={isEditing ? `Edit ${label} section` : undefined}
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
  const positionSizing = getProcessDocument('position-sizing');
  const signals = getProcessDocument('signals-and-risk-ranges');
  const stops = getProcessDocument('stops-exits-and-reversals');
  const macro = getProcessDocument('macro-regime-and-quad-overlay');
  const portfolio = getProcessDocument('portfolio-construction-and-diversification');
  const pods = getProcessDocument('security-selection-and-pods');
  return (
  <article
    className={`wp-paper white-paper__document process-paper${editor?.isEditing ? ' is-editing' : ''}`}
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
      <p className="wp-paper__version">
        Version {metadata.version}&nbsp;&nbsp;|&nbsp;&nbsp;{metadata.status}&nbsp;&nbsp;|&nbsp;&nbsp;As of {formatAsOf(metadata.asOf)}
      </p>
    </EditableSection>

    <EditableSection
      id="abstract"
      label="Abstract"
      className="wp-abstract white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <p>
        <strong>Abstract.</strong> This paper defines the order in which investment and portfolio-management
        decisions are made. The framework is risk-first, supports long and short positions, and separates market
        context, security selection, directional eligibility, entry location, security-level sizing, portfolio
        constraints, and execution. Each stage has a defined output and may stop the sequence when required data are
        missing or the applicable rule is not satisfied. The process uses published Trade and Trend signals, Low
        Risk Range (LRR) and High Risk Range (HRR) values, security beta, average true range, and verified portfolio
        data. Trade is the short-duration signal with a horizon of three weeks or less. Trend is the longer-duration
        signal with a horizon of three months or more. Tail, the Quad overlay, portfolio-policy limits, and Pods do
        not yet have approved decision authority and therefore remain research or descriptive inputs.
      </p>
      <p>
        The framework produces read-only recommendations. It does not transmit, route, stage, or automatically
        execute orders. Any recommendation that includes dollars or share quantity requires fresh, verified spot and
        net liquidation value from Interactive Brokers (IBKR), together with complete instrument metadata. Research
        inputs remain visible when execution data are unavailable, but they cannot be converted into an actionable
        output. Exact mechanism rules are maintained in versioned technical notes. This master paper owns the overall
        sequence, the relationship among mechanisms, and their current policy status.
      </p>
    </EditableSection>

    <EditableSection
      id="objective-and-scope"
      label="Objective and Scope"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>1. Objective and Scope</h2>
      <p>
        The objective is to convert market and security evidence into a controlled, reconstructable portfolio
        decision. The process begins with data validity, then establishes context, identifies eligible securities,
        determines direction, evaluates price location, calculates a security-level weight, checks the portfolio, and
        defines the next incremental action. Each output records its source, as-of time, version, reasons, and blockers.
      </p>
      <p>
        Risk is addressed at distinct levels. Data controls prevent unsupported calculations. Directional rules
        control eligibility. LRR and HRR control where risk may be added. Beta and ATR define a security-level
        interval. Portfolio analytics identify aggregate exposure. Execution controls prevent stale or unverified
        values from producing quantity. Passing one stage does not override a failure at another.
      </p>
      <p>
        The framework is dynamic and side-neutral. A security may be eligible for a long position, a short position,
        or neither. The same sequence applies to both sides. The evidence required for a short is evaluated directly;
        it is not assumed to be the inverse of a long thesis. Position weights are expressed as absolute percentages
        of portfolio net liquidation value (NLV), while direction supplies the sign for exposure reporting.
      </p>
      <p>
        Version 0.1 covers the decision framework and approved position sizing. It does not establish portfolio-wide
        optimization, correlation or sector limits, a hard-stop formula, Tail authority, Quad-based eligibility, or
        automated execution. Those mechanisms require approved technical notes. One lifecycle applies to all
        positions; no Core, Tactical, asset-class, or account-specific exception is recognized.
      </p>

      <h3>1.1 Document authority</h3>
      <p>
        This paper is the canonical description of decision order and policy status. A technical note is canonical
        only for its named mechanism and stated version. Source notes, dashboard explanations, checklists, and
        principles do not create rules. When documents conflict, the approved rule owner in the registry controls;
        draft, research, descriptive, legacy, and deprecated material cannot override it.
      </p>
    </EditableSection>

    <EditableSection
      id="decision-sequence"
      label="Decision Sequence"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>2. Decision Sequence</h2>
      <p>
        The stages below are evaluated in order. A later stage may reduce or reject an earlier preliminary result,
        but it may not manufacture a missing input or relax an earlier requirement. The recorded result includes the
        latest completed stage and the reason the sequence stopped.
      </p>
      <table className="wp-table white-paper__table wp-table--lifecycle">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Question</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>1. Validate data</td>
            <td>Are required inputs complete, current, attributable, and suitable for their intended use?</td>
            <td>Validated research state; execution state enabled or disabled.</td>
          </tr>
          <tr>
            <td>2. Determine macro regime</td>
            <td>What growth and inflation conditions are currently observed or expected?</td>
            <td>Macro context and research rankings; no automatic position authority in version 0.1.</td>
          </tr>
          <tr>
            <td>3. Select eligible securities</td>
            <td>Which securities have a supported thesis, valid data, and suitable instrument representation?</td>
            <td>Research universe and candidate list.</td>
          </tr>
          <tr>
            <td>4. Establish directional eligibility</td>
            <td>Do independently published Trade and Trend signals support the same non-neutral side?</td>
            <td>Long eligible, short eligible, BENCH, EXIT, or no executable state.</td>
          </tr>
          <tr>
            <td>5. Evaluate entry location</td>
            <td>Is spot in the favorable half of the current LRR-HRR interval?</td>
            <td>Open/add permitted or denied; research state remains visible.</td>
          </tr>
          <tr>
            <td>6. Calculate security weight</td>
            <td>What MIN, MAX, and evidence-weighted target apply to this security?</td>
            <td>Security target and permitted incremental change.</td>
          </tr>
          <tr>
            <td>7. Apply portfolio constraints</td>
            <td>How would the position affect gross, net, cash, sleeve, and concentration exposures?</td>
            <td>Descriptive portfolio impact; approved constraints when available.</td>
          </tr>
          <tr>
            <td>8. Execute incrementally and review</td>
            <td>Do live inputs support a quantity, and what is the next allowed action?</td>
            <td>Read-only open, add, trim, hold, bench, exit, or no-action recommendation.</td>
          </tr>
        </tbody>
      </table>
      <p>
        A candidate is not a position recommendation merely because it appears in the research universe. Directional
        eligibility, entry location, sizing, portfolio review, and execution validation remain separate decisions.
        Similarly, a computed target is not an instruction to move immediately to that weight. New positions begin at
        MIN, normal changes are incremental, and risk-reducing signal changes bypass the normal step schedule.
      </p>

      <h3>2.1 Decision records</h3>
      <p>
        A production evaluation record must retain the security identifier, side, current position, input snapshot, rule versions,
        preliminary target, portfolio context, lifecycle state, read-only action, blockers, and evaluation time.
        Re-evaluation creates a new record so the original information can be compared with later outcomes.
      </p>
    </EditableSection>

    <EditableSection
      id="inputs-and-data-controls"
      label="Inputs and Data Controls"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>3. Inputs and Data Controls</h2>
      <p>
        Inputs are classified by purpose because freshness requirements differ. Research inputs are valid as of their
        edition; historical calculations use completed bars and dated series. Execution inputs must be live, verified,
        and bound to the evaluation. A current research edition does not make a delayed quote actionable, and a live
        quote does not repair missing signal or range history.
      </p>
      <table className="wp-table white-paper__table">
        <thead>
          <tr>
            <th>Input group</th>
            <th>Required condition</th>
            <th>Authority in version 0.1</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Trade and Trend</td>
            <td>Independent published directions with edition and source.</td>
            <td>Required for directional lifecycle decisions.</td>
          </tr>
          <tr>
            <td>LRR and HRR</td>
            <td>Current valid endpoints with LRR below HRR; historical editions paginated for structure.</td>
            <td>Required for entry location and sizing strength.</td>
          </tr>
          <tr>
            <td>Beta and price history</td>
            <td>Adjusted security and SPY daily returns; 252-session target and at least 126 aligned observations.</td>
            <td>Required for the beta-derived sizing band.</td>
          </tr>
          <tr>
            <td>ATR(14)</td>
            <td>Completed daily OHLC observations with dated provenance.</td>
            <td>Required volatility backstop on security MAX.</td>
          </tr>
          <tr>
            <td>Record history</td>
            <td>Maximum available traded-price history strictly before the current range edition.</td>
            <td>Optional strength input; unavailable contributes zero, not a negative signal.</td>
          </tr>
          <tr>
            <td>Macro and Quad data</td>
            <td>Dated growth, inflation, and expected-value inputs with stated transformation.</td>
            <td>Research context; no approved gate or size modifier.</td>
          </tr>
          <tr>
            <td>Portfolio state</td>
            <td>Positions, cash, NLV, contract metadata, and account source.</td>
            <td>Descriptive analytics; NLV is required for executable dollars.</td>
          </tr>
          <tr>
            <td>Spot and instrument data</td>
            <td>Fresh verified IBKR quote, multiplier, lot size, currency, and tradability.</td>
            <td>Required for actionable dollars and quantity.</td>
          </tr>
        </tbody>
      </table>

      <h3>3.1 Provenance and freshness</h3>
      <p>
        Every input records source, observation count where applicable, as-of time, retrieval time, and quality status.
        Derived values record the method version and input dates. Beta uses adjacent adjusted returns aligned by
        completed session; ATR uses completed daily bars. ATH and ATL tests exclude observations on or after the
        current range edition.
      </p>
      <p>
        Disconnected, delayed, frozen, stale, cached, mock, seeded, synthetic, inferred, fallback, or
        portfolio-derived substitutes cannot support an executable action. They may be displayed when clearly labeled
        for research, but the resulting action and share quantity remain unavailable. The same fail-closed rule
        applies if evaluation time is absent, source status is ambiguous, or the quote and account summary cannot be
        linked to the inputs used in the calculation.
      </p>

      <h3>3.2 Missing data</h3>
      <p>
        Missing required data stops the affected decision rather than being converted to neutral, bearish, bullish,
        or zero. Missing optional strength data contribute zero to conviction and remain explicitly unavailable. This
        distinction prevents lack of history from being described as adverse evidence. Available research fields are
        preserved so that a user can identify the missing requirement without receiving an incomplete action.
      </p>
    </EditableSection>

    <EditableSection
      id="macro-regime-and-selection"
      label="Macro Regime and Security Selection"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>4. Macro Regime and Security Selection</h2>
      <p>
        GIP denotes Growth, Inflation, and Policy. The research process focuses on changes in the rates of growth and
        inflation rather than their absolute levels; the policy component records the monetary or fiscal implications
        of those changes. The four Quad states classify the joint direction of growth and inflation. The current
        reference labels are shown below. A classification must retain its country, horizon, observation window,
        actual or forecast status, and as-of date.
      </p>
      <table className="wp-table white-paper__table wp-table--numeric">
        <thead><tr><th>State</th><th>Growth</th><th>Inflation</th><th>Reference label</th></tr></thead>
        <tbody>
          <tr><td>Quad 1</td><td>Accelerating</td><td>Decelerating</td><td>Goldilocks</td></tr>
          <tr><td>Quad 2</td><td>Accelerating</td><td>Accelerating</td><td>Reflation</td></tr>
          <tr><td>Quad 3</td><td>Decelerating</td><td>Accelerating</td><td>Stagflation</td></tr>
          <tr><td>Quad 4</td><td>Decelerating</td><td>Decelerating</td><td>Deflation</td></tr>
        </tbody>
      </table>
      <p>
        The dashboard can store manually maintained Quad classifications and calculate probability-weighted expected
        values from a curated security-by-Quad matrix. The calculation is Σ pᵢEVᵢ after entered probabilities are
        normalized. Those surfaces are operational as reference analytics; the outputs remain research because no
        approved rule connects them to eligibility, sizing, or portfolio limits.
      </p>
      <p>
        The Quad overlay does not yet possess approved decision authority. Version 0.1 does not use it as an
        eligibility gate, a mandatory ranking input, or a position-size multiplier. It may be shown as context and may
        be evaluated in shadow research, but it cannot override Trade, Trend, entry location, the beta band, the ATR
        cap, or an exit. Its eventual role must be selected explicitly in the Macro Regime and Quad Overlay technical
        note and tested in that single role before promotion to policy.
      </p>

      <h3>4.1 Candidate formation</h3>
      <p>
        Security selection begins with a defined universe and supportable thesis. A candidate requires a stable
        identifier, valid market-data mapping, sufficient history, current signals and ranges, and accurate account
        representation. Selection may consider liquidity, contract continuity, borrow, and event risk, but version
        0.1 assigns no universal thresholds to those factors.
      </p>
      <p>
        Expected values may order research attention when their source and horizon are known, but do not substitute
        for published signals. A positive value cannot authorize a long, nor a negative value a short. A future
        ranking rule must state its population, horizon, update frequency, ties, and interaction with eligibility.
      </p>

      <h3>4.2 Pods</h3>
      <p>
        Pods are intended as company-fundamental rate-of-change inputs: POD1 measures the rate of change in revenue
        growth, POD2 the rate of change in EBITDA or EPS growth, and POD3 the rate of change in free-cash-flow growth.
        The current panel is scaffolded and has no connected fundamentals provider or calculated Pod outputs. No Pod
        state currently changes eligibility, direction, or size. Pods therefore remain research-only, and publication
        of the Security Selection and Pods note is deferred until real inputs, formulas, update rules, and validation
        exist.
      </p>
    </EditableSection>

    <EditableSection
      id="signals-and-entry-location"
      label="Signals and Entry Location"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>5. Signals and Entry Location</h2>
      <p>
        Directional eligibility uses Trade and Trend as separate published inputs. Trade represents the short-duration
        direction, with a horizon of three weeks or less. Trend represents the longer-duration direction, with a
        horizon of three months or more. Neither is generated from the other, and a missing value is not inferred from
        the surviving signal. A new long requires bullish Trade and bullish Trend. A new short requires bearish Trade
        and bearish Trend. Neutral, conflicting, or missing inputs do not permit a new position.
      </p>
      <p>
        Tail is not part of the executable lifecycle in this version. Existing source material describes it as a
        long-duration field of three years or less, but its exact measurement, states, precedence, and authority
        relative to Trade and Trend have not been approved. Tail may remain visible as research, but it cannot create,
        retain, enlarge, reduce, or reverse a position. The planned Signals and Risk Ranges technical note must define
        these matters before Tail can receive policy status.
      </p>

      <h3>5.1 Risk-range location</h3>
      <p>
        LRR and HRR define the current published risk interval. Spot is normalized within that interval as shown in
        Equation 1. Values below zero or above one are outside the range and remain visible for review.
      </p>
      <ProcessEquation number="1" label="Normalized range position">
        p = (spot - LRR) / (HRR - LRR)
      </ProcessEquation>
      <p>
        A long may open or add only when spot is in the bottom half of the range: 0 ≤ p ≤ 0.5. A short may open or add
        only when spot is in the top half: 0.5 ≤ p ≤ 1. At the midpoint, either side satisfies the location boundary
        but must still satisfy its independent directional rules. Wrong-half and out-of-range prices do not authorize
        an open or add. They may still support a hold or risk-reducing trim under the lifecycle rules.
      </p>

      <h3>5.2 Structure and record evidence</h3>
      <p>
        Published range history provides evidence about direction and persistence. For a long, consecutive higher HRR
        and higher LRR editions are counted separately. For a short, consecutive lower HRR and lower LRR editions are
        counted separately. Each streak is capped at five editions. A tie, a missing endpoint, or a missing expected
        edition resets only the affected streak. The count is a sizing-strength input; it does not replace Trade or
        Trend and does not authorize entry in the wrong half of the range.
      </p>
      <p>
        Record extension is the strongest sizing input in the current method. A long record extension occurs when the
        current HRR exceeds the prior traded-price all-time high. A short record extension occurs when the current LRR
        falls below the prior traded-price all-time low. The comparison uses maximum available completed price history
        dated strictly before the current range edition. An unavailable record comparison contributes zero to
        conviction and is labeled unavailable; it is not reported as a failed extension.
      </p>
    </EditableSection>

    <EditableSection
      id="security-risk-and-sizing"
      label="Security-Level Risk and Position Sizing"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>6. Security-Level Risk and Position Sizing</h2>
      <p>
        Position sizing is evaluated after directional eligibility and range location. The approved method is defined
        in <em>Position Sizing</em>, Technical Note version 1.1. This section records only the method&apos;s role and
        summary equations; the technical note owns detailed rounding, streak, lifecycle, provenance, and validation
        rules.
      </p>
      <p>
        The absolute value of a 252-session beta against SPY establishes the initial allocation band. At least 126
        aligned completed-session observations are required. Effective beta is bounded from 0.5 to 2.0 so that very
        low or very high estimates do not create unbounded allocations. MIN is the smallest meaningful active weight.
        MAX is a ceiling, not a required allocation.
      </p>
      <ProcessEquation number="2" label="Beta-derived position band">
        {`β* = clamp(|β|, ${sizing.MIN_BETA}, ${sizing.MAX_BETA.toFixed(1)}); raw MIN = ${pct(sizing.MIN_WEIGHT_NUMERATOR)} / β*; raw MAX = ${pct(sizing.MAX_WEIGHT_NUMERATOR)} / β*`}
      </ProcessEquation>
      <p>
        Executable MIN is rounded upward and beta MAX downward to 0.50 percentage-point boundaries. ATR(14) then
        limits the maximum for security-specific price variability that SPY beta may not capture. The ATR risk budget
        is 0.50% of NLV at a two-ATR adverse move.
      </p>
      <ProcessEquation number="3" label="ATR-constrained maximum">
        {`ATR MAX = ${pct(sizing.ATR_RISK_BUDGET, 2)} / (${sizing.ATR_MULTIPLIER} × ATR(14) / spot); effective MAX = min(beta MAX, ATR MAX)`}
      </ProcessEquation>
      <p>
        Effective MAX is rounded downward to the operational grid. If it falls below MIN, the security is not safely
        ownable at the defined meaningful size and no positive target is produced. ATR is a position-size backstop in
        this method. It is not an approved hard-stop distance or automatic liquidation instruction.
      </p>

      <h3>6.1 Target within the band</h3>
      <p>
        When Trade and Trend are aligned and the price is in the favorable half, three strength measures place the
        target within the effective interval. Range proximity receives 20%, directional structure receives 30%, and
        prior ATH or ATL record extension receives 50%. The record signal has the largest coefficient but does not by
        itself force MAX.
      </p>
      <ProcessEquation number="4" label="Conviction and target position">
        {`conviction = ${sizing.RANGE_CONVICTION_WEIGHT.toFixed(2)}(range) + ${sizing.STRUCTURE_CONVICTION_WEIGHT.toFixed(2)}(structure) + ${sizing.RECORD_CONVICTION_WEIGHT.toFixed(2)}(record); target = MIN + conviction × (MAX - MIN)`}
      </ProcessEquation>
      <p>
        The target is rounded to the nearest 0.50 percentage point and clamped inside the band. A new position begins
        at MIN. Normal adds and trims move 0.50 percentage point per range edition; the step is 1.00 point when a
        record extension is present or both relevant structure streaks reach three. Risk-reducing signal deterioration
        is immediate and does not follow this schedule.
      </p>
    </EditableSection>

    <EditableSection
      id="portfolio-construction"
      label="Portfolio Construction"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>7. Portfolio Construction</h2>
      <p>
        A security target remains provisional until portfolio review. Review includes gross and net exposure, cash,
        long and short balances, security and correlation concentration, and exposure by approved grouping. These
        measures test whether individually valid positions create an unacceptable aggregate state.
      </p>
      <p>
        Current portfolio and diversification analytics are descriptive. Version 0.1 does not invent limits for gross,
        net, cash, sector, asset class, correlation, or sleeve exposure. Without approved limits, these measures are
        observations rather than pass/fail policy; an unstated threshold cannot be applied as a rule.
      </p>

      <h3>7.1 Exposure measures</h3>
      <p>
        Gross exposure is the sum of absolute position weights. Net exposure is signed long exposure less absolute
        short exposure. Cash and financing are reported separately from securities. Concentration should be examined
        both by stated classification and by observed co-movement because nominally different securities may express
        the same underlying risk. The observation window, return treatment, missing-history rule, and instrument
        mapping used in correlation calculations must be disclosed with the result.
      </p>
      <p>
        Sleeves may organize positions by strategy, horizon, asset class, or another approved mandate. A sleeve label
        is descriptive unless its membership and exposure rules are documented. Pods do not constitute approved
        sleeves in this version. No capital budget, diversification credit, or exception is inferred from a Pod or
        sleeve name alone.
      </p>

      <h3>7.2 Constraint precedence</h3>
      <p>
        When approved portfolio limits are introduced, they may reduce or reject a proposed security target; they may
        not enlarge it beyond security MAX or waive a signal, range, or live-data requirement. The technical note must
        specify how competing limits are resolved, whether reductions are proportional or prioritized, how existing
        breaches are handled, and when cash is intentionally retained. Until those rules exist, portfolio analytics
        remain descriptive and review-based.
      </p>
    </EditableSection>

    <EditableSection
      id="stops-exits-and-reversals"
      label="Stops, Exits, and Reversals"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>8. Stops, Exits, and Reversals</h2>
      <p>
        The current lifecycle gives Trade and Trend different authority. A Trend break does not have the same effect
        as a Trade break. When an existing position&apos;s Trend breaks but Trade continues to support the held side,
        the position is capped at MIN and marked BENCH. Any weight above MIN is reduced immediately to MIN. A position
        already below MIN is not increased, and the state does not authorize a new position.
      </p>
      <p>
        When Trade breaks for the held side, the position target becomes zero regardless of the remaining Trend state.
        The exit is immediate in the recommendation model and is not limited by the normal 0.50 or 1.00 percentage-
        point step. A missing Trade input is unknown rather than a verified break; it suppresses an executable output
        and presents the available research state without manufacturing an exit signal.
      </p>
      <table className="wp-table white-paper__table wp-table--lifecycle">
        <thead>
          <tr>
            <th>Verified state</th>
            <th>Existing position</th>
            <th>New candidate</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Trade and Trend support the held or proposed side</td>
            <td>ACTIVE; size within the permitted band and incremental schedule.</td>
            <td>Open at MIN only in the favorable range half.</td>
          </tr>
          <tr>
            <td>Trade supports the side; Trend breaks</td>
            <td>BENCH; cap at MIN immediately without increasing a smaller position.</td>
            <td>MIN may be shown as reference; no open action.</td>
          </tr>
          <tr>
            <td>Trade breaks</td>
            <td>EXIT; target zero regardless of Trend.</td>
            <td>No position.</td>
          </tr>
          <tr>
            <td>Required signal or live execution input unavailable</td>
            <td>Research state only; no executable action or share quantity.</td>
            <td>Same.</td>
          </tr>
        </tbody>
      </table>

      <h3>8.1 Reversals</h3>
      <p>
        A reversal is two separate decisions. The old side is first evaluated and exited under its Trade rule. The
        opposite side then begins as a new candidate and must independently satisfy Trade and Trend alignment, the
        favorable range half, sizing, portfolio review, and live-data requirements. A bearish change that exits a long
        is not by itself permission to open a short, and a bullish change that exits a short is not by itself
        permission to open a long. Simultaneous sign changes are not represented as a single cross-through-zero order.
      </p>

      <h3>8.2 Hard stops</h3>
      <p>
        No canonical hard-stop policy exists in version 0.1. Initial stop placement, trailing behavior, gap treatment,
        overnight handling, instrument-specific price increments, interaction with Trade and Trend, and authority to
        override normal execution remain unresolved. ATR&apos;s approved role is limited to constraining position MAX.
        The planned Stops, Exits, and Reversals technical note must define and validate hard-stop behavior before the
        dashboard presents it as policy.
      </p>
    </EditableSection>

    <EditableSection
      id="execution-validation-and-limitations"
      label="Execution, Validation, and Limitations"
      className="white-paper__chapter"
      dataTestId="process-paper-section"
      editor={editor}
    >
      <h2>9. Execution, Validation, and Limitations</h2>
      <p>
        The system is advisory and read-only. It may calculate a research target from approved historical and
        published inputs, but an actionable dollar amount or quantity requires a connected IBKR session, a fresh
        verified quote for the exact instrument, a fresh verified account summary for NLV, and complete contract
        metadata. The quote, account value, evaluation time, currency conversion, multiplier, and lot-size treatment
        must be part of the recorded calculation. If any required item fails validation, the interface displays the
        research result and the blocker but no executable action or quantity.
      </p>
      <p>
        A human reviews the recommendation, portfolio context, market conditions, price, liquidity, and operational
        status before any separate trading action. The process does not submit, pre-stage, route, or send orders to
        IBKR or another broker. Shadow and displayed recommendations cannot bypass that prohibition.
      </p>

      <h3>9.1 Shadow validation</h3>
      <p>
        New or revised mechanisms must run in read-only shadow mode before they are promoted to a dashboard
        recommendation. Each shadow observation must store the complete normalized input, expected lifecycle state, target,
        reasons, blockers, method version, and subsequent outcome. Review includes deterministic reproduction,
        boundary cases, stale-data suppression, missing-data behavior, long and short symmetry where intended, and
        asymmetric signal precedence where specified.
      </p>
      <p>
        Position-sizing validation covers beta regression and observation limits, beta clamps, ATR precedence,
        favorable-half boundaries, structure resets, ATH and ATL comparisons, target rounding, lifecycle transitions,
        and all rejected live-data states. Future technical notes must define their own unit, integration, historical,
        and user-interface validation requirements. A method is not canonical because it appears plausible in a
        document; its registry status changes only after review and approval.
      </p>

      <h3>9.2 Review and versioning</h3>
      <p>
        Documents and rules use explicit versions. A material change to an equation, signal authority, threshold,
        lifecycle transition, data requirement, or missing-data rule requires a new method version and associated
        tests. Displayed recommendations retain the versions used at evaluation time. Deprecated rules remain
        available for historical reconstruction but cannot be selected as current canonical definitions.
      </p>
      <p>
        The master paper is promoted from draft to version 1.0 only after Signals and Risk Ranges, Position Sizing,
        Stops, Exits, and Reversals, Macro Regime and Quad Overlay, and Portfolio Construction and Diversification are
        canonical. The Playbook may then serve as a concise operating checklist that references approved rule IDs.
        Principles may contain behavioral guidance, but neither document becomes an independent source of mechanism
        rules.
      </p>

      <h3>9.3 Limitations</h3>
      <ul>
        <li>SPY beta measures common-market sensitivity and does not capture every security-specific, basis, liquidity, currency, or gap risk.</li>
        <li>ATR constrains security size but is not a complete tail-risk model and is not an approved hard stop.</li>
        <li>Historical ranges, ATH/ATL records, and structure depend on complete edition and instrument mapping, including continuous-futures methodology where relevant.</li>
        <li>Portfolio correlation estimates are sample-dependent and remain descriptive until observation windows and policy thresholds are approved.</li>
        <li>Quad, Tail, expected values, Pods, and unapproved portfolio limits remain research or descriptive inputs and cannot override canonical rules.</li>
        <li>Unsupported instruments, currencies, multipliers, lot sizes, or account states remain research-only even when security evidence is otherwise complete.</li>
        <li>The framework does not address tax optimization, legal suitability, financing availability, borrow recalls, or broker-specific order handling.</li>
      </ul>

      <h3>9.4 Method status and references</h3>
      <table className="wp-table white-paper__table">
        <thead>
          <tr>
            <th>Document or method</th>
            <th>Version / status</th>
            <th>Authority and dependency</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{metadata.title}</td>
            <td>v{metadata.version} - {metadata.status}; {formatAsOf(metadata.asOf)}</td>
            <td>Owns decision order, policy relationships, and current status; depends on approved technical notes.</td>
          </tr>
          <tr>
            <td>{positionSizing.title}</td>
            <td>v{positionSizing.version} - {positionSizing.status} Technical Note; {formatAsOf(positionSizing.asOf)}</td>
            <td>Owns beta band, ATR cap, conviction, target, incremental sizing, and sizing-result definitions.</td>
          </tr>
          <tr>
            <td>{signals.title}</td>
            <td>{signals.status} - Not canonical</td>
            <td>Will own Trade, Trend, Tail, LRR/HRR, structure, record, and signal provenance definitions.</td>
          </tr>
          <tr>
            <td>{stops.title}</td>
            <td>{stops.status} - Not canonical</td>
            <td>Will own hard stops, trailing behavior, gaps, precedence, and reversal execution; current lifecycle follows this master paper and Position Sizing v1.1.</td>
          </tr>
          <tr>
            <td>{macro.title}</td>
            <td>{macro.status} - Research</td>
            <td>Must define whether Quad is context, ranking, sizing, or eligibility before receiving authority.</td>
          </tr>
          <tr>
            <td>{portfolio.title}</td>
            <td>{portfolio.status} - Descriptive</td>
            <td>Must approve exposure, concentration, correlation, sleeve, and cash constraints before they become normative.</td>
          </tr>
          <tr>
            <td>{pods.title}</td>
            <td>{pods.status} - Research</td>
            <td>Publication waits for real selection inputs, Pod definitions, calculations, and validation.</td>
          </tr>
        </tbody>
      </table>

      <p>
        Version 0.1 therefore provides a complete decision sequence while limiting policy claims to mechanisms with
        defined authority. As additional technical notes become canonical, this paper will be revised to reference
        their versions without duplicating their full derivations.
      </p>
    </EditableSection>
  </article>
  );
};

export default ProcessPaper;
