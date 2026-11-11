import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INTERESTS, QUESTIONS, interestsFromAnswers, resolveInterests,
  excludedCategories, describeInterests,
} from '../src/interests.js';
import { rankPlaces } from '../src/recommend.js';

test('the defaults are the values that used to be hardcoded in recommend.js', () => {
  // Pinned deliberately. If this fails, the London and Ireland trips just silently
  // changed their recommendations.
  assert.equal(DEFAULT_INTERESTS.streetwear, 1);
  assert.equal(DEFAULT_INTERESTS.sneakers, 0.95);
  assert.equal(DEFAULT_INTERESTS.nature, 0.85);
  assert.equal(DEFAULT_INTERESTS.venue, 0.3);
  assert.equal(Object.keys(DEFAULT_INTERESTS).length, 18);
});

test('an unanswered questionnaire changes nothing', () => {
  assert.deepEqual(interestsFromAnswers([]), DEFAULT_INTERESTS);
  assert.deepEqual(interestsFromAnswers(undefined), DEFAULT_INTERESTS);
});

test('picking interests raises those categories', () => {
  const i = interestsFromAnswers(['outdoors', 'history']);
  assert.equal(i.nature, 1);
  assert.equal(i.drive, 0.9);
  assert.equal(i.history, 1);
  assert.equal(i.sights, 0.9);
  // untouched categories keep their default
  assert.equal(i.streetwear, DEFAULT_INTERESTS.streetwear);
});

test('an exclusion beats a stated interest', () => {
  // Someone who ticks "shopping" and "skip shopping" has contradicted themselves.
  // Suggesting something they explicitly ruled out is the worse failure, so skip wins.
  const i = interestsFromAnswers(['shopping', 'no-shopping']);
  assert.equal(i.shopping, 0);
  assert.equal(i.streetwear, 0);
  assert.equal(i.sneakers, 0);
  assert.deepEqual(
    excludedCategories(i),
    ['fashion', 'shopping', 'sneakers', 'streetwear', 'vintage'],
  );
});

test('resolveInterests merges a partial trip override over the defaults', () => {
  const i = resolveInterests({ interests: { nature: 1, sights: 0 } });
  assert.equal(i.nature, 1);
  assert.equal(i.sights, 0);
  assert.equal(i.food, DEFAULT_INTERESTS.food, 'unmentioned categories keep defaults');
});

test('resolveInterests clamps nonsense instead of trusting the file', () => {
  const i = resolveInterests({ interests: { nature: 42, food: -3, pub: 'yes' } });
  assert.equal(i.nature, 1);
  assert.equal(i.food, 0);
  assert.equal(i.pub, DEFAULT_INTERESTS.pub, 'non-numeric is ignored, not coerced to 0');
});

test('a trip with no interests block gets the defaults', () => {
  assert.deepEqual(resolveInterests({}), DEFAULT_INTERESTS);
  assert.deepEqual(resolveInterests(null), DEFAULT_INTERESTS);
});

test('every question option maps to known categories only', () => {
  // Guards against a typo in the questionnaire silently creating a category nothing uses.
  const known = new Set([...Object.keys(DEFAULT_INTERESTS), 'bar', 'latenight']);
  for (const q of QUESTIONS) {
    for (const opt of q.options) {
      for (const cat of Object.keys(opt.effects)) {
        assert.ok(known.has(cat), `${q.id}/${opt.id} targets unknown category "${cat}"`);
      }
      assert.ok(opt.label && opt.id, `${q.id} has an option missing id or label`);
    }
  }
});

test('interests actually change the ranking', () => {
  const now = new Date(Date.UTC(2026, 9, 10, 12, 0));
  const here = { lat: 51.5137, lng: -0.1350 };
  const places = [
    { id: 'shop', name: 'Sneaker Shop', category: 'sneakers', lat: 51.5140, lng: -0.1352, visitMin: 30, hours: { daily: '09:00-21:00' } },
    { id: 'ruin', name: 'Old Abbey', category: 'history', lat: 51.5142, lng: -0.1354, visitMin: 30, hours: { daily: '09:00-21:00' } },
  ];
  const base = { places, here, now, gapMin: 240 };

  const shopper = rankPlaces({ ...base, interests: interestsFromAnswers(['shopping']) });
  assert.equal(shopper[0].place.id, 'shop');

  const historian = rankPlaces({ ...base, interests: interestsFromAnswers(['history', 'no-shopping']) });
  assert.equal(historian[0].place.id, 'ruin');

  // And omitting interests must reproduce the old hardcoded behaviour exactly.
  const legacy = rankPlaces(base);
  const explicit = rankPlaces({ ...base, interests: DEFAULT_INTERESTS });
  assert.deepEqual(legacy.map((r) => r.place.id), explicit.map((r) => r.place.id));
  assert.deepEqual(legacy.map((r) => r.score), explicit.map((r) => r.score));
});

test('describeInterests names the strong preferences', () => {
  const s = describeInterests(interestsFromAnswers(['outdoors']));
  assert.match(s, /nature/);
  assert.equal(describeInterests({ food: 0.1 }), 'no strong preferences recorded');
});
