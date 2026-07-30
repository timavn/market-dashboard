import React from 'react';
import {
  getProcessDocument,
  getProcessMethodDocuments,
} from '../../constants/processDocuments';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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
  const methods = getProcessMethodDocuments();

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
          Version {metadata.version}&nbsp;&nbsp;|&nbsp;&nbsp;{metadata.status}
          &nbsp;&nbsp;|&nbsp;&nbsp;As of {formatAsOf(metadata.asOf)}
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
          <strong>Abstract.</strong> Process is the overview of the portfolio-management framework. It defines the
          order of decisions from data validation through review, and states which inputs may affect eligibility,
          direction, position size, portfolio exposure, and execution. Detailed definitions and calculations are
          maintained under Methods.
        </p>
        <p>
          The framework supports long and short positions and produces read-only recommendations. It does not route,
          stage, or transmit orders. Missing required data stops the applicable decision. Research inputs may remain
          visible, but they do not acquire decision authority by appearing in the dashboard or this document.
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
          The objective is to convert market and security evidence into a controlled portfolio decision. The process
          separates data quality, market context, security selection, directional eligibility, entry location,
          security-level risk, portfolio constraints, and execution. A later stage may reduce or reject an earlier
          result, but it may not manufacture a missing input or waive an earlier requirement.
        </p>
        <p>
          The current scope is one lifecycle for all positions. No Core, Tactical, asset-class, or account-specific
          exception is assumed. Portfolio optimization, approved correlation limits, a hard-stop formula, Quad-based
          authority, Pod-based selection, and automatic execution remain outside the current policy unless and until
          their Methods are approved.
        </p>
        <h3>1.1 Document authority</h3>
        <p>
          Process owns the decision order and the relationship among mechanisms. Each Method owns the exact rules in
          its subject area. Draft, research, descriptive, legacy, and deprecated material cannot override a canonical
          rule owner.
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
              <td>Are the required inputs identified, current, and complete?</td>
              <td>Valid research state or a documented blocker.</td>
            </tr>
            <tr>
              <td>2. Determine context</td>
              <td>What macro regime and cross-asset conditions are present?</td>
              <td>Context only unless an approved Method assigns authority.</td>
            </tr>
            <tr>
              <td>3. Select securities</td>
              <td>Which supported securities qualify for evaluation?</td>
              <td>Eligible research candidates.</td>
            </tr>
            <tr>
              <td>4. Establish direction</td>
              <td>Do Trade and Trend support the same side?</td>
              <td>Long, short, or no new-position eligibility.</td>
            </tr>
            <tr>
              <td>5. Evaluate location</td>
              <td>Is spot in the favorable half of the current risk range?</td>
              <td>Open/add permitted or blocked.</td>
            </tr>
            <tr>
              <td>6. Calculate weight</td>
              <td>What security-level interval and target are supported?</td>
              <td>MIN, MAX, target weight, and lifecycle state.</td>
            </tr>
            <tr>
              <td>7. Check the portfolio</td>
              <td>Does the result remain acceptable in aggregate?</td>
              <td>Retained, reduced, or rejected portfolio weight.</td>
            </tr>
            <tr>
              <td>8. Execute and review</td>
              <td>Are live execution inputs verified, and what is the next step?</td>
              <td>Read-only action, blocker, or research-only output.</td>
            </tr>
          </tbody>
        </table>
        <p>
          Each evaluation records the security, side, current position, input sources, as-of times, method versions,
          result, reasons, and blockers. A recommendation must be reproducible from that record.
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
        <table className="wp-table white-paper__table">
          <thead>
            <tr>
              <th>Input</th>
              <th>Use</th>
              <th>Required behavior</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Trade and Trend</td>
              <td>Direction and lifecycle</td>
              <td>Keep independent, retain source and as-of time, and do not infer a missing value.</td>
            </tr>
            <tr>
              <td>LRR and HRR</td>
              <td>Entry location and structure</td>
              <td>Use the current published edition and complete paginated history.</td>
            </tr>
            <tr>
              <td>Price history</td>
              <td>Returns and record comparisons</td>
              <td>Use adjusted aligned returns for beta and maximum available completed history for records.</td>
            </tr>
            <tr>
              <td>Beta and ATR</td>
              <td>Security-level risk limits</td>
              <td>Retain benchmark, window, observation count, source, value, and as-of date.</td>
            </tr>
            <tr>
              <td>Spot and NLV</td>
              <td>Dollars and quantity</td>
              <td>Require fresh, verified IBKR values and supported instrument metadata.</td>
            </tr>
            <tr>
              <td>Optional evidence</td>
              <td>Strength within an eligible state</td>
              <td>Show unavailable inputs explicitly and assign no false negative value.</td>
            </tr>
          </tbody>
        </table>
        <p>
          Offline, delayed, stale, cached, mock, seeded, or otherwise unverified live inputs cannot produce an
          executable action or share quantity. Available research remains visible with its status. A missing required
          input is reported as unavailable, not as a confirmed bearish, bullish, or broken signal.
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
          Growth, inflation, and policy conditions provide market context. The Quad framework organizes that context
          into a regime classification. In the current draft, the Quad does not independently authorize a position,
          reverse a signal, or change a security weight. Its future role must be specified as context, a ranking input,
          a size modifier, or an eligibility gate in the <a href="#/process/methods/macro-regime-and-quad-overlay">Quad Framework Method</a>.
        </p>
        <p>
          Security selection begins with a supported universe, a stable identifier, sufficient history, current
          signals and ranges, and accurate account representation. Expected values may order research attention when
          their source and horizon are known, but they do not substitute for Trade and Trend.
        </p>
        <p>
          Pods are intended to describe changes in company fundamentals. They remain research-only because the current
          dashboard does not yet have approved inputs, calculations, update rules, or selection authority. Those items
          belong to <a href="#/process/methods/security-selection-and-pods">Security Selection and Pods</a>.
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
          Trade is the published short-duration directional signal with a horizon of three weeks or less. Trend is the
          published longer-duration directional signal with a horizon of three months or more. They remain separate
          inputs. A new long requires bullish Trade and bullish Trend; a new short requires bearish Trade and bearish
          Trend. Neutral, conflicting, or missing inputs do not permit a new position.
        </p>
        <p>
          Tail is long-duration directional context used only for overview. It has no entry, exit, sizing, or portfolio
          authority and is not part of the executable lifecycle.
        </p>
        <p>
          LRR and HRR define the current published risk range. A long may open or add only in the lower half; a short
          may open or add only in the upper half. Out-of-range or wrong-half prices remain visible but cannot trigger
          an open or add. Consecutive range editions describe structure, and extensions beyond prior traded-price
          records provide additional evidence. Neither observation can create directional eligibility by itself.
          Exact definitions are maintained in <a href="#/process/methods/signals-and-risk-ranges">Signals and Risk Ranges</a>.
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
          Position size is expressed as a percentage of portfolio NLV. Security beta establishes the initial MIN and
          MAX interval, and ATR may reduce MAX when security-specific volatility is more restrictive. If the volatility
          cap falls below MIN, the security is not safely ownable at a meaningful size.
        </p>
        <p>
          When Trade and Trend are aligned, favorable range location, directional range structure, and a record
          extension determine a target inside the interval. A record extension is the strongest of these inputs but
          does not automatically force MAX. New positions begin at MIN. Normal changes are incremental by range
          edition; signal deterioration is immediate.
        </p>
        <p>
          The equations, rounding rules, long and short examples, provenance fields, and edge cases are maintained in
          <a href="#/process/methods/position-sizing"> Position Sizing</a>. Portfolio constraints may reduce a
          security-level result but may not increase it above MAX.
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
          Security-level targets are evaluated with gross exposure, net exposure, cash, long and short sleeves,
          currency and asset-class exposure, sector or thematic concentration, and correlation. These measures answer
          a different question from position sizing: whether individually supportable positions remain acceptable
          together.
        </p>
        <p>
          Current dashboard analytics are descriptive. They do not imply approved gross, net, cash, correlation,
          concentration, or sleeve limits. A future policy must define calculation windows, missing-history treatment,
          derivative notional, currency conversion, aggregation, breach precedence, and remediation. Until then,
          no unapproved portfolio limit may be presented as a binding rule. See
          <a href="#/process/methods/portfolio-construction-and-diversification"> Portfolio Construction</a>.
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
        <table className="wp-table white-paper__table wp-table--lifecycle">
          <thead>
            <tr>
              <th>State</th>
              <th>Existing position</th>
              <th>New candidate</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Trade and Trend support the held side</td>
              <td>Manage between MIN and MAX.</td>
              <td>Open only in the favorable range half.</td>
            </tr>
            <tr>
              <td>Trend breaks while Trade still supports the held side</td>
              <td>Reduce directly to MIN; do not increase a smaller position.</td>
              <td>Show MIN for reference; do not open.</td>
            </tr>
            <tr>
              <td>Trade breaks for the held side</td>
              <td>Exit to zero regardless of Trend.</td>
              <td>Do not open.</td>
            </tr>
            <tr>
              <td>Required live data are unavailable</td>
              <td colSpan="2">Show research inputs and blockers; produce no action or quantity.</td>
            </tr>
          </tbody>
        </table>
        <p>
          A reversal exits the held side first. The opposite side is evaluated as a new candidate and must independently
          satisfy its signal and entry-location rules. ATR is a position-size cap, not a hard-stop formula. Initial
          stops, trailing behavior, gap treatment, and instrument-specific exceptions remain unresolved in
          <a href="#/process/methods/stops-exits-and-reversals"> Stops, Exits, and Reversals</a>.
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
          An actionable dollar amount or quantity requires a verified IBKR connection, fresh spot, current NLV,
          supported instrument identity, currency, multiplier, lot size, and dated research provenance. The output
          remains read-only. The system does not transmit orders.
        </p>
        <p>
          New and revised mechanisms run in shadow mode before dashboard promotion. Validation covers deterministic
          reproduction, boundaries, missing inputs, stale-data suppression, lifecycle transitions, long and short
          behavior, instrument handling, and version migration. A material change to authority, an equation, threshold,
          lifecycle rule, data requirement, or missing-data rule requires a new version and associated tests.
        </p>
        <h3>9.1 Current limitations</h3>
        <ul>
          <li>Beta and ATR do not capture every basis, liquidity, currency, gap, borrow, or security-specific risk.</li>
          <li>Historical ranges, records, and structure depend on complete edition and instrument mapping.</li>
          <li>Quad, Pods, hard stops, and portfolio-policy limits retain only the authority stated in their Methods.</li>
          <li>Unsupported instruments and incomplete account states remain research-only.</li>
          <li>The framework does not address taxes, legal suitability, financing availability, or broker order handling.</li>
        </ul>
        <h3>9.2 Methods</h3>
        <table className="wp-table white-paper__table">
          <thead>
            <tr>
              <th>Method</th>
              <th>Version</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {methods.map((method) => (
              <tr key={method.id}>
                <td><a href={method.route}>{method.title}</a></td>
                <td>{method.version}</td>
                <td>{method.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </EditableSection>
    </article>
  );
};

export default ProcessPaper;
