#!/usr/bin/env node
// Set up a new trip: asks what the trip is and what the group is into, then writes
// trips/<name>/itinerary.json ready for the bot to run.
//
//   node scripts/setup.js
//
// The interest questions are the point. Before this existed, how much a group cared
// about each category was a `const INTEREST` literal inside src/recommend.js, tuned for
// one group of five who are into streetwear — so anyone else deploying this got
// recommendations for somebody else's taste. The answers here become `trip.interests`,
// which the scorer reads per trip.
//
// Nothing is overwritten without being asked, and the file is written once at the end,
// so quitting halfway leaves no half-made trip behind.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { QUESTIONS, interestsFromAnswers, DEFAULT_INTERESTS, describeInterests } from '../src/interests.js';
import { slugify } from '../src/savedplaces.js';

// Interactive when there is a terminal; otherwise answers come from piped stdin, which
// makes setup scriptable and testable. This matters for more than convenience: with
// readline/promises, a question asked after stdin reaches EOF never resolves, the event
// loop drains, and node exits 0 having written nothing — a silent no-op that looks like
// success. Reading the lines up front removes that failure mode entirely.
const interactive = Boolean(stdin.isTTY);
const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null;
let piped = [];

async function readPipedLines() {
  if (interactive) return;
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function ask(prompt, fallback = '') {
  if (!interactive) {
    const next = (piped.shift() ?? '').trim();
    const chosen = next || fallback;
    console.log(`${prompt} ${chosen}`);
    return chosen;
  }
  const a = (await rl.question(fallback ? `${prompt} [${fallback}] ` : `${prompt} `)).trim();
  return a || fallback;
}

async function askChoices(q) {
  console.log(`\n${q.ask}`);
  q.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
  const hint = q.single ? 'pick one' : 'numbers separated by commas, or blank for none';
  const raw = interactive
    ? (await rl.question(`> (${hint}) `)).trim()
    : (piped.shift() ?? '').trim();
  if (!interactive) console.log(`> ${raw}`);
  if (!raw) return [];
  const picked = raw.split(/[,\s]+/).map((n) => Number(n) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length);
  const ids = picked.map((i) => q.options[i].id);
  return q.single ? ids.slice(0, 1) : ids;
}

function isoDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (!(d <= end)) return out;
  while (d <= end && out.length < 60) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

async function main() {
  await readPipedLines();
  console.log('\ntagalong — new trip setup\n' + '-'.repeat(26));

  const name = await ask('What do you want to call this trip?', 'My trip');
  const slug = slugify(name);
  const dir = join('trips', slug);
  if (existsSync(join(dir, 'itinerary.json'))) {
    const ok = await ask(`trips/${slug}/itinerary.json already exists. Overwrite? (y/N)`, 'N');
    if (!/^y/i.test(ok)) { console.log('Left it alone.'); rl?.close(); return; }
  }

  const region = await ask('Which city or region?', 'London');
  let from = await ask('First day (YYYY-MM-DD)?');
  while (from && !isoDate(from)) from = await ask('  needs to look like 2026-10-09 —');
  let to = await ask('Last day (YYYY-MM-DD)?', from);
  while (to && !isoDate(to)) to = await ask('  needs to look like 2026-10-12 —');
  const days = from && to ? daysBetween(from, to) : [];
  if (from && to && !days.length) console.log('  (those dates are backwards — leaving days empty)');

  const size = Number(await ask('How many of you?', '4')) || 4;
  const timezone = await ask('Timezone?', 'Europe/London');
  const currency = await ask('Currency?', 'GBP');
  const transport = (await ask('Getting around mostly by (transit/drive)?', 'transit')).toLowerCase().startsWith('d') ? 'drive' : 'transit';
  const about = await ask('Anything the bot should know? (where you are staying, how you get around)', '');

  const answers = [];
  for (const q of QUESTIONS) answers.push(...await askChoices(q));
  const interests = interestsFromAnswers(answers);

  // Store only what differs from the defaults, so the file says what this group chose
  // rather than restating all eighteen categories.
  const diff = {};
  for (const [cat, w] of Object.entries(interests)) {
    if (DEFAULT_INTERESTS[cat] !== w) diff[cat] = w;
  }

  const pace = answers.find((a) => ['packed', 'balanced', 'loose'].includes(a)) || 'balanced';
  const planningRules = {
    packed: 'Fill the gaps. Suggest something whenever there is more than an hour free.',
    balanced: "Fixed plans come first. Suggest things near where they are or on the way to the next fixed plan; don't send them across the city and back.",
    loose: 'Stay quiet unless asked, or unless something genuinely good is a short walk away.',
  }[pace];

  const itinerary = {
    trip: {
      name,
      region: { name: region },
      transport,
      currency,
      planningRules,
      sunPings: ['sunset'],
      size,
      about,
      timezone,
      days,
      // Built from what this group actually CHOSE, not from the resolved weights. The
      // resolved map still carries high defaults (streetwear 1.0, sneakers 0.95), so
      // describing that would tell the AI writer the group is into streetwear when they
      // never said so — and trip.group goes straight into its prompt.
      group: `${size} people. Into: ${describeInterests(Object.keys(diff).length ? diff : interests)}.`,
      ...(Object.keys(diff).length ? { interests: diff } : {}),
    },
    days: Object.fromEntries(days.map((d) => [d, { areas: [] }])),
    plans: [],
  };

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'itinerary.json'), `${JSON.stringify(itinerary, null, 1)}\n`);
  if (!existsSync(join(dir, 'places.json'))) writeFileSync(join(dir, 'places.json'), '[]\n');

  console.log(`\nWrote ${join(dir, 'itinerary.json')}`);
  if (Object.keys(diff).length) {
    console.log(`Interests recorded: ${Object.entries(diff).map(([c, w]) => `${c} ${w}`).join(', ')}`);
  } else {
    console.log('No interest overrides — using the defaults.');
  }
  console.log(`
Next:
  1. Export your saved places (Google Takeout > Maps (your places), or a list as CSV)
  2. node scripts/import-places.js <file> --trip ${slug}
  3. Fill in category and neighborhood for each place
  4. TRIP=${slug} npm run check-data
`);
  rl?.close();
}

main().catch((e) => { console.error(e.message); rl?.close(); process.exit(1); });
