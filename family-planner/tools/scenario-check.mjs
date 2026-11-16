#!/usr/bin/env node
// scenario-check.mjs — the evaluation battery, run as a command instead of a memory.
//
// Every scenario here was measured by hand once. This file is what makes the next
// regression cheap: it plans against the live shop inside a scratch copy of the home, so
// the real plan files and the real price cache are never touched, and it probes every
// basket guard against a CLOSED endpoint, so nothing can ever be added to a real basket.
//
//   node tools/scenario-check.mjs              about a minute, needs the shop reachable
//   node tools/scenario-check.mjs --offline    the guards and the arithmetic only, no calls
//   node tools/scenario-check.mjs --pure         only what needs no home: a scheduled job on a bare checkout
//   node tools/scenario-check.mjs --keep       leave the scratch home for inspection
//
// Exit 0: every scenario behaved. Exit 1: one regressed, and its own line says which.
// Run it after any change to plan.mjs, apply.mjs, catalog.mjs or trim.mjs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME, envFile, writeJsonAtomic } from "../paths.mjs";
import { validatePlan } from "../apply.mjs";
import { mergeItems, markdownNotes } from "../plan.mjs";
import { localStamp } from "../lib.mjs";
import { chooseDinners } from "../dinners.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_TIMEOUT_PLAN = 600000;      // a 14-day cold plan measured 10.3 s; 10 min is the guard
const NODE_TIMEOUT_FAST = 90000;       // a refusal costs no shop call
const EIGHT_DAYS = ["--days", "8", "--breakfast", "yes", "--lunchbox", "yes", "--snacks", "no", "--household", "auto"];
const FOURTEEN_DAYS = ["--days", "14", "--breakfast", "yes", "--lunchbox", "yes", "--snacks", "yes", "--household", "auto"];
const CLOSED = "http://127.0.0.1:9";   // nothing listens here; a closed port is the safety device

const results = [];
/** kind: "code" (the planner did something wrong) or "family" (the shop or the family made this
 *  true today, and the plan already named the line and carried something for it). doctor grades
 *  the two differently, so the kind travels with the failure. */
function record(name, ok, detail, kind = "code") {
  results.push({ name, ok, detail: String(detail || ""), kind });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
}

/** One node run, with its own timeout, captured. Never inherits this process's home. */
function nodeRun(script, argv, env, timeoutMs, label) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...argv], {
    encoding: "utf8", timeout: timeoutMs, env: { ...process.env, ...env },
  });
  if (r.error) return { code: -1, out: `spawn failed for ${label}: ${r.error.message}` };
  return { code: r.status === null ? -1 : r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** A scratch home: the same profiles and data, so the price cache is warm and the shelf is
 *  the one the family actually sees. Never a copy of a plan someone is about to approve. */
function scratchHome() {
  const dir = mkdtempSync(join(tmpdir(), "scenario-home-"));
  cpSync(join(HOME, "profiles"), join(dir, "profiles"), { recursive: true });
  cpSync(join(HOME, "data"), join(dir, "data"), { recursive: true });
  return { dir, env: { NEMLIG_HOME: dir, NEMLIG_ENV: envFile() } };
}

function planOf(home) {
  const file = join(home, "data", "plans", "plan-latest.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

function sumOf(plan) {
  return Number((plan.items || []).reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2));
}

/** The lines a plan's total is the sum of: the adds when the plan carries them, else all
 *  items. validatePlan uses the same basis, so a check that wants to read planTotal must. */
function totalBasisOf(plan) {
  return Array.isArray(plan.adds) ? plan.adds : (plan.items || []);
}

function sumForTotal(plan) {
  return Number(totalBasisOf(plan).reduce((s, i) => s + Number(i.total || 0), 0).toFixed(2));
}

/** A closed-endpoint env file, written into the scratch home. Credentials in it are fakes:
 *  the port answers nothing, so no endpoint is ever reached with anything real. */
function closedEnvFile(home) {
  const file = join(home, "closed.env");
  writeFileSync(file, `NEMLIG_USER=scenario-check\nNEMLIG_PASS=scenario-check\nMCP_SECRET=scenario-check\nNEMLIG_MCP_URL=${CLOSED}\n`);
  return file;
}

function applyRun(home, argv, label) {
  const file = closedEnvFile(home);
  return nodeRun("apply.mjs", argv, { NEMLIG_HOME: home, NEMLIG_ENV: file }, NODE_TIMEOUT_FAST, label);
}

/** A plan file copy, aged or emptied, for a guard probe. */
function handPlan(home, name, change) {
  const plan = planOf(home);
  if (!plan) return null;
  const copy = JSON.parse(JSON.stringify(plan));
  change(copy);
  const file = join(home, name);
  writeFileSync(file, JSON.stringify(copy));
  return file;
}

/** The guards, on a copy of the newest real plan, against a closed endpoint. These run even
 *  with --offline: a refusal costs no shop call, and this is what protects the basket. */
function checkGuards(dir) {
  const approve = ["--approve", "I-APPROVE-THIS-BASKET"];
  const cases = [
    // Each probe states the whole condition it is about. An unresolved line is a shop fact,
    // and it is refused before the age gate: the two age cases clear it, or they measure the
    // stock-out instead of the guard they name.
    { name: "guard:stale", make: (p) => { p.atIso = new Date(Date.now() - 40 * 3600000).toISOString(); p.unresolved = []; },
      expect: (r) => r.code === 5 && /h old/.test(r.out), want: "exit 5, named as hours old" },
    { name: "guard:no readable stamp", make: (p) => { p.atIso = null; p.createdAt = "sidst"; p.unresolved = []; },
      expect: (r) => r.code === 5 && /no readable time stamp/.test(r.out), want: "exit 5, an unknown age is refused too" },
    { name: "guard:unresolved line", make: (p) => { p.unresolved = [{ query: "Ost 38+", source: "dinners:test" }]; },
      expect: (r) => r.code === 4 && /Ost 38\+/.test(r.out), want: "exit 4, naming the line" },
    { name: "guard:no products", make: (p) => { p.items = []; },
      expect: (r) => r.code === 6 && /does not hold up/.test(r.out), want: "exit 6, the file is rejected" },
    { name: "guard:total does not add up", make: (p) => { p.planTotal = sumForTotal(p) + 50; },
      expect: (r) => r.code === 6 && /does not match/.test(r.out), want: "exit 6, arithmetic is checked" },
  ];
  for (const c of cases) {
    const file = handPlan(dir, `probe-${c.name.replace(/\W+/g, "-")}.json`, c.make);
    const r = applyRun(dir, ["--plan", file, ...approve], c.name);
    const reached = /ECONNREFUSED|fetch failed|add_to_basket/.test(r.out);
    record(c.name, c.expect(r) && !reached, `${c.want}; exit ${r.code}${reached ? " BUT IT REACHED AN ENDPOINT" : ""}`);
  }
  const missing = applyRun(dir, ["--plan", join(dir, "no-such-plan.json"), ...approve], "guard:missing file");
  record("guard:missing file", missing.code === 1 && /no plan file/.test(missing.out), `exit ${missing.code}, tells you to plan first`);
}

/** What a plan file must satisfy, run through the validator apply.mjs itself uses. */
function checkArithmetic(dir, label) {
  const plan = planOf(dir);
  if (!plan) return record(label, false, "no plan file to check");
  const problems = validatePlan(plan);
  const sum = sumForTotal(plan), total = Number(plan.planTotal);
  record(label, problems.length === 0 && Math.abs(sum - total) < 0.51,
    `${totalBasisOf(plan).length} line(s), they add up to ${sum.toFixed(2)}, planTotal says ${total.toFixed(2)}, validator: ${problems.length ? problems[0] : "clean"}`);
}

function checkEightDay(dir) {
  const r = checkPlanRun(dir, EIGHT_DAYS, "eight day");
  const lines = (r.plan && r.plan.items.length) || 0;
  const unres = (r.plan && r.plan.unresolved) || [];
  const near = (r.plan && r.plan.nearMisses) || [];
  // A line the shelf cannot fill stays a failure: apply.mjs blocks the basket until a person
  // decides, whatever the reason is. What the text adds is which line it is and what the plan
  // carried for it, so a stock-out reads as a family fact with a next step instead of looking
  // like the planner broke.
  const nearBy = new Map(near.map((n) => [n.query, n.candidates.length]));
  // plan.unresolved keeps only the query, the source and the reason; the alternative it carried
  // for that same line sits in plan.substitutions, keyed by the wanted query.
  const subbed = new Set(((r.plan && r.plan.substitutions) || []).map((s) => s.wanted));
  const detail = unres.map((u) => `${u.query} [${u.source}]`
    + `${subbed.has(u.query) ? " alternative named" : ""}${nearBy.get(u.query) ? ` ${nearBy.get(u.query)} near miss(es) printed` : ""}`).join("; ");
  const answered = (u) => subbed.has(u.query) || Number(nearBy.get(u.query) || 0) > 0;
  // The kind is what doctor grades on. "family" only when every blocked line already carries
  // its answer in the plan: then the shop, not the code, is the reason, and a person has a
  // choice to read. One line with nothing carried for it is treated as the code's own problem,
  // because that is the case where the planner should have found an alternative and did not.
  const kind = unres.length && unres.every(answered) ? "family" : "code";
  record("plan:8 days", r.code === 0 && /^PLAN /m.test(r.out) && unres.length === 0,
    `exit ${r.code}, ${lines} purchases, ${unres.length} not found${detail ? `: ${detail}` : ""}`, kind);
  checkArithmetic(dir, "plan:8 days adds up");
  return r;
}

function checkCacheAndMenu(dir) {
  const first = checkPlanRun(dir, EIGHT_DAYS, "warm first");
  const second = checkPlanRun(dir, EIGHT_DAYS, "warm second");
  const hit = Number((second.out.match(/(\d+) answered from cache/) || [])[1] || 0);
  const live = Number((second.out.match(/gate: (\d+) call/)|| [])[1] || 0);
  record("cache:a warm shelf answers from home", hit > 0 && live < hit, `second run: ${hit} from cache, ${live} live call(s)`);
  const md = join(dir, "data", "plans", "plan-latest.md");
  const named = existsSync(md) && readFileSync(md, "utf8").includes("## Menu ranked against");
  record("menu:says what it was ranked against", named && !!(planOf(dir) || {}).menuAgainst, "the alternation is named in the plan file");
  return first;
}

function checkFlagNotes(dir) {
  const cases = [
    { name: "note:days clamped with a warning", argv: ["--days", "99999", ...EIGHT_DAYS.slice(2)], want: /outside 1-14 - this run uses 14 evenings instead/, then: (r) => r.plan.options.days === 14 },
    { name: "note:days zero", argv: ["--days", "0", ...EIGHT_DAYS.slice(2)], want: /this run uses 1 evening instead/, then: (r) => r.plan.options.days === 1 },
    { name: "note:an amount that is not an amount", argv: [...EIGHT_DAYS, "--max-kr", "abc"], want: /is not an amount in kr above 0/, then: (r) => r.code === 0 },
    { name: "note:a yes-or-no word that is not one", argv: [EIGHT_DAYS[0], EIGHT_DAYS[1], "--breakfast", "maybe", ...EIGHT_DAYS.slice(4)], want: /--breakfast "maybe" is not yes or no - this run uses yes instead/, then: (r) => r.code === 0 },
    { name: "note:an unknown flag", argv: [...EIGHT_DAYS, "--frobnicate", "yes"], want: /unknown flag\(s\) --frobnicate/, then: (r) => r.code === 0 },
    { name: "note:no word is wasted on an empty list", argv: [...EIGHT_DAYS, "--avoid", ""], want: /--avoid "" names nothing/, then: (r) => r.code === 0 },
  ];
  for (const c of cases) {
    const r = checkPlanRun(dir, c.argv, c.name);
    record(c.name, c.want.test(r.out) && c.then(r), r.out.split("\n").find((l) => c.want.test(l)) || `no such warn line, exit ${r.code}`);
  }
}

/** What doctor says about a battery stamp that is missing, old, broken or carrying a failure.
 *  A silent check is worse than none: the stamp is the only thing that tells this home whether
 *  its guards were ever run. A failure the planner caused and a failure the shop caused must
 *  reach different levels, or a sold-out loaf hides the one line that matters behind a stop
 *  sign - so each state here has to land where the plan model says it should. */
function checkStamp(dir) {
  const stamp = join(dir, "data", "quality", "last-check.json");
  const env = { NEMLIG_HOME: dir, NEMLIG_ENV: envFile() };
  const dayMs = 24 * 3600 * 1000;
  const write = (body) => writeFileSync(stamp, typeof body === "string" ? body : JSON.stringify(body));
  const run = (label) => {
    const r = nodeRun("doctor.mjs", [], env, NODE_TIMEOUT_FAST, label);
    const line = r.out.split("\n").find((l) => /quality/.test(l)) || `(no quality line, exit ${r.code}: ${r.out.slice(0, 120)})`;
    return line.trim();
  };
  const at = new Date().toISOString();
  const cases = [
    { name: "stamp:never run", prepare: () => rmSync(stamp, { force: true }), want: /warn .* has never run/ },
    { name: "stamp:two weeks old", prepare: () => write({ at: new Date(Date.now() - 12 * dayMs).toISOString(), mode: "live", scenarios: 21, pass: 21, fail: 0, failedNames: [], commit: "scenario" }), want: /warn .* 12 d ago/ },
    {
      name: "stamp:a failure the planner caused",
      prepare: () => write({ at, mode: "live", scenarios: 21, pass: 20, fail: 1, failedNames: ["guard:stale"], failed: [{ name: "guard:stale", kind: "code", detail: "exit 0, expected 5" }], commit: "scenario" }),
      want: /STOP .*the planner caused: guard:stale/,
    },
    {
      name: "stamp:a failure the shop caused",
      prepare: () => write({ at, mode: "live", scenarios: 21, pass: 20, fail: 1, failedNames: ["plan:8 days"], failed: [{ name: "plan:8 days", kind: "family", detail: "Grovbrød øko skiver [lunchbox:rugbraod-skiver] alternative named" }], commit: "scenario" }),
      want: /warn .*shop could not fill.*Grovbrød øko skiver .*alternative named/,
    },
    {
      name: "stamp:a failure of an unknown kind",
      prepare: () => write({ at, mode: "live", scenarios: 21, pass: 20, fail: 1, failedNames: ["plan:8 days"], commit: "scenario" }),
      want: /STOP .*the planner caused: plan:8 days/,
    },
    { name: "stamp:unreadable", prepare: () => write("{ not json"), want: /warn .* cannot be read/ },
    { name: "stamp:fresh and clean", prepare: () => write({ at, mode: "live", scenarios: 21, pass: 21, fail: 0, failedNames: [], commit: "scenario" }), want: /ok .*scenario battery ran/ },
  ];
  for (const c of cases) {
    c.prepare();
    const line = run(c.name);
    record(c.name, c.want.test(line), line);
  }
}

/** --trim on and --trim off, started from the same state, on a shelf that cannot fit. */
function checkTrimPair(snapshot) {
  const a = scratchFrom(snapshot), b = scratchFrom(snapshot);
  const on = checkPlanRun(a, [...FOURTEEN_DAYS, "--max-kr", "1500", "--trim", "on"], "trim on");
  const off = checkPlanRun(b, [...FOURTEEN_DAYS, "--max-kr", "1500", "--trim", "off"], "trim off");
  const onSum = sumOf(on.plan), offSum = sumOf(off.plan);
  record("trim:off plans the whole basket, on meets the ceiling",
    offSum > 1500 && onSum < offSum && onSum <= 1500,
    `off ${offSum.toFixed(2)} kr stands whole, on ${onSum.toFixed(2)} kr fits the 1500 kr ceiling`);
  return [a, b];
}

/** A brand named in --avoid is gone from the basket, and the plan says what it cost. */
function checkAvoid(snapshot) {
  const control = scratchFrom(snapshot);
  const run = checkPlanRun(control, FOURTEEN_DAYS, "avoid control");
  const counts = new Map();
  for (const i of run.plan.items) counts.set(i.brand || "-", (counts.get(i.brand || "-") || 0) + 1);
  const brand = [...counts].sort((x, y) => y[1] - x[1]).map((c) => c[0]).find((b) => b !== "-");
  const home = scratchFrom(snapshot);
  const avoided = checkPlanRun(home, [...FOURTEEN_DAYS, "--avoid", brand], "avoid brand");
  const left = (avoided.plan.items || []).filter((i) => (i.brand || "-") === brand).length;
  // A pinned favourite of that brand is refused too, and it is named in the plan file: a
  // favourite that vanishes must never look like a product the shelf ran out of.
  const refusedPins = (avoided.plan.stalePins || []).filter((s) => s.refused);
  const md = join(home, "data", "plans", "plan-latest.md");
  const named = refusedPins.length === 0 || (existsSync(md) && readFileSync(md, "utf8").includes("refused by your own never-list"));
  record("avoid:a named brand leaves the basket", left === 0 && avoided.code === 0 && named,
    `"${brand}" was ${counts.get(brand)} lines, now ${left}, ${refusedPins.length} of them a refused favourite${named ? ", named in the plan" : ", NOT NAMED"}`);
  return [control, home];
}

/** A shelf nobody has cached: every intent must cost a real call, and the plan must still land. */
function checkCold(snapshot) {
  const home = scratchFrom(snapshot);
  rmSync(join(home, "data", "product-cache.json"), { force: true });
  const r = checkPlanRun(home, ["--days", "3", "--breakfast", "no", "--lunchbox", "no", "--snacks", "no", "--household", "auto", "--fresh"], "cold");
  const live = Number((r.out.match(/gate: (\d+) call/) || [])[1] || 0);
  record("cold:an empty cache is paid for once", r.code === 0 && live > 0, `${live} live call(s), exit ${r.code}`);
  return home;
}

/** The rotation, through the live shop. Two runs on the same state must give the same menu, and
 *  only a meal the family ate may move it. The planner used to sell the opposite as a feature:
 *  every run read its own printed plan as a cooked dinner, so the same command produced a
 *  different basket each time - fourteen plan files produced six menus, and nobody could say
 *  which one was theirs. */
function checkRotation(snapshot) {
  const a = scratchFrom(snapshot), b = scratchFrom(snapshot);
  const one = checkPlanRun(a, EIGHT_DAYS, "menu run 1");
  const two = checkPlanRun(b, EIGHT_DAYS, "menu run 2");
  const urls = (r) => (((r.plan || {}).dinnerMenu) || []).map((x) => x.url).join(",");
  const first = urls(one), again = urls(two);
  record("menu:the same state gives the same menu", Boolean(first) && first === again,
    `${first.split(",").length} dinners, identical on a second run against the same state`);
  // The queue moves when the family eats: a logged meal, then the same command again.
  const c = scratchFrom(snapshot);
  const eaten = ((((one.plan || {}).dinnerMenu) || [])[0] || {});
  const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const logged = nodeRun("log-dinner.mjs", ["--dish", String(eaten.name || ""), "--day", day],
    { NEMLIG_HOME: c, NEMLIG_ENV: envFile() }, NODE_TIMEOUT_FAST, "log a meal");
  const three = checkPlanRun(c, EIGHT_DAYS, "menu after logging");
  const after = urls(three).split(",");
  record("menu:a meal the family ate moves the queue",
    logged.code === 0 && after.length > 0 && eaten.url && !after.includes(eaten.url),
    `"${eaten.name}" logged as eaten ${day} and gone from the next menu (${after.length} dinners)`);
  return [a, b, c];
}

/** Seven evenings are bought for seven evenings, not eight. The tail of an odd period is the
 *  dish that gets cut short, and every portion after it is scaled to what is left - leftovers
 *  the family never eats are money, and the plan used to buy them happily. */
function checkEveningCover(snapshot) {
  const home = scratchFrom(snapshot);
  const r = checkPlanRun(home, ["--days", "7", "--breakfast", "no", "--lunchbox", "no", "--snacks", "no", "--household", "auto"], "seven evenings");
  const menu = ((r.plan || {}).dinnerMenu) || [];
  const covers = menu.reduce((n, m) => n + (Number(m.covers) || 0), 0);
  const last = menu[menu.length - 1] || {};
  const tiled = menu.every((m) => Number(String(m.days).split("-")[1]) === Number(String(m.days).split("-")[0]) + Number(m.covers) - 1);
  record("menu:seven evenings are bought for seven evenings",
    covers === 7 && (r.plan.uncoveredDays || 0) === 0 && tiled,
    `${menu.length} dinners cover ${covers} evenings${last.clipped ? `, the last cut to ${last.nights} night by the end of the period` : ""}`);
  return home;
}

/** Nothing a credential belongs in: the values from the env file must not appear in any file
 *  this battery wrote. The values are read, never printed. */
function checkSecrets(dirs) {
  const env = {};
  for (const line of readFileSync(envFile(), "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const secrets = ["NEMLIG_USER", "NEMLIG_PASS", "MCP_SECRET"].map((k) => env[k]).filter((v) => v && v.length >= 4);
  const files = [];
  for (const dir of dirs) {
    for (const sub of ["data/plans"]) {
      const p = join(dir, sub);
      if (existsSync(p)) files.push(...readdirSync(p).map((f) => join(p, f)));
    }
  }
  const leaks = files.filter((f) => { try { const t = readFileSync(f, "utf8"); return secrets.some((s) => t.includes(s)); } catch { return false; } });
  record("secrets:no credential in the plans it wrote", leaks.length === 0,
    `${secrets.length} value(s) scanned for across ${files.length} file(s), ${leaks.length} leak(s)`);
}

let seq = 0;
/** A copy of a state taken before any scenario ran, so two runs can be compared honestly.
 *  The destination is a path that does not exist yet: cpSync nests a copy inside an existing
 *  directory, and a home with a home inside it is a mystery, not a scenario. */
function scratchFrom(snapshot) {
  const dir = join(tmpdir(), `scenario-home-${process.pid}-${++seq}`);
  cpSync(snapshot, dir, { recursive: true });
  created.push(dir);
  return dir;
}

function checkPlanRun(dir, argv, label) {
  const r = nodeRun("plan.mjs", argv, { NEMLIG_HOME: dir, NEMLIG_ENV: envFile() }, NODE_TIMEOUT_PLAN, label);
  return { ...r, plan: planOf(dir) };
}

/** The uncertain-matcher band, checked without a shop: a name that came within 0,15 of the
 *  family's own bar must reach the plan as a priced choice with the flag that takes it. Pure
 *  functions, so it costs no call and runs on every battery, offline included. The second line
 *  carries names with quotes in them, because a printed flag is only useful if pasting it buys
 *  that product and not the word after it. */
function checkNearMiss() {
  const label = "near miss: a close name is printed as a decision, not bought or dropped";
  const DOUBLE = String.fromCharCode(34);
  try {
    const merged = mergeItems([{
      ok: false, query: "Ost revet danbo fast", source: "dinner:test",
      why: "no name reached 0.8 (best: Revet Ost Danbo (score 0.75))",
      nearNeed: "400 g",
      nearMiss: [{ sku: "9000002", name: "Revet Ost Danbo", brand: "Arla", price: 24, unitPrice: 60, pack: { raw: "400 g", qty: 400, unit: "g" }, score: 0.75 }],
    }, {
      ok: false, query: "Blandet grønt", source: "dinner:probe",
      why: "no name reached 0.7 (best: two near names)",
      nearNeed: "300 g",
      nearMiss: [
        { sku: "9000003", name: `Grønt ${DOUBLE}Blandet${DOUBLE} 300 g`, brand: "Nature", price: 12, unitPrice: 40, pack: { raw: "300 g", qty: 300, unit: "g" }, score: 0.62 },
        { sku: "9000004", name: `Blandet ${DOUBLE}Bland${DOUBLE}ed' 300 g`, brand: "Nature", price: 15, unitPrice: 50, pack: { raw: "300 g", qty: 300, unit: "g" }, score: 0.6 },
      ],
    }], false);
    const md = markdownNotes({
      skipped: [], items: [], unresolved: merged.unresolved, recipeGaps: [],
      substitutions: [], substitutedAway: [], nearMisses: merged.nearMisses,
    }).join("\n");
    const text = md.replace(/\\n/g, "\n");
    const line = (merged.nearMisses[0] || {}).candidates[0] || {};
    const flags = [
      [merged.nearMisses.length === 2, "the near misses survive the merge"],
      [line.sku === "9000002" && line.score === 0.75, "the sku and the score it reached travel with it"],
      [/Close but under your bar/.test(text), "the plan prints a section for it"],
      [/Revet Ost Danbo.*400 g for 24,00 kr/.test(text), "with the pack and the price, in Danish decimal"],
      [/`--extra "Revet Ost Danbo:400 g"`/.test(text), "and the exact flag that takes it"],
      [/— `Revet Ost Danbo`/.test(text), "the name sits in its own code span, so a quote cannot move its end"],
      [/`--extra 'Grønt "Blandet" 300 g:300 g'`/.test(text), "a name holding a double quote is flagged between single quotes"],
      [/no flag is safe to paste/.test(text) && /`--extra-file` \(sku 9000004\)/.test(text), "a name holding both quote kinds is given no flag to paste"],
      [/sku 9000002/.test(text), "and the sku, so the line can be checked before buying"],
      [merged.unresolved.length === 2, "both lines are still listed as not found: nothing was bought"],
    ];
    const bad = flags.filter((f) => !f[0]).map((f) => f[1]);
    record(label, bad.length === 0, bad.length ? "missing: " + bad.join("; ") : "2 near misses priced with a paste-safe flag each, quote-bearing names included");
  } catch (e) {
    record(label, false, "threw: " + e.message);
  }
}

const created = [];

/** Where a run's result is recorded, so `doctor.mjs` can say when quality was last checked.
 *  A stamp, not a log: one object, overwritten, always the newest word about this home. */
function stampPath() { return join(HOME, "data", "quality", "last-check.json"); }

/** The commit the battery just checked, or null. A run with no commit is still a run. A dirty
 *  tree says so: a stamp that names a commit the run did not contain is a stamp to ignore. */
function gitCommit() {
  const r = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  const head = String(r.stdout || "").trim().slice(0, 12);
  const d = spawnSync("git", ["-C", ROOT, "status", "--porcelain", "--", "."], { encoding: "utf8", timeout: 5000 });
  return head + (d.status === 0 && String(d.stdout || "").trim() ? "-dirty" : "");
}

function writeStamp(failed) {
  const stamp = {
    at: localStamp(),
    mode: process.argv.includes("--pure") ? "pure" : process.argv.includes("--offline") ? "offline" : "live",
    scenarios: results.length,
    pass: results.length - failed.length,
    fail: failed.length,
    failedNames: failed.map((f) => f.name),
    // The kind and the sentence travel, because doctor reads this file long after this process
    // is gone and has to tell "the shelf is out of rye bread" from "the planner is broken".
    // failedNames stays: a doctor from before the split reads that and treats every failure as
    // the dangerous kind, which is the safe way to read a stamp it does not understand.
    failed: failed.slice(0, 10).map((f) => ({ name: f.name, kind: f.kind, detail: f.detail.slice(0, 200) })),
    commit: gitCommit(),
    node: process.versions.node,
  };
  try {
    writeJsonAtomic(stampPath(), stamp);
    console.log(`stamp: ${stampPath()}  (${stamp.at}, ${stamp.mode}, ${stamp.pass}/${stamp.scenarios} pass, ${stamp.commit || "no commit"})`);
  } catch (e) {
    console.log(`warn: the result was not stamped (${e.message}) - doctor will report the battery as never run`);
  }
}

/** The family's own record of a meal, which is the only thing that moves the queue between
 *  orders. No shop call, so it runs in every mode: a name from the pool, one line in the cooked
 *  log, and a name the pool does not hold refused with a shortlist instead of a shrug. */
function checkLogDinner(dir) {
  const env = { NEMLIG_HOME: dir, NEMLIG_ENV: envFile() };
  const log = join(dir, "data", "cooked-log.jsonl");
  const readPool = () => { try { return JSON.parse(readFileSync(join(dir, "profiles", "recipe-pool.json"), "utf8")).pool || []; } catch { return []; } };
  if (readPool().length === 0) { record("log meal:a dinner the family ate is recorded", false, "no recipe pool in the scratch home"); return; }
  const day = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const name = String(readPool()[0].name || "");
  const r = nodeRun("log-dinner.mjs", ["--dish", name, "--day", day], env, NODE_TIMEOUT_FAST, "log one meal");
  const written = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes(day)).length : 0;
  const nonsense = nodeRun("log-dinner.mjs", ["--dish", "Qwertyuiop asdfg", "--day", day], env, NODE_TIMEOUT_FAST, "log nonsense");
  const future = nodeRun("log-dinner.mjs", ["--dish", name, "--day", "2099-01-01"], env, NODE_TIMEOUT_FAST, "log the future");
  record("log meal:a dinner the family ate is recorded",
    r.code === 0 && written === 1 && nonsense.code === 1 && /did you mean|no close name/.test(nonsense.out + nonsense.stderr) && future.code === 1,
    `${name} written for ${day}; a name the pool does not hold refused (exit ${nonsense.code}); a future evening refused (exit ${future.code})`);
}

/**
 * The mined menu data has a shelf life, and doctor reads it. No shop call: the scratch home is
 * copied, its pool is aged through the `at` the writer left in it, its raw order lines through
 * their modification time, and doctor is run against it twice - once as it came, once aged.
 */
function checkMenuDataAge(dir) {
  const pool = join(dir, "profiles", "recipe-pool.json");
  const lines = join(dir, "data", "order-lines-raw.jsonl");
  if (!existsSync(pool) || !existsSync(lines)) { record("data age:doctor grades the mined menu data", false, "no pool or raw order lines in the scratch home"); return; }
  const dayMs = 86400000;
  const env = { NEMLIG_HOME: dir, NEMLIG_ENV: envFile() };
  const ageText = (r) => String(r.out + r.stderr);
  const fresh = nodeRun("doctor.mjs", [], env, NODE_TIMEOUT_FAST, "doctor on fresh data");
  const poolWas = readFileSync(pool, "utf8");
  const oldAt = new Date(Date.now() - 60 * dayMs).toISOString().slice(0, 10) + "T09:00:00+01:00";
  writeFileSync(pool, poolWas.replace(/"at":\s*"[^"]*"/, `"at": ${JSON.stringify(oldAt)}`));
  const back = new Date(Date.now() - 45 * dayMs);
  utimesSync(lines, back, back);
  const aged = nodeRun("doctor.mjs", [], env, NODE_TIMEOUT_FAST, "doctor on aged data");
  writeFileSync(pool, poolWas);
  const hits = (ageText(aged).match(/mined \d+ d ago, older than/g) || []).length;
  const clean = !/mined \d+ d ago, older than/.test(ageText(fresh));
  record("data age:doctor grades the mined menu data",
    clean && hits >= 2 && /recipe-pool\.json/.test(ageText(aged)) && /order-lines-raw\.jsonl/.test(ageText(aged)),
    `fresh data says nothing; aged to 60 d (its own "at") and 45 d (mtime) it named ${hits} file(s) as warn`);
}

/**
 * Fourteen evenings - the longest period the planner accepts - filled from the family's own
 * pool. No shop call: the pool and its rotation rules are on disk. An evening without a dinner
 * is the failure this scenario exists to catch, because the menu is the plan's only promise
 * about what the family eats, and a hole in it is a hole in the basket.
 */
function checkMenuFills(dir) {
  const MAX_DAYS = 14;
  const poolFile = join(dir, "profiles", "recipe-pool.json");
  if (!existsSync(poolFile)) { record("menu:every evening has a dinner in the longest period", false, "no profiles/recipe-pool.json"); return; }
  const pool = JSON.parse(readFileSync(poolFile, "utf8"));
  const dishes = Array.isArray(pool.pool) ? pool.pool : [];
  if (dishes.length === 0) { record("menu:every evening has a dinner in the longest period", false, "the pool file holds no dinners"); return; }
  const rot = pool.rotation || {};
  const pick = chooseDinners(dishes, { days: MAX_DAYS, coversDays: 2, lastUsed: {},
    maxPerProtein: Number(rot.maxPerProtein) || 2, minFish: Number(rot.minFishDishes) || 0,
    alternateNewAndKnown: rot.alternateNewAndKnown !== false,
    neverTwoVariantsOfTheSameDinner: rot.neverTwoVariantsOfTheSameDinner !== false });
  const urls = pick.chosen.map((c) => c.url);
  const worst = Math.max(...urls.map((u) => urls.filter((x) => x === u).length));
  let next = 1, tiled = true;
  for (const m of pick.menu) {
    const [from, to] = String(m.days).split("-").map(Number);
    if (from !== next) tiled = false;
    next = to + 1;
  }
  const bent = (pick.relaxed || []).map((r) => r.rule);
  const fish = pick.menu.some((m) => m.protein === "fisk");
  record("menu:every evening has a dinner in the longest period",
    pick.uncoveredDays === 0 && tiled && worst <= 2 && (!Number(rot.minFishDishes) || fish),
    `${dishes.length} pool dinners fill ${pick.coveredDays}/${MAX_DAYS} evenings with ${pick.menu.length} cookings`
    + ` (worst dish cooked ${worst}x${bent.length ? ", bent " + bent.join("+") : ", no rule bent"}${fish ? ", fish in the menu" : ", no fish"})`);
}

/** The scenarios that need nothing but the repository: no home, no mined history, no shop, no
 *  credentials. This is what a scheduled job on another machine can honestly run; the rest of
 *  the battery needs a data/ folder that is deliberately not committed. */
function checkPure() {
  console.log("scenario-check: pure run - only the repository, no home, no shop call");
  const fixture = join(ROOT, "test", "golden", "home", "over-cap-trim");
  if (existsSync(join(fixture, "data", "plans", "plan-latest.json"))) {
    checkArithmetic(fixture, "arithmetic:the committed fixture plan");
  } else {
    record("arithmetic:the committed fixture plan", false, "no plan file under test/golden/home/over-cap-trim/data/plans");
  }
  checkNearMiss();
  console.log("  skipped: the guard probes and every shop scenario - they need the home under data/, which is not committed");
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length} scenarios, ${results.length - failed.length} pass, ${failed.length} fail`);
  writeStamp(failed);
  process.exitCode = failed.length ? 1 : 0;
}

function main() {
  if (process.argv.includes("--pure")) { checkPure(); return; }
  const offline = process.argv.includes("--offline");
  const first = scratchHome();
  created.push(first.dir);
  const snapshot = join(tmpdir(), `scenario-snapshot-${process.pid}`);
  cpSync(first.dir, snapshot, { recursive: true });
  created.push(snapshot);
  console.log(`scenario-check: ${offline ? "offline" : "live"} run against a scratch copy of ${HOME}`);
  console.log(`  plan file used for the guard probes: ${join(first.dir, "data", "plans", "plan-latest.json")}`);
  checkGuards(first.dir);
  checkArithmetic(first.dir, "arithmetic:the plan it started from");
  checkNearMiss();
  checkStamp(first.dir);
  checkLogDinner(first.dir);
  checkMenuFills(first.dir);
  checkMenuDataAge(first.dir);
  if (offline) {
    console.log("  skipped: the shop-facing scenarios (run without --offline to include them)");
  } else {
    checkEightDay(first.dir);
    checkCacheAndMenu(first.dir);
    checkFlagNotes(first.dir);
    created.push(...checkTrimPair(snapshot), ...checkAvoid(snapshot), checkCold(snapshot));
    created.push(...checkRotation(snapshot), checkEveningCover(snapshot));
  }
  checkSecrets(created);
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length} scenarios, ${results.length - failed.length} pass, ${failed.length} fail`);
  // The stamp is written before the scratch is cleaned: the result outlives the homes it ran in.
  writeStamp(failed);
  if (!process.argv.includes("--keep")) for (const dir of created) rmSync(dir, { recursive: true, force: true });
  else console.log(`scratch homes kept under ${tmpdir()}`);
  process.exitCode = failed.length ? 1 : 0;
}

main();
