import React from 'react';
import {
  PROCESS_METHOD_IDS,
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

EditableRegion.displayName = 'EditableRegion';

const ArticleFrame = ({ document, editor, children }) => (
  <article
    className={`wp-paper process-library-article${editor?.isEditing ? ' is-editing' : ''}`}
    data-testid="process-document"
    aria-label={document.title}
  >
    <EditableRegion
      as="header"
      id="title-page"
      label="Title"
      className="process-library-article__header"
      editor={editor}
    >
      {document.parentId && (
        <p className="process-library-article__eyebrow">
          <a href="#/process/methods">Methods</a>
        </p>
      )}
      <h1 id={`${document.id}-title`}>{document.title}</h1>
      <p>{document.subtitle}</p>
      <p className="process-library-article__metadata">
        Version {document.version} · {document.status} · As of {formatAsOf(document.asOf)}
      </p>
    </EditableRegion>
    {children}
  </article>
);

const Region = ({ id, label, editor, children }) => (
  <EditableRegion id={id} label={label} editor={editor}>
    {children}
  </EditableRegion>
);

export const METHODS_SECTIONS = [
  ['overview', 'Overview'],
  ['method-index', 'Method index'],
  ['authority', 'Authority and status'],
];

const MethodsArticle = ({ document, editor }) => {
  const methods = getProcessMethodDocuments();
  return (
    <ArticleFrame document={document} editor={editor}>
      <Region id="overview" label="Overview" editor={editor}>
        <h2>Overview</h2>
        <p>
          Methods contain the definitions, calculations, data requirements, edge cases, and validation procedures
          used by the Process. The Process states the order of decisions; each Method owns the detailed operation
          named in its title.
        </p>
        <p>
          A Method marked Draft, Research, or Deferred does not create policy merely because it is listed here.
          Only rules identified as canonical in the registry have decision authority.
        </p>
      </Region>
      <Region id="method-index" label="Method index" editor={editor}>
        <h2>Method index</h2>
        <table className="wp-table process-library-article__index">
          <thead>
            <tr><th>Method</th><th>Status</th><th>Purpose</th></tr>
          </thead>
          <tbody>
            {methods.map((method) => (
              <tr key={method.id}>
                <td><a href={method.route}>{method.title}</a></td>
                <td>{method.status}</td>
                <td>{METHOD_PURPOSES[method.id]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Region>
      <Region id="authority" label="Authority and status" editor={editor}>
        <h2>Authority and status</h2>
        <p>
          Method status applies to the document as a whole. Individual approved and unresolved rules remain
          identified separately in the rule registry. Position Sizing is the current formula-complete Method.
          Other Methods are working documents and state their unresolved decisions directly.
        </p>
      </Region>
    </ArticleFrame>
  );
};

export const SIGNALS_AND_RISK_RANGES_SECTIONS = [
  ['overview', 'Overview'],
  ['directional-signals', 'Directional signals'],
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
        This Method defines the directional signals and published risk-range information used by the Process.
        It determines directional eligibility and whether price is in a location where risk may be opened or added.
        It does not calculate position weight or define portfolio limits.
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
        Trade and Trend retain their own source, edition, and as-of time. Neither may be copied from or inferred
        from the other. A missing signal is unavailable; it is not converted to neutral or treated as a break.
      </p>
    </Region>
    <Region id="risk-ranges" label="Risk ranges" editor={editor}>
      <h2>Risk ranges</h2>
      <p>
        LRR is the published Low Risk Range endpoint and HRR is the published High Risk Range endpoint. A valid
        current range requires both endpoints, a common edition, and LRR below HRR. Spot may be normalized within
        the interval for location and sizing calculations. Out-of-range prices remain visible but do not authorize
        an open or add.
      </p>
    </Region>
    <Region id="entry-location" label="Entry location" editor={editor}>
      <h2>Entry location</h2>
      <ul>
        <li>A long may open or add only in the bottom half of the current LRR–HRR.</li>
        <li>A short may open or add only in the top half of the current LRR–HRR.</li>
        <li>The midpoint is included for either side when the applicable directional conditions are satisfied.</li>
        <li>Location permission does not by itself authorize a position or determine its size.</li>
      </ul>
    </Region>
    <Region id="structure-and-records" label="Structure and records" editor={editor}>
      <h2>Structure and records</h2>
      <p>
        Consecutive higher HRR and higher LRR editions describe long-side structure. Consecutive lower HRR and
        lower LRR editions describe short-side structure. Each endpoint is tracked separately, capped at five
        editions, and reset by a tie or missing edition.
      </p>
      <p>
        A long record extension occurs when the current HRR exceeds the traded-price all-time high established
        strictly before the current range edition. A short record extension occurs when the current LRR is below
        the corresponding prior all-time low. These observations are inputs to Position Sizing; they do not force
        a maximum position.
      </p>
    </Region>
    <Region id="tail" label="Tail" editor={editor}>
      <h2>Tail</h2>
      <p>
        Tail is a long-duration directional context shown for overview. It currently has no entry, exit, sizing,
        or portfolio authority and is not part of the executable lifecycle.
      </p>
    </Region>
    <Region id="data-controls" label="Data controls" editor={editor}>
      <h2>Data controls</h2>
      <p>
        Signals and ranges retain source, edition, and as-of time. Historical ranges must include every available
        page needed for consecutive-edition comparisons. Record tests use maximum available completed traded-price
        history and exclude observations on or after the current range edition.
      </p>
    </Region>
  </ArticleFrame>
);

export const STOPS_EXITS_AND_REVERSALS_SECTIONS = [
  ['status', 'Status'],
  ['signal-lifecycle', 'Signal lifecycle'],
  ['reversals', 'Reversals'],
  ['hard-stops', 'Hard stops'],
  ['unresolved-work', 'Unresolved work'],
];

const StopsExitsAndReversalsArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="status" label="Status" editor={editor}>
      <h2>Status</h2>
      <p>
        Signal-based reductions and exits are defined below. Initial hard stops, trailing behavior, gap handling,
        and instrument-specific exceptions remain unresolved and cannot be inferred from this draft.
      </p>
    </Region>
    <Region id="signal-lifecycle" label="Signal lifecycle" editor={editor}>
      <h2>Signal lifecycle</h2>
      <ul>
        <li>When Trend breaks but Trade still supports the held side, an existing position is reduced directly to MIN.</li>
        <li>When Trade breaks for the held side, the position target becomes zero regardless of Trend.</li>
        <li>A missing required signal disables an executable recommendation; it is not reported as a confirmed break.</li>
      </ul>
    </Region>
    <Region id="reversals" label="Reversals" editor={editor}>
      <h2>Reversals</h2>
      <p>
        A reversal exits the held side first. The opposite side is evaluated as a new candidate and must independently
        satisfy its directional and entry-location requirements. No single evaluation both retains the old side and
        opens the new side.
      </p>
    </Region>
    <Region id="hard-stops" label="Hard stops" editor={editor}>
      <h2>Hard stops</h2>
      <p>
        No canonical hard-stop policy is currently defined. ATR is a position-size cap and must not be represented
        as a stop formula.
      </p>
    </Region>
    <Region id="unresolved-work" label="Unresolved work" editor={editor}>
      <h2>Unresolved work</h2>
      <p>
        Approval requires exact initial-stop placement, update frequency, trailing rules, gap treatment, order type,
        precedence relative to Trade and Trend, and behavior for instruments with discontinuous or limited trading.
      </p>
    </Region>
  </ArticleFrame>
);

export const QUAD_FRAMEWORK_SECTIONS = [
  ['status', 'Status'],
  ['purpose', 'Purpose'],
  ['inputs', 'Inputs'],
  ['classification', 'Classification'],
  ['authority', 'Decision authority'],
];

const QuadFrameworkArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="status" label="Status" editor={editor}>
      <h2>Status</h2>
      <p>The Quad framework is research context. It does not currently authorize, reject, or resize a position.</p>
    </Region>
    <Region id="purpose" label="Purpose" editor={editor}>
      <h2>Purpose</h2>
      <p>
        The framework organizes macro conditions by the direction and rate of change of growth and inflation.
        It provides a common description of the environment in which security-level decisions are evaluated.
      </p>
    </Region>
    <Region id="inputs" label="Inputs" editor={editor}>
      <h2>Inputs</h2>
      <p>
        A complete specification must identify each growth, inflation, and policy input; transformation; forecast
        horizon; release calendar; revision treatment; source; and as-of time. Expected-value calculations must
        distinguish observed data from forecasts and scenario assumptions.
      </p>
    </Region>
    <Region id="classification" label="Classification" editor={editor}>
      <h2>Classification</h2>
      <p>
        A Quad classification requires explicit sign and rate-of-change rules for growth and inflation, including
        boundary behavior and transitions. Those calculations are not yet approved in this Method.
      </p>
    </Region>
    <Region id="authority" label="Decision authority" editor={editor}>
      <h2>Decision authority</h2>
      <p>
        Before promotion, the framework must be assigned exactly one documented role: descriptive context, ranking
        input, size modifier, eligibility gate, or another approved function. The current dashboard display is
        descriptive and cannot override Trade, Trend, entry location, or position-size limits.
      </p>
    </Region>
  </ArticleFrame>
);

export const SECURITY_SELECTION_AND_PODS_SECTIONS = [
  ['status', 'Status'],
  ['selection', 'Security selection'],
  ['pods', 'Pod definitions'],
  ['required-specification', 'Required specification'],
];

const SecuritySelectionAndPodsArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="status" label="Status" editor={editor}>
      <h2>Status</h2>
      <p>
        This Method is deferred until connected fundamentals, exact calculations, update rules, and validation
        results are available. The current material is descriptive and has no eligibility or ranking authority.
      </p>
    </Region>
    <Region id="selection" label="Security selection" editor={editor}>
      <h2>Security selection</h2>
      <p>
        The intended output is a research universe and candidate ranking based on attributable security data.
        Appearance in the universe does not establish direction, entry permission, size, or an executable action.
      </p>
    </Region>
    <Region id="pods" label="Pod definitions" editor={editor}>
      <h2>Pod definitions</h2>
      <dl>
        <dt>Pod 1</dt><dd>Revenue growth and its rate of change.</dd>
        <dt>Pod 2</dt><dd>Cash-flow or earnings growth and its rate of change.</dd>
        <dt>Pod 3</dt><dd>Free cash flow, return on invested capital, and capital allocation.</dd>
      </dl>
      <p>These descriptions do not constitute approved formulas or a combined Pod score.</p>
    </Region>
    <Region id="required-specification" label="Required specification" editor={editor}>
      <h2>Required specification</h2>
      <p>
        Publication requires field definitions, source hierarchy, fiscal-period alignment, restatement handling,
        normalization, missing-data behavior, combination and ranking rules, update cadence, and validation against
        real historical observations.
      </p>
    </Region>
  </ArticleFrame>
);

export const PORTFOLIO_CONSTRUCTION_SECTIONS = [
  ['status', 'Status'],
  ['current-analytics', 'Current analytics'],
  ['construction-sequence', 'Construction sequence'],
  ['unresolved-limits', 'Unresolved limits'],
];

const PortfolioConstructionArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="status" label="Status" editor={editor}>
      <h2>Status</h2>
      <p>
        Portfolio analytics are descriptive until specific policy limits are approved. No unapproved threshold may
        be presented as a required allocation, diversification target, or override.
      </p>
    </Region>
    <Region id="current-analytics" label="Current analytics" editor={editor}>
      <h2>Current analytics</h2>
      <p>
        Current portfolio review may report gross and net exposure, cash, long and short weights, sleeves,
        security concentration, and correlation concentration. Each result must retain account, position, price,
        currency, and calculation provenance.
      </p>
    </Region>
    <Region id="construction-sequence" label="Construction sequence" editor={editor}>
      <h2>Construction sequence</h2>
      <p>
        Security-level eligibility and size are evaluated before aggregate portfolio effects. Portfolio review may
        reduce or reject a proposed position once canonical limits exist; it may not increase a position above its
        security-level maximum or repair missing security data.
      </p>
    </Region>
    <Region id="unresolved-limits" label="Unresolved limits" editor={editor}>
      <h2>Unresolved limits</h2>
      <p>
        Gross, net, cash, sleeve, issuer, sector, asset-class, factor, correlation, and liquidity limits remain
        unresolved. The approved Method must define calculation bases, hierarchy, breach behavior, exceptions,
        and treatment of derivatives and short exposure.
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
        It also defines the fail-closed boundary for unavailable or unverified inputs.
      </p>
    </Region>
    <Region id="research-data" label="Research data" editor={editor}>
      <h2>Research data</h2>
      <p>
        Signals, ranges, beta, ATR, records, macro observations, and portfolio analytics retain source, as-of time,
        observation count where applicable, quality state, and method version. Available research remains visible
        when another required input is missing.
      </p>
    </Region>
    <Region id="live-data-gate" label="Live-data gate" editor={editor}>
      <h2>Live-data gate</h2>
      <p>
        Actionable dollars and quantity require a fresh, connected, verified IBKR spot price and net liquidation
        value, supported instrument metadata, and dated research provenance. The quote and account state must be
        attributable to the evaluation being displayed.
      </p>
    </Region>
    <Region id="output" label="Output" editor={editor}>
      <h2>Output</h2>
      <p>
        Outputs are read-only. The Process does not transmit, route, stage, or automatically execute orders.
        Research state may include a non-executable target weight, but share quantity remains unavailable until the
        live-data gate passes.
      </p>
    </Region>
    <Region id="failure-behavior" label="Failure behavior" editor={editor}>
      <h2>Failure behavior</h2>
      <p>
        Offline, delayed, frozen, stale, cached, mock, seeded, synthetic, inferred, fallback, or
        portfolio-derived substitutes cannot authorize action. The interface states the blocker without replacing
        the missing value or reporting a false negative signal.
      </p>
    </Region>
  </ArticleFrame>
);

export const VALIDATION_AND_CHANGE_CONTROL_SECTIONS = [
  ['status', 'Status'],
  ['validation', 'Validation'],
  ['shadow-mode', 'Shadow mode'],
  ['change-control', 'Change control'],
];

const ValidationAndChangeControlArticle = ({ document, editor }) => (
  <ArticleFrame document={document} editor={editor}>
    <Region id="status" label="Status" editor={editor}>
      <h2>Status</h2>
      <p>
        This draft describes the minimum validation and change-control structure. It does not approve a new
        investment rule or replace the validation requirements stated by an individual Method.
      </p>
    </Region>
    <Region id="validation" label="Validation" editor={editor}>
      <h2>Validation</h2>
      <p>
        Each deterministic Method requires unit tests for formulas, boundaries, precedence, missing data, and
        provenance. Document examples must be generated by the same production calculation used by the dashboard
        when an engine exists. Interface validation covers routing, accessibility, responsive layout, and printing.
      </p>
    </Region>
    <Region id="shadow-mode" label="Shadow mode" editor={editor}>
      <h2>Shadow mode</h2>
      <p>
        New recommendation logic runs read-only before display as an operational recommendation. Results, blockers,
        input versions, and subsequent outcomes are retained for review. Shadow mode never transmits orders.
      </p>
    </Region>
    <Region id="change-control" label="Change control" editor={editor}>
      <h2>Change control</h2>
      <p>
        A rule change identifies its owner, version, effective date, dependencies, migration effect, and tests.
        Draft and research text cannot silently replace a canonical definition. Historical evaluations retain the
        method version used at the time.
      </p>
    </Region>
  </ArticleFrame>
);

const METHOD_PURPOSES = {
  'signals-and-risk-ranges': 'Defines Trade, Trend, Tail context, LRR/HRR, structure, records, and entry location.',
  'position-sizing': 'Calculates security-level MIN, MAX, target weight, and incremental size changes.',
  'stops-exits-and-reversals': 'Defines signal-based reductions, exits, reversals, and unresolved hard-stop policy.',
  'macro-regime-and-quad-overlay': 'Defines macro inputs, Quad classification, and any approved decision authority.',
  'security-selection-and-pods': 'Defines the research universe, Pod calculations, and security-ranking procedure.',
  'portfolio-construction-and-diversification': 'Defines aggregate exposure, concentration, correlation, and portfolio limits.',
  'data-controls-and-execution': 'Defines provenance, freshness, live-data gates, and read-only execution output.',
  'validation-and-change-control': 'Defines testing, shadow-mode review, versioning, and rule-change procedure.',
};

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

export const METHOD_DOCUMENT_IDS = PROCESS_METHOD_IDS;

export const PROCESS_LIBRARY_RENDERERS = Object.fromEntries(
  Object.entries(PROCESS_LIBRARY_ARTICLES).map(([documentId, definition]) => [
    documentId,
    {
      sections: definition.sections,
      editableRegions: definition.sections,
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
    throw new Error(`Unknown Process library article: ${documentId || documentProp?.id || '<missing>'}`);
  }
  const Article = definition.component;
  return <Article document={document} editor={editor} />;
};

export default ProcessLibraryArticle;
