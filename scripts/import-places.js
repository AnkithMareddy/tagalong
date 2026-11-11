#!/usr/bin/env node
// Turn saved places into a trip's places.json.
//
//   node scripts/import-places.js <file> [more files...] --trip <name> [options]
//
// Accepts, in any mix:
//   * Google Takeout  "Maps (your places)/Saved Places.json"
//   * a Google Maps list exported as CSV
//   * a text file of links pasted out of a group chat (Instagram, TikTok, Maps)
//
// Options:
//   --trip <name>        trip folder under trips/ (required unless --stdout)
//   --category <cat>     category for imported places (default: sights)
//   --merge              keep existing places.json entries, add only new ids
//   --stdout             print the result instead of writing a file
//
// Nothing is ever given an invented coordinate. Places that cannot be located are
// written to places.unresolved.json with the reason, because a place with a guessed
// location is worse than a missing one — the engine would route the group to it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSavedPlaces } from '../src/savedplaces.js';

function parseArgs(argv) {
  const files = [];
  const opts = { category: 'sights', merge: false, stdout: false, trip: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--trip') { opts.trip = argv[++i]; continue; }
    if (a === '--category') { opts.category = argv[++i]; continue; }
    if (a === '--merge') { opts.merge = true; continue; }
    if (a === '--stdout') { opts.stdout = true; continue; }
    if (a === '-h' || a === '--help') { opts.help = true; continue; }
    if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    files.push(a);
  }
  return { files, opts };
}

const USAGE = `
Usage: node scripts/import-places.js <file...> --trip <name> [--category sights] [--merge] [--stdout]

Reads Google Takeout "Saved Places.json", a Google Maps list CSV, or a file of
pasted links, and writes trips/<name>/places.json.
`.trim();

function main() {
  let files;
  let opts;
  try {
    ({ files, opts } = parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help || !files.length) {
    console.log(USAGE);
    process.exit(files.length ? 0 : 2);
  }
  if (!opts.trip && !opts.stdout) {
    console.error(`--trip is required (or use --stdout)\n\n${USAGE}`);
    process.exit(2);
  }

  const all = [];
  const unresolved = [];
  const seen = new Set();

  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`no such file: ${file}`);
      process.exit(1);
    }
    let result;
    try {
      result = parseSavedPlaces(readFileSync(file, 'utf8'), { defaultCategory: opts.category });
    } catch (e) {
      console.error(`${file}: ${e.message}`);
      process.exit(1);
    }
    console.error(`${file}: read as ${result.format} — ${result.places.length} placed, ${result.unresolved.length} unresolved`);
    for (const p of result.places) {
      if (seen.has(p.id)) continue;      // same place saved in two lists
      seen.add(p.id);
      all.push(p);
    }
    unresolved.push(...result.unresolved);
  }

  const payload = { places: all, unresolved };

  if (opts.stdout) {
    console.log(JSON.stringify(payload, null, 1));
    return;
  }

  const dir = join('trips', opts.trip);
  mkdirSync(dir, { recursive: true });
  const placesPath = join(dir, 'places.json');

  let out = all;
  if (opts.merge && existsSync(placesPath)) {
    const existing = JSON.parse(readFileSync(placesPath, 'utf8'));
    const have = new Set(existing.map((p) => p.id));
    const added = all.filter((p) => !have.has(p.id));
    out = [...existing, ...added];
    console.error(`merged: ${existing.length} existing + ${added.length} new = ${out.length}`);
  } else if (existsSync(placesPath)) {
    console.error(`overwriting ${placesPath} (${JSON.parse(readFileSync(placesPath, 'utf8')).length} entries) — use --merge to keep them`);
  }

  writeFileSync(placesPath, `${JSON.stringify(out, null, 1)}\n`);
  console.error(`wrote ${placesPath} — ${out.length} places`);

  if (unresolved.length) {
    const upath = join(dir, 'places.unresolved.json');
    writeFileSync(upath, `${JSON.stringify(unresolved, null, 1)}\n`);
    console.error(`wrote ${upath} — ${unresolved.length} that need a human`);
    const bySource = {};
    for (const u of unresolved) bySource[u.source || 'unknown'] = (bySource[u.source || 'unknown'] || 0) + 1;
    for (const [s, n] of Object.entries(bySource)) console.error(`    ${n} ${s}`);
  }

  console.error('\nNext: set each place\'s category and neighborhood, then `npm run check-data`.');
}

main();
