// Editorial reference context, never a source of event times, estimates or results.
// Publisher methodology links reviewed 2026-09-04. Match both country and series:
// identically named releases can have different publishers and survey definitions.
const BLS_JOBS = {
  publisher: 'U.S. Bureau of Labor Statistics',
  cadence: 'Monthly · Employment Situation',
  sourceUrl: 'https://www.bls.gov/news.release/empsit.tn.htm',
  sourceLabel: 'BLS survey definitions',
};
const CANADA_JOBS = {
  publisher: 'Statistics Canada',
  cadence: 'Monthly · Labour Force Survey',
  sourceUrl: 'https://www.statcan.gc.ca/en/subjects-start/labour_',
  sourceLabel: 'Statistics Canada labour statistics',
};

const CATEGORY_CONTEXT = {
  central_bank: ['Central-bank policy decision or communication.', 'Compare the decision, guidance and forecasts with expectations; distinguish prepared remarks from questions and answers.'],
  employment: ['A labor-market indicator covering hiring, unemployment, wages or vacancies.', 'Check the precise survey, participation, hours worked and revisions before interpreting the headline.'],
  inflation: ['A price-growth indicator; the named series determines consumer, producer or consumption-price coverage.', 'Separate headline and core, monthly momentum and annual base effects; check component breadth.'],
  gdp: ['A measure of economic output and growth.', 'Check real versus nominal growth, annualization, domestic demand, inventories and revisions.'],
  pmi: ['A survey of business conditions and changes in activity.', 'Read new orders, employment and prices alongside the headline; distinguish flash from final estimates.'],
  retail_sales: ['A measure of retail spending over the reporting period.', 'Check price effects, underlying categories, autos and revisions before inferring real consumption.'],
  industrial_production: ['A measure of output in industrial sectors.', 'Check sector contributions, temporary disruptions and revisions for the underlying production trend.'],
  durable_goods: ['Orders for long-lived manufactured goods.', 'Check volatile transport orders and underlying capital-goods demand; distinguish orders from shipments.'],
  confidence: ['A survey of household or business sentiment.', 'Compare expectations with current conditions and hard activity data; check any inflation-expectations measures.'],
};

export function getMarketEventBriefing(event) {
  const name = event.name || '';
  if (event.countryCode === 'US' && /average hourly earnings/i.test(name)) {
    return {
      ...BLS_JOBS,
      summary: 'Average hourly pay of employees on private nonfarm payrolls, from the establishment survey. “m/m” measures the change from the prior month.',
      watch: 'Read wages with payrolls and the workweek. Changes in the mix of high- and low-paid jobs can move the average without equivalent wage changes for individual workers.',
      markets: 'Wage momentum informs the inflation and policy outlook. Watch front-end Treasury yields, USD and rate-sensitive equities for confirmation.',
    };
  }
  if (event.countryCode === 'US' && /non[- ]?farm (?:employment|payroll)/i.test(name) && !/ADP/i.test(name)) {
    return {
      ...BLS_JOBS,
      summary: 'Monthly change in nonfarm payroll jobs from the establishment survey. It counts jobs, including multiple jobs held by one person.',
      watch: 'Compare with consensus and prior-month revisions; inspect private hiring, sector breadth, wages and hours. Payrolls and the household unemployment survey can diverge.',
      markets: 'A major growth and Fed-policy input. Assess Treasury yields, USD, equity cyclicals and credit together; the inflation backdrop shapes the response.',
    };
  }
  if (event.countryCode === 'US' && /unemployment rate/i.test(name)) {
    return {
      ...BLS_JOBS,
      summary: 'Share of the civilian labor force that is unemployed, measured by the household survey. This is a different survey from payroll employment.',
      watch: 'Check participation and household employment: unemployment can fall as people leave the labor force. Compare with underemployment and payrolls.',
      markets: 'Labor slack informs the Fed’s employment mandate. Watch the policy-rate path, Treasury curve and USD alongside growth-sensitive assets.',
    };
  }
  if (event.countryCode === 'CA' && /^(?:unemployment rate|employment change)$/i.test(name)) {
    return {
      ...CANADA_JOBS,
      summary: /unemployment/i.test(name)
        ? 'Share of Canada’s labor force that is unemployed, measured in the monthly household Labour Force Survey.'
        : 'Monthly change in the number of employed people in Canada, measured in the household Labour Force Survey.',
      watch: 'Check participation, full-time versus part-time jobs, hours and wages. Simultaneous U.S. labor releases can obscure the Canadian signal in USD/CAD.',
      markets: 'Relevant to Bank of Canada policy expectations, Canadian government yields and CAD. Compare domestic labor momentum with the U.S. report.',
    };
  }
  if (event.countryCode === 'UK' && /\bBOE\b|bank of england|official bank rate/i.test(name)) {
    const speech = /speaks|speech|testif/i.test(name);
    return {
      publisher: 'Bank of England',
      cadence: speech ? 'Scheduled appearance · timing varies' : 'Scheduled monetary-policy communication',
      sourceUrl: 'https://www.bankofengland.co.uk/monetary-policy',
      sourceLabel: 'Bank of England policy framework',
      summary: speech
        ? 'Public remarks by the Bank of England official named in the calendar. The appearance may give context on inflation, wages, growth and the policy outlook.'
        : 'A Bank of England policy release explaining the interest-rate stance and the inflation outlook.',
      watch: speech
        ? 'Look for changes in policy language, services inflation and wage concerns. Confirm the topic, transcript and Q&A; the calendar does not contain the speech or a policy decision.'
        : 'Read the rate decision, vote split, forecasts and forward guidance together. Compare changes with the previous communication.',
      markets: 'Watch sterling, front-end gilt yields and UK rate expectations. The relevance depends on new policy information in the communication.',
    };
  }
  if (event.countryCode === 'CA' && /\bBOC\b|bank of canada|overnight rate/i.test(name)) {
    return {
      publisher: 'Bank of Canada',
      cadence: 'Scheduled monetary-policy communication',
      sourceUrl: 'https://www.bankofcanada.ca/core-functions/monetary-policy/',
      sourceLabel: 'Bank of Canada monetary policy',
      summary: /overnight rate/i.test(name)
        ? 'The Bank of Canada’s target for the overnight interest rate, its main policy rate.'
        : 'Bank of Canada commentary explaining the policy decision and economic outlook; a press conference can add detail through Q&A.',
      watch: 'Compare the decision and guidance with expectations. Read inflation, excess supply and growth language, then check for clarification in the press conference.',
      markets: 'Watch CAD, Canadian front-end rates and the Canada–U.S. rate differential for the market’s interpretation.',
    };
  }
  if (event.countryCode === 'US' && /\bCPI\b|consumer price/i.test(name)) {
    return {
      publisher: 'U.S. Bureau of Labor Statistics',
      cadence: 'Monthly · Consumer Price Index',
      sourceUrl: 'https://www.bls.gov/cpi/',
      sourceLabel: 'BLS Consumer Price Index',
      summary: 'Changes in prices paid by urban consumers for a basket of goods and services. Core CPI excludes food and energy; m/m and y/y use different comparison periods.',
      watch: 'Check monthly core momentum, shelter and services, component breadth and annual base effects. CPI and the Fed’s preferred PCE inflation measure have different weights and coverage.',
      markets: 'An inflation and policy repricing catalyst. Monitor nominal and real Treasury yields, breakevens, USD and duration-sensitive equities.',
    };
  }
  if (event.countryCode === 'US' && /ISM (manufacturing|services)/i.test(name)) {
    return {
      publisher: 'Institute for Supply Management (ISM)',
      cadence: 'Monthly · PMI survey',
      sourceUrl: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-pmi-reports/',
      sourceLabel: 'ISM PMI reports',
      summary: 'Survey-based assessment of activity in the named sector. A headline index above 50 indicates expansion in that sector; below 50 indicates contraction.',
      watch: 'Read new orders, employment and prices alongside the headline. Slower supplier deliveries can reflect supply constraints as well as stronger demand.',
      markets: 'Helps assess growth versus price pressure. Watch Treasury yields, USD and cyclical equities; manufacturing and services can tell different stories.',
    };
  }
  const context = CATEGORY_CONTEXT[event.category];
  return {
    publisher: 'Not verified for this series',
    cadence: 'See the calendar time; release frequency is not verified',
    summary: context?.[0] || 'A high-impact economic event listed by the calendar provider.',
    watch: context?.[1] || 'Confirm the release definition and official publication before interpreting it.',
    markets: `Assess the surprise, revisions and policy implications for ${event.currency}, local rates and risk assets. This is general context; a series-specific briefing is not yet available.`,
  };
}
