const QUAD_PROBABILITY_SCENARIOS = [
  {
    id: 'us-monthly',
    label: 'US Monthly',
    periods: [
      {
        id: 'sep-25',
        label: 'Sep-25',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 6,
          q2: 8,
          q3: 48,
          q4: 38,
        },
      },
      {
        id: 'oct-25',
        label: 'Oct-25',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 3,
          q2: 21,
          q3: 61,
          q4: 15,
        },
      },
      {
        id: 'nov-25',
        label: 'Nov-25',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 3,
          q2: 27,
          q3: 63,
          q4: 7,
        },
      },
      {
        id: 'dec-25',
        label: 'Dec-25',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 8,
          q2: 3,
          q3: 23,
          q4: 66,
        },
      },
      {
        id: 'jan-26',
        label: 'Jan-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 75,
          q2: 2,
          q3: 15,
          q4: 8,
        },
      },
      {
        id: 'feb-26',
        label: 'Feb-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 50,
          q2: 19,
          q3: 8,
          q4: 23,
        },
      },
      {
        id: 'mar-26',
        label: 'Mar-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 7,
          q2: 9,
          q3: 46,
          q4: 38,
        },
      },
      {
        id: 'apr-26',
        label: 'Apr-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 65,
          q2: 3,
          q3: 7,
          q4: 25,
        },
      },
      {
        id: 'may-26',
        label: 'May-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 34,
          q2: 42,
          q3: 13,
          q4: 11,
        },
      },
      {
        id: 'jun-26',
        label: 'Jun-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 29,
          q2: 24,
          q3: 21,
          q4: 26,
        },
      },
      {
        id: 'jul-26',
        label: 'Jul-26',
        description: 'Next-month US monthly quad mix',
        probabilities: {
          q1: 15,
          q2: 18,
          q3: 37,
          q4: 30,
        },
      },
      {
        id: 'aug-26',
        label: 'Aug-26',
        description: 'US monthly quad mix',
        probabilities: {
          q1: 25,
          q2: 30,
          q3: 25,
          q4: 20,
        },
      },
    ],
  },
  {
    id: 'us-quarterly',
    label: 'US Quarterly',
    periods: [
      {
        id: '2q26e',
        label: '2Q26E',
        description: 'US quarterly conditional quad probabilities',
        probabilities: {
          q1: 1.2,
          q2: 46.5,
          q3: 51,
          q4: 1.3,
        },
      },
      {
        id: '3q26e',
        label: '3Q26E',
        description: 'US quarterly conditional quad probabilities',
        probabilities: {
          q1: 11,
          q2: 16,
          q3: 43.4,
          q4: 29.6,
        },
      },
      {
        id: '4q26e',
        label: '4Q26E',
        description: 'US quarterly conditional quad probabilities',
        probabilities: {
          q1: 14.8,
          q2: 54.9,
          q3: 23.9,
          q4: 6.4,
        },
      },
      {
        id: '1q27e',
        label: '1Q27E',
        description: 'US quarterly conditional quad probabilities',
        probabilities: {
          q1: 32.1,
          q2: 14.2,
          q3: 16.4,
          q4: 37.3,
        },
      },
    ],
  },
  {
    id: 'global',
    label: 'Global',
    periods: [],
  },
];

const DEFAULT_QUAD_PROBABILITY_SCENARIO_ID = 'us-monthly';
const DEFAULT_QUAD_PROBABILITY_PERIOD_ID = 'jul-26';

module.exports = {
  DEFAULT_QUAD_PROBABILITY_PERIOD_ID,
  DEFAULT_QUAD_PROBABILITY_SCENARIO_ID,
  QUAD_PROBABILITY_SCENARIOS,
};
