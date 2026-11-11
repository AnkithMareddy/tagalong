// What this particular group cares about.
//
// WHY THIS EXISTS
// The weights below used to live as a `const INTEREST = {...}` literal inside
// recommend.js: streetwear 1.0, sneakers 0.95, nature 0.85. That is not a default, it is
// one specific friend group's taste compiled into the source. Anyone else deploying this
// would get recommendations tuned for five guys from California who are into streetwear,
// with no obvious place to change it.
//
// So the weights move here, the original values become DEFAULTS (so the London and
// Ireland trips behave exactly as they did), and a trip may override any of them in its
// own itinerary.json. `scripts/setup.js` asks the questions and writes that override.
//
// A weight is 0-1 and multiplies a place's base score, so 0 means "never suggest this"
// and 1 means "lead with it".

/**
 * The original hardcoded values. Kept byte-for-byte so existing trips are unaffected by
 * this refactor — if you are tempted to "fix" these, override them per trip instead.
 */
export const DEFAULT_INTERESTS = {
  streetwear: 1, sneakers: 0.95, fashion: 0.85, vintage: 0.8, music: 0.8, sports: 0.8,
  food: 0.6, market: 0.7, filming: 0.6, movies: 0.5, sights: 0.65, sportsbar: 0.5, venue: 0.3,
  nature: 0.85, pub: 0.7, history: 0.65, drive: 0.7, shopping: 0.85,
};

/**
 * Setup questions. Each answer maps onto category weights, so the questionnaire stays in
 * the group's language ("do you shop?") while the engine keeps scoring categories.
 *
 * `weight` is what that category becomes when the option is chosen. Picking nothing in a
 * question leaves those categories at their default rather than zeroing them — someone
 * who skips a question has not told us they hate everything in it.
 */
export const QUESTIONS = [
  {
    id: 'pace',
    ask: 'How full do you want the days?',
    options: [
      { id: 'packed', label: 'Packed — we want to see everything', effects: {} },
      { id: 'balanced', label: 'Balanced — a few fixed things a day', effects: {} },
      { id: 'loose', label: 'Loose — mostly wandering', effects: {} },
    ],
    single: true,
  },
  {
    id: 'interests',
    ask: 'What are you actually into? Pick as many as apply.',
    options: [
      { id: 'food', label: 'Food and restaurants', effects: { food: 1, market: 0.85 } },
      { id: 'bars', label: 'Bars and pubs', effects: { pub: 0.95, bar: 0.95, sportsbar: 0.7 } },
      { id: 'shopping', label: 'Shopping, fashion, sneakers', effects: { shopping: 1, streetwear: 1, fashion: 0.95, sneakers: 0.95, vintage: 0.85 } },
      { id: 'music', label: 'Music and nightlife', effects: { music: 1, venue: 0.8 } },
      { id: 'outdoors', label: 'Hiking, nature, scenic drives', effects: { nature: 1, drive: 0.9 } },
      { id: 'history', label: 'History, museums, castles', effects: { history: 1, sights: 0.9 } },
      { id: 'sports', label: 'Live sport', effects: { sports: 1, sportsbar: 0.85 } },
      { id: 'film', label: 'Film and filming locations', effects: { movies: 0.9, filming: 0.9 } },
      { id: 'sights', label: 'The famous stuff — landmarks and views', effects: { sights: 1, filming: 0.7 } },
    ],
  },
  {
    id: 'avoid',
    ask: 'Anything you would rather skip entirely?',
    options: [
      { id: 'no-tourist', label: 'Tourist landmarks', effects: { sights: 0, filming: 0.2 } },
      { id: 'no-shopping', label: 'Shopping', effects: { shopping: 0, streetwear: 0, sneakers: 0, fashion: 0, vintage: 0 } },
      { id: 'no-museums', label: 'Museums and history', effects: { history: 0, sights: 0.3 } },
      { id: 'no-late', label: 'Late nights', effects: { venue: 0.1, music: 0.3 } },
      { id: 'no-alcohol', label: 'Bars and drinking', effects: { pub: 0, bar: 0, sportsbar: 0.1 } },
    ],
  },
];

/**
 * Turn chosen option ids into a weight map.
 *
 * Order matters: `avoid` is applied after `interests`, so "I like shopping" plus
 * "skip shopping" resolves to skip. Saying both is contradictory, and the safer reading
 * of a contradiction is the exclusion — suggesting something a person explicitly ruled
 * out is a worse failure than omitting something they half-wanted.
 *
 * @param {string[]} chosen  option ids from any question
 * @param {object} [base]    starting weights, default DEFAULT_INTERESTS
 */
export function interestsFromAnswers(chosen, base = DEFAULT_INTERESTS) {
  const picked = new Set(chosen || []);
  const out = { ...base };
  const apply = (questionId) => {
    const q = QUESTIONS.find((x) => x.id === questionId);
    if (!q) return;
    for (const opt of q.options) {
      if (!picked.has(opt.id)) continue;
      for (const [cat, w] of Object.entries(opt.effects)) out[cat] = w;
    }
  };
  apply('interests');
  apply('avoid');
  return out;
}

/** Any category the group has effectively ruled out — useful for explaining a plan. */
export function excludedCategories(interests) {
  return Object.entries(interests).filter(([, w]) => w === 0).map(([c]) => c).sort();
}

/**
 * The weights to score with for a given trip.
 * A trip sets `interests` in its itinerary.json `trip` block; anything it does not
 * mention keeps the default, so a partial override is fine.
 */
export function resolveInterests(trip) {
  const override = trip && typeof trip.interests === 'object' ? trip.interests : null;
  if (!override) return DEFAULT_INTERESTS;
  const out = { ...DEFAULT_INTERESTS };
  for (const [cat, w] of Object.entries(override)) {
    const n = Number(w);
    if (isFinite(n)) out[cat] = Math.max(0, Math.min(1, n));
  }
  return out;
}

/** One line summarising the group, for the writer to use in messages. */
export function describeInterests(interests, limit = 5) {
  const top = Object.entries(interests)
    .filter(([, w]) => w >= 0.8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([c]) => c);
  return top.length ? top.join(', ') : 'no strong preferences recorded';
}
