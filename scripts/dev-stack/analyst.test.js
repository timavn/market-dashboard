const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const path = require('node:path');
const YAML = require('yaml');

const {
  childEnvironment,
  createAnalystRuntimeEnvironment,
  hasExactAnalystHermesCommandSignature,
  hasExactAnalystSidecarCommandSignature,
  runAnalystContractCheck,
} = require('./cli');

const root = path.resolve(__dirname, '../..');

test('keeps review orchestration and packet retrieval outside the Hermes tool boundary', () => {
  const profile = YAML.parse(fs.readFileSync(path.join(root, 'config/analyst/config.yaml'), 'utf8'));
  const serverTools = profile.mcp_servers?.['market-dashboard-analyst']?.tools;

  assert.equal(profile.tools?.tool_search?.enabled, 'off');
  assert.equal(serverTools?.resources, false);
  assert.equal(serverTools?.prompts, false);
  assert.deepEqual(serverTools?.include, [
    'get_research_coverage',
    'get_briefing_packet',
    'get_market_situation_context',
    'search_research',
    'get_research_source',
    'get_research_page_image',
    'get_portfolio_context',
    'get_balance_context',
    'get_live_market_snapshot',
    'get_prediction_market_snapshot',
    'get_market_history',
    'get_company_fundamentals',
    'get_macro_series',
  ]);
  assert.ok(!serverTools.include.includes('prepare_portfolio_review'));
  assert.ok(!serverTools.include.includes('get_portfolio_review_packet'));
  assert.equal(profile._config_version, 39);
  assert.equal(profile.display?.tool_progress, 'off');
  assert.equal(profile.agent?.max_turns, undefined);
});

test('starts the isolated Analyst profile with quiet tool progress and explicit process identity', () => {
  const startScript = fs.readFileSync(path.join(root, 'scripts/analyst/start_hermes.sh'), 'utf8');
  const setupScript = fs.readFileSync(path.join(root, 'scripts/analyst/setup_profile.sh'), 'utf8');

  assert.match(startScript, /HERMES_TUI_TOOL_PROGRESS="off"/);
  assert.match(startScript, /serve --isolated --skip-build --open-profile analyst/);
  assert.match(startScript, /\.hermes_home == \$home/);
  assert.match(setupScript, /config migrate <\/dev\/null/);
  assert.match(setupScript, /config get display\.tool_progress/);
});

test('uses Nous Luna first and direct OpenAI Luna only as a credential-free fallback declaration', () => {
  const profile = YAML.parse(fs.readFileSync(path.join(root, 'config/analyst/config.yaml'), 'utf8'));

  assert.deepEqual(profile.model, {
    default: 'openai/gpt-5.6-luna',
    provider: 'nous',
    base_url: 'https://inference-api.nousresearch.com/v1',
  });
  assert.deepEqual(profile.fallback_providers, [{
    provider: 'openai-api',
    model: 'gpt-5.6-luna',
  }]);
  assert.equal(profile.fallback_providers[0].api_key, undefined);
  assert.equal(profile.fallback_providers[0].key_env, undefined);
});

test('keeps general Analyst answers grounded while server-owned reviews remain deterministic', () => {
  const soul = fs.readFileSync(path.join(root, 'config/analyst/SOUL.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, 'config/analyst/skills/the-analyst/SKILL.md'), 'utf8');

  assert.match(soul, /verified market\/portfolio fact/i);
  assert.match(soul, /Do not make unsourced deductions, extrapolations, scenarios, predictions, trade ideas/i);
  assert.match(skill, /no unsourced interpretation is added/i);
  assert.match(soul, /ReviewRunV2|server-owned review/i);
  assert.match(skill, /ReviewRunV2|server-owned review/i);
});

test('owns exactly three per-launch ReviewRunV2 workflows over bounded HTTP', () => {
  const panel = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystPanel.jsx'), 'utf8');
  const conversationPanel = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystConversationPanel.jsx'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'src/services/analyst/analystClient.js'), 'utf8');
  const gateway = fs.readFileSync(path.join(root, 'src/services/analyst/analystGatewayProxy.cjs'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/analyst.cjs'), 'utf8');
  const sidecar = fs.readFileSync(path.join(root, 'scripts/analyst_sidecar/app.py'), 'utf8');
  const runner = fs.readFileSync(path.join(root, 'scripts/analyst_sidecar/review_runs_v2.py'), 'utf8');
  const market = fs.readFileSync(path.join(root, 'scripts/analyst_sidecar/market.py'), 'utf8');
  const docs = fs.readFileSync(path.join(root, 'docs/THE_ANALYST.md'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(conversationPanel, /id: 'portfolio-review',[\s\S]*label: 'Portfolio Review'/);
  assert.match(conversationPanel, /id: 'prediction-markets-review',[\s\S]*label: 'Predictive Markets Review'/);
  assert.match(conversationPanel, /id: 'balance-review',[\s\S]*label: 'Balance Review'/);
  assert.doesNotMatch(conversationPanel, /aria-label="GM"/);
  assert.doesNotMatch(conversationPanel, /label: 'Options Review'/);
  assert.doesNotMatch(conversationPanel, /'portfolio-review': 'review:portfolio-review'/);
  assert.match(conversationPanel, /analystApi\.createReviewConversation\(reviewKind, \{ requestId: launchRequestId \}\)/);
  assert.match(conversationPanel, /className="analyst-running-dots"/);
  assert.doesNotMatch(conversationPanel, /PortfolioReviewProgress|PortfolioSectionEvidence/);
  assert.match(panel, /class AnalystErrorBoundary/);
  assert.match(client, /async startReview[\s\S]*\/api\/analyst\/reviews/);
  assert.match(client, /async createReviewConversation[\s\S]*\/api\/analyst\/review-conversations/);
  assert.match(client, /async retryReviewConversation[\s\S]*\/retries/);
  assert.match(routes, /router\.post\('\/reviews'/);
  assert.match(routes, /router\.get\('\/review-conversations'/);
  assert.match(routes, /router\.post\('\/review-conversations\/:reviewKind\/runs'/);
  assert.match(routes, /router\.get\('\/review-conversations\/:conversationId'/);
  assert.match(routes, /router\.delete\('\/review-conversations\/:conversationId'/);
  assert.match(routes, /router\.post\('\/review-conversations\/:conversationId\/retries'/);
  assert.match(routes, /router\.get\('\/reviews\/:runId'/);
  assert.match(routes, /router\.get\('\/reviews\/:runId\/status'/);
  assert.match(routes, /features:[\s\S]*gm: false/);
  assert.match(gateway, /ANALYST_REVIEW_PROTOCOL_RETIRED/);
  assert.match(gateway, /message\.action === 'new_prompt'/);
  assert.match(gateway, /message\.action === 'review_prompt'/);
  assert.match(gateway, /message\.action === 'resume_review'/);
  assert.doesNotMatch([...YAML.parse(fs.readFileSync(path.join(root, 'config/analyst/config.yaml'), 'utf8')).mcp_servers['market-dashboard-analyst'].tools.include].join(','), /portfolio_review_packet/);
  assert.match(runner, /class ReviewRunV2Store/);
  assert.match(runner, /class ReviewCoordinatorV2/);
  assert.match(runner, /CREATE TABLE IF NOT EXISTS analyst_review_conversations_v1/);
  assert.match(runner, /def create_conversation\(/);
  assert.match(runner, /def list_conversations\(/);
  assert.match(runner, /"portfolio-review": 75/);
  assert.match(runner, /"prediction-markets-review": 30/);
  assert.match(runner, /"balance-review": 20/);
  assert.match(runner, /MAX_SUMMARY_INPUT_BYTES = 32_000/);
  assert.match(runner, /MAX_SUMMARY_OUTPUT_TOKENS = 1_200/);
  assert.match(runner, /SUMMARY_TIMEOUT_SECONDS = 12/);
  assert.match(runner, /def canonical_fingerprint\(/);
  assert.match(runner, /def interrupt_active_attempts\(/);
  assert.match(sidecar, /async def _portfolio_review_v2_handler/);
  assert.match(sidecar, /async def _prediction_review_v2_handler/);
  assert.match(sidecar, /async def _balance_review_v2_handler/);
  assert.match(sidecar, /reviewCoordinator/);
  assert.match(market, /PREDICTIVE_REVIEW_UNIVERSE/);
  assert.match(market, /\("silver", "Silver", "forecastex"\)/);
  assert.match(market, /\("gold", "Gold", "kalshi"\)/);
  assert.match(market, /\("wti", "WTI", "kalshi"\)/);
  assert.match(market, /\("brent", "Brent", "kalshi"\)/);
  assert.match(market, /\("bitcoin", "Bitcoin", "kalshi"\)/);
  assert.match(market, /\("sp500", "S&P 500", "forecastex"\)/);
  assert.match(docs, /ReviewRunV2/i);
  assert.match(docs, /Predictive Markets Review/i);
  assert.match(docs, /stale.*cached.*fallback/is);
  assert.match(packageJson.scripts['test:analyst:python'], /ruff check --select F821/);
});

test('keeps review progress in the rail and review output in a normal transcript', () => {
  const panel = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystConversationPanel.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystPanel.css'), 'utf8');

  assert.match(panel, /const STREAM_COMMIT_INTERVAL_MS = 150/);
  assert.match(panel, /function conversationReducer/);
  assert.match(panel, /const Message = memo/);
  assert.match(panel, /message\.streaming[\s\S]*analyst-streaming-text/);
  assert.match(panel, /analyst-running-dots/);
  assert.match(panel, /Retry with fresh data/);
  assert.match(panel, /analystApi\.reviewStatus\(runId\)/);
  assert.doesNotMatch(panel, /setInterval\(/);
  assert.doesNotMatch(styles, /analyst-review-progress|analyst-review-section/);
  assert.match(styles, /\.analyst-running-dots/);
});

test('keeps Analyst conversation names visually static on hover', () => {
  const styles = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystPanel.css'), 'utf8');

  assert.doesNotMatch(styles, /\.analyst-conversation-title:hover/);
});

test('keeps position tables content-sized, compact, and centered outside the contract column', () => {
  const styles = fs.readFileSync(path.join(root, 'src/components/Dashboard/AnalystPanel.css'), 'utf8');

  assert.match(styles, /\.analyst-table-frame\s*\{[^}]*width:\s*fit-content;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.analyst-markdown \.analyst-table-frame table\s*\{[^}]*width:\s*max-content;[^}]*max-width:\s*none;/s);
  assert.match(styles, /\.analyst-markdown \.analyst-table-frame th,[\s\S]*?padding:\s*5px 6px;/);
  assert.match(styles, /th\[align='center'\],[\s\S]*?td\[align='center'\]\s*\{\s*text-align:\s*center;/);
  assert.match(styles, /\.is-event-contracts td:not\(:first-child\)[\s\S]*?text-align:\s*center;[\s\S]*?white-space:\s*nowrap;/);
  assert.match(styles, /\.is-event-contracts td:first-child\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow-wrap:\s*normal;/s);
});

test('creates distinct ephemeral 256-bit Analyst tokens', () => {
  let call = 0;
  const runtime = createAnalystRuntimeEnvironment((size) => {
    call += 1;
    return Buffer.alloc(size, call);
  });
  assert.equal(runtime.ANALYST_SERVICE_TOKEN.length, 64);
  assert.equal(runtime.HERMES_DASHBOARD_SESSION_TOKEN.length, 64);
  assert.notEqual(runtime.ANALYST_SERVICE_TOKEN, runtime.HERMES_DASHBOARD_SESSION_TOKEN);
  assert.equal(runtime.ANALYST_CONTRACT_VERIFIED, 'false');
  assert.equal(Object.isFrozen(runtime), true);
});

test('scopes the Hermes gateway token to Hermes and Express, never the browser UI', () => {
  const runtime = {
    ANALYST_SERVICE_TOKEN: 'research-token',
    HERMES_DASHBOARD_SESSION_TOKEN: 'hermes-token',
    ANALYST_CONTRACT_VERIFIED: 'true',
  };
  const inherited = {
    PATH: process.env.PATH,
    ANALYST_SERVICE_TOKEN: 'inherited-research-secret',
    HERMES_DASHBOARD_SESSION_TOKEN: 'inherited-hermes-secret',
    ANALYST_CONTRACT_VERIFIED: 'true',
    AWS_ACCESS_KEY_ID: 'must-be-removed',
  };

  const ui = childEnvironment('ui', inherited, runtime);
  assert.equal(ui.ANALYST_SERVICE_TOKEN, undefined);
  assert.equal(ui.HERMES_DASHBOARD_SESSION_TOKEN, undefined);
  assert.equal(ui.ANALYST_CONTRACT_VERIFIED, undefined);

  const api = childEnvironment('api', inherited, runtime);
  assert.equal(api.ANALYST_SERVICE_TOKEN, 'research-token');
  assert.equal(api.HERMES_DASHBOARD_SESSION_TOKEN, 'hermes-token');
  assert.equal(api.ANALYST_CONTRACT_VERIFIED, 'true');

  const sidecar = childEnvironment('analystSidecar', inherited, runtime);
  assert.equal(sidecar.ANALYST_SERVICE_TOKEN, 'research-token');
  assert.equal(sidecar.HERMES_DASHBOARD_SESSION_TOKEN, undefined);
  assert.equal(sidecar.ANALYST_CONTRACT_VERIFIED, undefined);

  const hermes = childEnvironment('analystHermes', inherited, runtime);
  assert.equal(hermes.ANALYST_SERVICE_TOKEN, 'research-token');
  assert.equal(hermes.HERMES_DASHBOARD_SESSION_TOKEN, 'hermes-token');
  assert.equal(hermes.ANALYST_CONTRACT_VERIFIED, undefined);
  assert.equal(hermes.AWS_ACCESS_KEY_ID, undefined);
});

test('recognizes only the exact Analyst sidecar and Hermes commands', () => {
  assert.equal(
    hasExactAnalystSidecarCommandSignature(
      `${root}/scripts/analyst_sidecar/.venv/bin/uvicorn app:app --host 127.0.0.1 --port 6951`,
      `${root}/scripts/analyst_sidecar`,
    ),
    true,
  );
  assert.equal(
    hasExactAnalystHermesCommandSignature(
      `${process.env.HOME}/.hermes/hermes-agent/venv/bin/hermes -p analyst serve --isolated --skip-build --host 127.0.0.1 --port 9121`,
      root,
    ),
    true,
  );
  assert.equal(hasExactAnalystHermesCommandSignature('hermes serve --port 9121', root), false);
});

test('requires deep streaming and persistence evidence before enabling general Analyst chat', () => {
  let invocation;
  const checks = Object.fromEntries([
    'list', 'create', 'mostRecent', 'history', 'interrupt', 'promptStreaming',
    'messageStart', 'messageDelta', 'messageComplete',
    'mcpToolHistory', 'mcpToolResume',
    'reconnect', 'resume', 'persistence',
  ].map((name) => [name, true]));
  const verified = runAnalystContractCheck({
    runtimeEnvironment: { HERMES_DASHBOARD_SESSION_TOKEN: 'token' },
    run: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: JSON.stringify({ checks }) };
    },
  });
  assert.equal(verified.verified, true);
  assert.equal(invocation.args.at(-1), '--deep');
  assert.equal(invocation.options.timeout, 240_000);

  const rejected = runAnalystContractCheck({
    run: () => ({ status: 0, stdout: JSON.stringify({ checks: { list: true } }) }),
  });
  assert.equal(rejected.verified, false);
  assert.match(rejected.error, /incomplete/);
});
