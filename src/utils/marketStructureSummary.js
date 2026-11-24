// A few plain sentences under Market Structure's readings in the morning-research table, saying what each
// published reading means. Built only from the readings shown: a reading the product did not print adds no
// sentence, and an unrecognized value is left unexplained rather than guessed at.
const GAMMA = {
  negative: 'Dealers are short gamma, so their hedging runs with price and amplifies moves',
  positive: 'Dealers are long gamma, so their hedging runs against price and dampens moves',
  neutral: 'Dealer gamma is neutral, so hedging neither amplifies nor dampens moves',
};
const FLOW = {
  bearish: 'lean toward selling, most on breakdowns',
  bullish: 'lean toward buying, most on breakouts',
  neutral: 'have no lean either way',
};
const ALLOCATION = {
  'risk off': 'the allocation stance is Risk Off: cut gross, wider stops',
  'risk on': 'the allocation stance is Risk On: a calmer tape, tighter stops',
  neutral: 'the allocation stance is Neutral',
};
const PV_BAND = {
  long: 'favors the long side',
  short: 'favors the short side',
  neutral: 'favors neither side',
};
// Which way each reading leans, to name the one that disagrees with the rest.
const LEAN = {
  bearish: -1, 'risk off': -1, short: -1, bullish: 1, 'risk on': 1, long: 1,
};

const key = value => String(value ?? '').trim().toLowerCase();
const sentence = value => `${value.charAt(0).toUpperCase()}${value.slice(1)}.`;

export function marketStructureSummary(facts) {
  const reading = new Map((Array.isArray(facts) ? facts : [])
    .filter(fact => Array.isArray(fact) && fact.length === 2)
    .map(([label, value]) => [key(label), String(value).trim()]));
  const read = (...labels) => labels.map(label => reading.get(label)).find(Boolean);
  const gamma = GAMMA[key(read('spx gamma exposure', 'gamma exposure'))];
  const flow = FLOW[key(read('systematic flow risk'))];
  const allocation = ALLOCATION[key(read('strategic allocation'))];
  const band = key(read('pv band risk/reward'));
  const throttle = read('gamma throttle');
  const realized = read('10d realized vol');

  const lines = [];
  const moved = realized && `${realized} is how much SPX actually moved over the last 10 sessions`;
  if (gamma) {
    // The throttle is read against the gamma regime, so it is explained only beside it.
    const measures = [throttle && `the throttle (${throttle}) is the strength of that effect`, moved].filter(Boolean);
    lines.push(sentence([gamma, measures.join(', and ')].filter(Boolean).join('; ')));
  } else if (moved) {
    lines.push(sentence(moved));
  }
  const stance = [flow && `systematic funds (vol control, CTAs, risk parity) ${flow}`, allocation].filter(Boolean);
  if (stance.length) lines.push(sentence(stance.join(', and ')));
  if (PV_BAND[band]) {
    const others = ['systematic flow risk', 'strategic allocation'].map(label => LEAN[key(reading.get(label))]).filter(Boolean);
    const offset = LEAN[band] && others.length && others.every(lean => lean === -LEAN[band]);
    lines.push(sentence(`${offset ? 'The one offset is PV Band Risk/Reward, which' : 'PV Band Risk/Reward'} ${PV_BAND[band]} against the probable-volatility bands`));
  }
  return lines.length ? lines.join(' ') : null;
}
