// Turn the places someone already saved into a trip's places.json.
//
// WHY THIS IS TOLERANT RATHER THAN A SINGLE PARSER
// The first two trips' places.json were built by hand — the entries still say
// "from your Google list". Automating that means reading whatever people actually have,
// and that is not one format:
//
//   * Google Takeout, "Maps (your places)/Saved Places.json" — GeoJSON FeatureCollection
//   * Google Maps custom lists exported as CSV — column names vary, and several reports
//     say some of these CSVs carry only a name and a URL, with no address or coordinates
//   * a plain list of links pasted out of a group chat — Instagram, TikTok, Maps shares
//
// So nothing here assumes one schema. Property names are looked up across the spellings
// Google has used, and when coordinates are missing from the fields we try to recover
// them from the Maps URL instead, which is what makes a name-only CSV usable at all.
//
// Two traps worth stating, because both fail silently:
//   1. GeoJSON is LONGITUDE FIRST — [lng, lat, alt]. Reading it as [lat, lng] puts
//      London in the Atlantic and every distance calculation downstream is wrong.
//   2. In a Maps URL, `@lat,lng,17z` is the VIEWPORT CENTRE, not the pin. The pin is in
//      `!3d<lat>!4d<lng>`. They are usually close and occasionally not, so !3d/!4d wins.
//
// Anything we cannot place is returned in `unresolved` rather than dropped or guessed at.
// A place with no coordinates is worse than a missing place: the engine would route the
// group to it.

const COORD_KEYS = {
  lat: ['Latitude', 'latitude', 'lat', 'Lat'],
  lng: ['Longitude', 'longitude', 'lng', 'lon', 'Lng', 'Long'],
};

// Candidate paths for each field, in order of trust. A path is an array of keys.
const FIELD_PATHS = {
  name: [
    ['Title'], ['title'], ['name'], ['Name'],
    ['Location', 'Business Name'], ['location', 'name'],
  ],
  address: [
    ['Location', 'Address'], ['location', 'address'],
    ['Address'], ['address'], ['Formatted Address'],
  ],
  url: [
    ['Google Maps URL'], ['google_maps_url'], ['URL'], ['url'], ['Url'], ['link'], ['Link'],
  ],
  note: [['Note'], ['note'], ['Comment'], ['comment'], ['Description'], ['description']],
};

function dig(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function firstOf(obj, paths) {
  for (const path of paths) {
    const v = dig(obj, path);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function coordsFromObject(obj) {
  // Google nests these under Location > Geo Coordinates, but has also shipped them flat.
  const holders = [
    dig(obj, ['Location', 'Geo Coordinates']),
    dig(obj, ['location', 'geo_coordinates']),
    dig(obj, ['Geo Coordinates']),
    dig(obj, ['Location']),
    obj,
  ];
  for (const h of holders) {
    if (!h || typeof h !== 'object') continue;
    const lat = Number(firstOf(h, COORD_KEYS.lat.map((k) => [k])));
    const lng = Number(firstOf(h, COORD_KEYS.lng.map((k) => [k])));
    if (isFinite(lat) && isFinite(lng) && (lat !== 0 || lng !== 0)) return { lat, lng };
  }
  return null;
}

/**
 * Pull coordinates out of a Google Maps URL.
 * Order matters: !3d/!4d is the pin, @lat,lng is only where the camera was pointing.
 * Returns null for short links (goo.gl, maps.app.goo.gl) — those need a network fetch,
 * which this module deliberately does not do.
 */
export function coordsFromMapsUrl(url) {
  if (typeof url !== 'string') return null;

  const pin = url.match(/!3d(-?\d+\.?\d*)!4d(-?\d+\.?\d*)/);
  if (pin) return { lat: Number(pin[1]), lng: Number(pin[2]), from: 'pin' };

  const q = url.match(/[?&](?:q|query|ll|daddr)=(-?\d+\.\d+)%2C(-?\d+\.\d+)/i)
    || url.match(/[?&](?:q|query|ll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/i);
  if (q) return { lat: Number(q[1]), lng: Number(q[2]), from: 'query' };

  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (at) return { lat: Number(at[1]), lng: Number(at[2]), from: 'viewport' };

  return null;
}

export function slugify(name, taken = new Set()) {
  let base = String(name || 'place')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'place';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Which platform a pasted link came from — used to say why a place needs a look. */
export function linkSource(url) {
  if (!url) return null;
  if (/instagram\.com/i.test(url)) return 'instagram';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  if (/(^|\.)goo\.gl|maps\.app\.goo\.gl/i.test(url)) return 'maps-short';
  if (/google\.[a-z.]+\/maps|maps\.google\./i.test(url)) return 'maps';
  return 'web';
}

// --- CSV ------------------------------------------------------------------------------
// Hand-rolled because Takeout CSVs are small and quoted fields are the only wrinkle;
// pulling in a dependency for this would be the larger cost.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// --- the one entry point --------------------------------------------------------------

/**
 * @param {string} text  file contents: Saved Places.json, a list CSV, or pasted links
 * @param {object} [opts]
 * @param {string} [opts.defaultCategory='sights']
 * @returns {{format:string, places:Array, unresolved:Array}}
 */
export function parseSavedPlaces(text, opts = {}) {
  const defaultCategory = opts.defaultCategory || 'sights';
  const raw = String(text || '').trim();
  if (!raw) return { format: 'empty', places: [], unresolved: [] };

  let entries = [];
  let format = 'unknown';

  if (raw[0] === '{' || raw[0] === '[') {
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw new Error(`looks like JSON but will not parse: ${e.message}`);
    }
    if (Array.isArray(doc)) {
      format = 'json-array';
      entries = doc;
    } else if (Array.isArray(doc.features)) {
      format = 'geojson';
      entries = doc.features.map((f) => {
        const props = { ...(f.properties || {}) };
        // GeoJSON is [lng, lat, alt]. Getting this backwards is the classic silent bug.
        const c = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
        if (c && c.length >= 2) {
          props.__geo = { lng: Number(c[0]), lat: Number(c[1]) };
        }
        return props;
      });
    } else {
      format = 'json-object';
      entries = [doc];
    }
  } else if (/^https?:\/\//im.test(raw) && !raw.includes(',')) {
    format = 'links';
    entries = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((url) => ({ url }));
  } else if (raw.includes(',')) {
    format = 'csv';
    entries = parseCsv(raw);
    // A "CSV" that is really a newline-separated link list with commas inside the URLs.
    if (entries.length && Object.keys(entries[0]).length === 1 && /^https?:/i.test(Object.keys(entries[0])[0])) {
      format = 'links';
      entries = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((url) => ({ url }));
    }
  } else {
    format = 'links';
    entries = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((url) => ({ url }));
  }

  const places = [];
  const unresolved = [];
  const taken = new Set();

  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const url = firstOf(e, FIELD_PATHS.url) || (typeof e.url === 'string' ? e.url : undefined);
    const source = linkSource(url);
    let name = firstOf(e, FIELD_PATHS.name);
    const address = firstOf(e, FIELD_PATHS.address);
    const note = firstOf(e, FIELD_PATHS.note);

    // Last resort for a bare link: the place name is often in the Maps URL path.
    if (!name && url && (source === 'maps')) {
      const m = url.match(/\/maps\/place\/([^/@?]+)/);
      if (m) name = decodeURIComponent(m[1].replace(/\+/g, ' ')).trim();
    }

    let coords = e.__geo && isFinite(e.__geo.lat) ? { lat: e.__geo.lat, lng: e.__geo.lng, from: 'geojson' } : null;
    if (!coords) coords = coordsFromObject(e);
    if (!coords) coords = coordsFromMapsUrl(url);

    if (!coords) {
      // Kept, not dropped, and never given a guessed location — the engine routes people
      // to these, so an invented coordinate is worse than an admitted gap.
      unresolved.push({
        name: name || null,
        url: url || null,
        source,
        note: note || null,
        reason: source === 'instagram' || source === 'tiktok'
          ? 'social link — the post has to be opened to find out what the place is'
          : source === 'maps-short'
            ? 'shortened Maps link — needs to be opened once to expand'
            : 'no coordinates in the file and none recoverable from the URL',
      });
      continue;
    }

    const id = slugify(name || `place-${places.length + 1}`, taken);
    taken.add(id);
    const place = {
      id,
      name: name || id.replace(/-/g, ' '),
      category: defaultCategory,
      lat: Number(coords.lat.toFixed(5)),
      lng: Number(coords.lng.toFixed(5)),
      visitMin: 45,
    };
    if (address) place.address = address;
    if (note) place.why = note;
    if (url) place.url = url;
    place.verified = [
      `imported from your ${format === 'geojson' ? 'Google Takeout saved places' : format === 'csv' ? 'Google Maps list' : 'saved links'}`,
      coords.from === 'viewport' ? 'coordinates are the map viewport, not the pin — worth a check' : null,
      'category, hours and visit length are defaults',
    ].filter(Boolean).join('; ');
    places.push(place);
  }

  return { format, places, unresolved };
}
