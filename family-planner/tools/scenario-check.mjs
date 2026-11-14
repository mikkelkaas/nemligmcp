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
//   node tools/scenario-check.mjs --keep       leave the scratch home for inspection
//
// Exit 0: every scenario behaved. Exit 1: one regressed, and its own line says which.
// Run it after any change to plan.mjs, apply.mjs, catalog.mjs or trim.mjs.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME, envFile } from "../paths.mjs";
import { validatePlan } from "../apply.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NODE_TIMEOUT_PLAN = 600000;      // a 14-day cold plan measured 10.3 s; 10 min is the guard
const NODE_TIMEOUT_FAST = 90000;       // a refusal costs no shop call
const EIGHT_DAYS = ["--days", "8", "--breakfast", "yes", "--lunchbox", "yes", "--snacks", "no", "--household", "auto"];
const FOURTEEN_DAYS = ["--days", "14", "--breakfast", "yes", "--lunchbox", "yes", "--snacks", "yes", "--household", "auto"];
const CLOSED = "http://127.0.0.1:9";   // nothing listens here; a closed port is the safety device

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
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
    { name: "guard:stale", make: (p) => { p.atIso = new Date(Date.now() - 40 * 3600000).toISOString(); },
      expect: (r) => r.code === 5 && /h old/.test(r.out), want: "exit 5, named as hours old" },
    { name: "guard:no readable stamp", make: (p) => { p.atIso = null; p.createdAt = "sidst"; },
      expect: (r) => r.code === 5 && /no readable time stamp/.test(r.out), want: "exit 5, an unknown age is refused too" },
    { name: "guard:unresolved line", make: (p) => { p.unresolved = [{ query: "Ost 38+", source: "dinners:test" }]; },
      expect: (r) => r.code === 4 && /Ost 38\+/.test(r.out), want: "exit 4, naming the line" },
    { name: "guard:no products", make: (p) => { p.items = []; },
      expect: (r) => r.code === 6 && /does not hold up/.test(r.out), want: "exit 6, the file is rejected" },
    { name: "guard:total does not add up", make: (p) => { p.planTotal = sumOf(p) + 50; },
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
  const sum = sumOf(plan), total = Number(plan.planTotal);
  record(label, problems.length === 0 && Math.abs(sum - total) < 0.51,
    `${plan.items.length} lines, they add up to ${sum.toFixed(2)}, planTotal says ${total.toFixed(2)}, validator: ${problems.length ? problems[0] : "clean"}`);
}

function checkEightDay(dir) {
  const r = checkPlanRun(dir, EIGHT_DAYS, "eight day");
  const lines = (r.plan && r.plan.items.length) || 0;
  const unresolved = (r.plan && r.plan.unresolved.length) || 0;
  record("plan:8 days", r.code === 0 && /^PLAN /m.test(r.out) && unresolved === 0,
    `exit ${r.code}, ${lines} purchases, ${unresolved} not found`);
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

const created = [];

function main() {
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
  if (offline) {
    console.log("  skipped: the shop-facing scenarios (run without --offline to include them)");
  } else {
    checkEightDay(first.dir);
    checkCacheAndMenu(first.dir);
    checkFlagNotes(first.dir);
    created.push(...checkTrimPair(snapshot), ...checkAvoid(snapshot), checkCold(snapshot));
  }
  checkSecrets(created);
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length} scenarios, ${results.length - failed.length} pass, ${failed.length} fail`);
  if (!process.argv.includes("--keep")) for (const dir of created) rmSync(dir, { recursive: true, force: true });
  else console.log(`scratch homes kept under ${tmpdir()}`);
  process.exitCode = failed.length ? 1 : 0;
}

main();
