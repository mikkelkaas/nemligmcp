// log-dinner.mjs — tell the planner the family cooked a dinner, without an order behind it.
//
// Why this exists: the rotation ranks dishes by the last day they were cooked, and the only
// thing that used to write that history was `apply.mjs` - a bought basket. So a meal cooked
// from what was already in the fridge, a dinner eaten at grandparents', or a dish the family
// simply refuses to repeat, left no trace, and the next plan offered it again as if it were
// news. A printed plan is deliberately NOT cooked evidence (dinners.mjs), which is what makes
// two runs of the same command give the same menu. That is only honest if there is a way to
// record a real meal, and this is it.
//
// What it writes: one JSON line per dish into data/cooked-log.jsonl - the same file
// apply.mjs appends, the same shape. Nothing else, no network, no basket.
//
// Usage:
//   node log-dinner.mjs --dish "Pasta med kylling" [--dish <more>] [--day YYYY-MM-DD]
//   node log-dinner.mjs --list                 # the pool with its last cooked day
//   node log-dinner.mjs --dish "..." --dry-run # what would be written

import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA, PROFILES } from "./paths.mjs";
import { score } from "./match.mjs";
import { readCookHistory } from "./dinners.mjs";

const USAGE = `log-dinner.mjs - record a cooked dinner, so the rotation moves without an order
  --dish "<name or recipe url>"   the dinner eaten, repeated for several
  --day YYYY-MM-DD               the evening it was eaten (default: today, Europe/Copenhagen)
  --list                         the recipe pool with the last cooked day of each dish
  --dry-run                      print the line instead of appending it
`;

const LOG = join(DATA, "cooked-log.jsonl");
const POOL_FILE = join(PROFILES, "recipe-pool.json");
const dayRe = /^\d{4}-\d{2}-\d{2}$/;

function argAll(name) {
  const out = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i] === `--${name}` && argv[i + 1]) out.push(String(argv[i + 1]));
  return out;
}
const flag = (name) => process.argv.includes(`--${name}`);
const argValue = (name, dflt) => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? String(argv[i + 1] ?? dflt) : dflt;
};

/** Today as the family counts it, in YYYY-MM-DD, so a meal logged at 23:30 belongs to the day
 *  the family ate it, not to the UTC date. Same rule as the plan file's own stamp. */
function today(timeZone = "Europe/Copenhagen") {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

function loadPool() {
  if (!existsSync(POOL_FILE)) return null;
  try {
    const p = JSON.parse(readFileSync(POOL_FILE, "utf8"));
    return Array.isArray(p.pool) ? p.pool : null;
  } catch { return null; }
}

/** The dish the family named, if the pool holds it. Names and recipe urls both work, and a
 *  name that matches nothing gets the closest names, because "pasta med kylling" usually means
 *  a dish the family remembers by ear. The matcher is the planner's own name score; when not a
 *  single word survives it - a misspelling - the words shared with each dish are counted
 *  instead, so the family gets a shortlist rather than a shrug. */
function resolveDish(pool, wanted) {
  const exact = pool.find((p) => p.url === wanted || p.name.toLowerCase() === wanted.toLowerCase());
  if (exact) return { hit: exact, close: [] };
  const scored = pool.map((p) => ({ p, s: score(wanted, p.name) })).sort((a, b) => b.s - a.s);
  const ranked = scored.filter((r) => r.s > 0).slice(0, 3);
  if (ranked.length) return { hit: null, close: ranked.map((r) => `${r.p.name} (${r.s})`) };
  const words = new Set(String(wanted).toLowerCase().split(/[^a-zæøå0-9]+/).filter((w) => w.length > 3));
  const shared = pool
    .map((p) => ({ p, n: String(p.name).toLowerCase().split(/[^a-zæøå0-9]+/).filter((w) => words.has(w)).length }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3);
  return { hit: null, close: shared.map((r) => r.p.name) };
}

function listPool(pool, cooked) {
  const rows = pool.map((p) => ({ p, ago: cooked[p.url] ? cooked[p.url].last : "never" }));
  rows.sort((a, b) => String(a.ago).localeCompare(String(b.ago)));
  for (const r of rows) console.log(`  ${String(r.ago).padEnd(11)} ${r.p.name} (${r.p.protein || "-"}, ${r.p.minutes || "-"} min)`);
  console.log(`${rows.length} dish(es) in ${POOL_FILE}. The next plan takes the oldest first.`);
}

function main() {
  const wanted = argAll("dish");
  const day = (argValue("day", today()) || today()).slice(0, 10);
  if (flag("help") || (wanted.length === 0 && !flag("list"))) { console.log(USAGE); process.exitCode = wanted.length ? 0 : 1; return; }
  if (!dayRe.test(day)) { console.error(`FAIL: --day "${day}" is not YYYY-MM-DD - the planner keeps days, not clock times.`); process.exitCode = 1; return; }
  if (day > today()) { console.error(`FAIL: --day ${day} is in the future - a dinner is logged when it is eaten, so the queue moves honestly.`); process.exitCode = 1; return; }
  if (wanted.length > 8) { console.error(`FAIL: ${wanted.length} dishes at once is not a meal - log at most 8.`); process.exitCode = 1; return; }

  const pool = loadPool();
  if (!pool) { console.error(`FAIL: no recipe pool at ${POOL_FILE} - run node pick-recipe-pool.mjs first.`); process.exitCode = 2; return; }
  const cooked = readCookHistory({ linesFile: join(DATA, "order-lines-raw.jsonl"), rotationFile: join(DATA, "rotation.json"), cookedFile: LOG });
  if (flag("list")) { listPool(pool, cooked); return; }

  const found = [];
  for (const w of wanted) {
    const { hit, close } = resolveDish(pool, w);
    if (!hit) {
      console.error(`FAIL: "${w}" is not in the recipe pool${close.length ? ` - did you mean: ${close.join(", ")}?` : " - and the pool holds no close name."}`);
      process.exitCode = 1;
      continue;
    }
    found.push(hit);
  }
  if (!found.length) return;

  const lines = found.map((p) => JSON.stringify({ at: day, url: p.url, name: p.name, minutes: p.minutes || null, protein: p.protein || null }));
  if (flag("dry-run")) {
    console.log(`would append ${lines.length} line(s) to ${LOG}:`);
    for (const l of lines) console.log(`  ${l}`);
    return;
  }
  try {
    appendFileSync(LOG, lines.join("\n") + "\n");
  } catch (e) {
    console.error(`FAIL: the cooked log ${LOG} could not be written: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  for (const p of found) {
    const before = cooked[p.url];
    console.log(`  logged: ${p.name} eaten ${day}${before ? ` (last recorded ${before.last}, ${before.times} time(s))` : " (first time recorded)"}`);
  }
  console.log(`${lines.length} dinner(s) added to ${LOG}. Run node plan.mjs again: the queue puts them last now.`);
}

main();
