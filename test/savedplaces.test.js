import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSavedPlaces, coordsFromMapsUrl, slugify, linkSource, parseCsv,
} from '../src/savedplaces.js';

// Fish Shop, Smithfield, Dublin — a real entry from trips/ireland/places.json, so the
// expected coordinates here are the ones the engine already routes against.
const LAT = 53.34728;
const LNG = -6.28196;

test('GeoJSON is read longitude-first', () => {
  // The whole point. [lng, lat] read as [lat, lng] puts Dublin at 53°W in the Atlantic,
  // and every distanceM() downstream is quietly wrong rather than failing.
  const doc = JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [LNG, LAT, 0] },
      properties: {
        Title: 'Fish Shop',
        Location: { Address: '76 Benburb St, Smithfield, Dublin, Ireland' },
        'Google Maps URL': 'https://www.google.com/maps/place/?q=place_id:abc',
      },
    }],
  });
  const { format, places } = parseSavedPlaces(doc);
  assert.equal(format, 'geojson');
  assert.equal(places.length, 1);
  assert.equal(places[0].lat, 53.34728);
  assert.equal(places[0].lng, -6.28196);
  assert.ok(places[0].lat > 0 && places[0].lng < 0, 'Dublin is north and west');
  assert.equal(places[0].address, '76 Benburb St, Smithfield, Dublin, Ireland');
  assert.equal(places[0].id, 'fish-shop');
});

test('nested Geo Coordinates are used when geometry is absent', () => {
  const doc = JSON.stringify([{
    Title: 'Kutir',
    Location: {
      Address: '10 Lincoln St, London',
      'Geo Coordinates': { Latitude: 51.4925, Longitude: -0.1662 },
    },
  }]);
  const { places } = parseSavedPlaces(doc);
  assert.equal(places[0].lat, 51.4925);
  assert.equal(places[0].lng, -0.1662);
});

test('the pin wins over the viewport in a Maps URL', () => {
  // @-coords are where the camera was; !3d/!4d is the actual place.
  const url = 'https://www.google.com/maps/place/Fish+Shop/@53.4,-6.9,17z/data=!4m5!3m4!1s0x0!8m2!3d53.34728!4d-6.28196';
  const c = coordsFromMapsUrl(url);
  assert.equal(c.from, 'pin');
  assert.equal(c.lat, LAT);
  assert.equal(c.lng, LNG);
});

test('viewport coordinates are used but flagged as needing a check', () => {
  const csv = 'Title,URL\nSome Bar,"https://www.google.com/maps/place/Some+Bar/@51.5137,-0.135,17z"\n';
  const { places } = parseSavedPlaces(csv);
  assert.equal(places.length, 1);
  assert.equal(places[0].lat, 51.5137);
  assert.match(places[0].verified, /viewport, not the pin/);
});

test('a name-only CSV is still usable when the URL carries coordinates', () => {
  // Reports conflict on whether Takeout list CSVs include addresses. This is the case
  // where they do not, and recovering coords from the URL is the only thing that saves it.
  const csv = 'Title,Note,URL\n'
    + 'Fish Shop,Great chips,"https://www.google.com/maps/place/x/data=!3d53.34728!4d-6.28196"\n'
    + 'Nowhere Cafe,,"https://maps.app.goo.gl/shortlink"\n';
  const { format, places, unresolved } = parseSavedPlaces(csv);
  assert.equal(format, 'csv');
  assert.equal(places.length, 1);
  assert.equal(places[0].name, 'Fish Shop');
  assert.equal(places[0].why, 'Great chips');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].name, 'Nowhere Cafe');
  assert.equal(unresolved[0].source, 'maps-short');
  assert.match(unresolved[0].reason, /shortened/);
});

test('Instagram and TikTok links are reported, never invented', () => {
  const links = [
    'https://www.instagram.com/reel/Cabc123/',
    'https://www.tiktok.com/@someone/video/7123456789',
    'https://www.google.com/maps/place/Guinness+Storehouse/@53.3419,-6.2867,17z/data=!8m2!3d53.3419!4d-6.2867',
  ].join('\n');
  const { format, places, unresolved } = parseSavedPlaces(links);
  assert.equal(format, 'links');
  assert.equal(places.length, 1, 'only the Maps link can be placed');
  assert.equal(places[0].name, 'Guinness Storehouse');
  assert.equal(unresolved.length, 2);
  assert.deepEqual(unresolved.map((u) => u.source).sort(), ['instagram', 'tiktok']);
  for (const u of unresolved) assert.match(u.reason, /post has to be opened/);
  // Nothing unplaceable may acquire a coordinate: the engine would route the group there.
  for (const p of places) assert.ok(isFinite(p.lat) && isFinite(p.lng));
});

test('duplicate names get distinct ids', () => {
  const doc = JSON.stringify([
    { Title: 'The Bar', Location: { 'Geo Coordinates': { Latitude: 1, Longitude: 2 } } },
    { Title: 'The Bar', Location: { 'Geo Coordinates': { Latitude: 3, Longitude: 4 } } },
    { Title: 'The Bar', Location: { 'Geo Coordinates': { Latitude: 5, Longitude: 6 } } },
  ]);
  const { places } = parseSavedPlaces(doc);
  assert.deepEqual(places.map((p) => p.id), ['the-bar', 'the-bar-2', 'the-bar-3']);
});

test('0,0 is treated as missing, not as a place in the Atlantic', () => {
  const doc = JSON.stringify([{ Title: 'Bad Row', Location: { 'Geo Coordinates': { Latitude: 0, Longitude: 0 } } }]);
  const { places, unresolved } = parseSavedPlaces(doc);
  assert.equal(places.length, 0);
  assert.equal(unresolved.length, 1);
});

test('slugify strips accents and punctuation', () => {
  assert.equal(slugify('Café Niña & Co.'), 'cafe-nina-and-co');
  assert.equal(slugify('!!!'), 'place');
});

test('linkSource recognises the platforms people paste', () => {
  assert.equal(linkSource('https://instagram.com/p/x'), 'instagram');
  assert.equal(linkSource('https://vm.tiktok.com/x'), 'tiktok');
  assert.equal(linkSource('https://maps.app.goo.gl/x'), 'maps-short');
  assert.equal(linkSource('https://www.google.co.uk/maps/place/x'), 'maps');
  assert.equal(linkSource('https://example.com'), 'web');
});

test('parseCsv handles quoted commas and CRLF', () => {
  const rows = parseCsv('Title,Note\r\n"Smith, John","said ""hi"""\r\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].Title, 'Smith, John');
  assert.equal(rows[0].Note, 'said "hi"');
});

test('empty and malformed input fail loudly, not silently', () => {
  assert.deepEqual(parseSavedPlaces('').places, []);
  assert.equal(parseSavedPlaces('').format, 'empty');
  assert.throws(() => parseSavedPlaces('{not json'), /will not parse/);
});

test('imported places match the shape places.json already uses', () => {
  const doc = JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      geometry: { coordinates: [LNG, LAT] },
      properties: { Title: 'Fish Shop', Location: { Address: 'Dublin' } },
    }],
  });
  const [p] = parseSavedPlaces(doc).places;
  for (const key of ['id', 'name', 'category', 'lat', 'lng', 'visitMin', 'verified']) {
    assert.ok(key in p, `missing ${key}`);
  }
  assert.equal(typeof p.visitMin, 'number');
  assert.equal(typeof p.category, 'string');
});
