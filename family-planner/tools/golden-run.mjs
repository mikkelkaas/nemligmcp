#!/usr/bin/env node
// golden-run.mjs — runs one golden case offline and prints one measured line.
//
// What it does for one case:
//   1. tools/golden-build.mjs builds the isolated fixture home (fresh every run),
//   2. the stub shop (tools/golden-shop.mjs) starts on 127.0.0.1 and a free port,
//   3. `node plan.mjs <case argv>` runs as a child with NEMLIG_HOME pointed at the fixture
//      home, NEMLIG_ENV pointed at the fixture .env (invented 40-char test secret),
//      NEMLIG_MCP_URL=http://127.0.0.1:<port>/mcp and NEMLIG_CONCURRENCY=1,
//   4. the plan JSON the child wrote is read back and measured.
// The child gets no other endpoint: NEMLIG_MCP_URL is always the loopback stub, so a run
// cannot reach the real shop. A child that outlives CHILD_TIMEOUT_MS is killed and the
// case fails.
//
// Printed line: case, item count, total, unresolved count, hash of the sorted sku list.
//
// Usage:
//   node tools/golden-run.mjs normal-8d [more cases]   run and print one line per case
//   node tools/golden-run.mjs --all                    every case in test/golden/cases
//   node tools/golden-run.mjs --compare                run all, compare with test/golden/expected
//                                                  exit 1 when the weighted score drops
//                                                  REGRESSION_DROP or a case loses skus
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCase, caseNames, setEnvValue } from "./golden-build.mjs";
import { startShop } from "./golden-shop.mjs";
import { readExpected, scoreCase, meanDims } from "./golden-score.mjs";
import { validatePlan } from "../apply.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = join(ROOT, "plan.mjs");
const EXPECTED_DIR = join(ROOT, "test", "golden", "expected");
const CHILD_TIMEOUT_MS = 120000;
const REGRESSION_DROP = 0.05;
export const TOTAL_TOLERANCE_KR = 0.5;
const OUTPUT_CAP = 60000;

/** Short hash of the sorted sku list — the case fingerprint in one line. */
function skuHash(skus) {
  const h = createHash("sha256");
  h.update([...new Set((skus || []).map(String))].sort().join(","));
  return h.digest("hex").slice(0, 12);
}

/** Keep a credential out of any log line, even a child that prints one by accident.
 *  The long-hex rule covers a real MCP_SECRET that strayed into a path or a message:
 *  real secrets are hex, test secrets spell themselves out. */
function redact(text) {
  return String(text || "").replace(/golden-test-secret-[0-9a-z]+/g, "<MCP_SECRET>")
    .replace(/\/[0-9a-f]{32,}/g, "/<MCP_SECRET>")
    .replace(/(NEMLIG_PASS=)\S+/g, "$1<hidden>");
}

/** plan.mjs prints and stores how many calls its own gate made: "64 call(s)". */
function gateCallCount(plan) {
  const gate = String((plan && plan.timing && plan.timing.gate) || "");
  const m = /(\d+) call\(s\)/.exec(gate);
  return m ? Number(m[1]) : null;
}

/** Read the child's tail without letting it grow without bound. */
function tail(text, max = 800) {
  const t = redact(text).trim().split("\n");
  return t.slice(Math.max(0, t.length - 8)).join(" / ").slice(-max);
}

/** Start plan.mjs as a child and wait for it, with one hard timeout. */
function runChild(home, envFile, mcpUrl, argv) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [PLAN, ...argv], {
      cwd: ROOT,
      env: {
        ...process.env,
        NEMLIG_HOME: home,
        NEMLIG_ENV: envFile,
        NEMLIG_MCP_URL: mcpUrl,
        NEMLIG_CONCURRENCY: "1",
        NEMLIG_MAX_MINUTES: "2",
        // No docker, no discovery of the real container IP: lib.mjs asks docker for an
        // address only when its own probe failed. Here it must never get that far.
        DOCKER_HOST: "tcp://127.0.0.1:1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    child.stdout.on("data", (b) => { if (out.length < OUTPUT_CAP) out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { if (err.length < OUTPUT_CAP) err += b.toString("utf8"); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CHILD_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, timedOut: false, out, err: err + "\nspawn failed: " + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: timedOut ? -2 : code, timedOut, out, err });
    });
  });
}

/**
 * Build, serve, plan, measure. Returns
 * { case, items, total, unresolved, skus, hash, plan, problems, child }.
 * Throws when the child fails or the plan file is missing.
 */
export async function runCase(name) {
  const spec = JSON.parse(readFileSync(join(ROOT, "test", "golden", "cases", name + ".json"), "utf8"));
  const built = buildCase(name);
  const shop = await startShop(built.shelfFile);
  // lib.mjs reads the endpoint from the .env file, so the port travels in the file too.
  setEnvValue(built.envFile, "NEMLIG_MCP_URL", shop.base);
  const probe = await fetch(shop.base.replace(/\/mcp$/, "") + "/healthz");
  if (!probe.ok) throw new Error(`${name}: the stub shop did not answer /healthz (HTTP ${probe.status})`);
  let child;
  try {
    child = await runChild(built.home, built.envFile, shop.base, spec.argv);
  } finally {
    await shop.close();
  }
  // Isolation proof, and it must not be quiet. lib.mjs obeys NEMLIG_MCP_URL alone as of
  // commit "The service lookup stops guessing", so today the child has no other endpoint:
  // no candidates, no docker lookup, and DOCKER_HOST points at a closed port. That is the
  // code as it stands, and a guard may not rest on the code staying as it stands. So the
  // proof lives here instead: the child must have probed THIS stub, and every shop call
  // the planner counted must have been served by this stub, under a tool this harness
  // knows. A fallback added later then fails loud: the stub comes up empty, or the two
  // counts differ.
  const served = shop.stats();
  const planFile = join(built.home, "data", "plans", "plan-latest.json");
  if (child.timedOut) throw new Error(`${name}: plan.mjs was killed after ${CHILD_TIMEOUT_MS} ms`);
  if (child.code !== 0) throw new Error(`${name}: plan.mjs exited ${child.code}: ${tail(child.err || child.out)}`);
  if (!existsSync(planFile)) throw new Error(`${name}: no plan written. ${tail(child.out)}`);
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const gateCalls = gateCallCount(plan);
  if (served.healthz < 2) throw new Error(`${name}: the child did not probe the stub /healthz - it did not use the loopback shop`);
  if (served.rejected > 0) throw new Error(`${name}: ${served.rejected} request(s) arrived with a non-loopback Host header`);
  const strayPath = served.paths.find((x) => x !== "/mcp" && x !== "/mcp/<secret>");
  if (strayPath) throw new Error(`${name}: the child posted to an unexpected path ${redact(strayPath)}`);
  const unknownTool = Object.keys(served.byTool).filter((t) => t !== "search_products" && t !== "get_basket");
  if (unknownTool.length > 0) throw new Error(`${name}: the child called a tool this harness does not serve: ${unknownTool.join(", ")}`);
  if (served.byTool.get_basket !== 1) throw new Error(`${name}: expected one get_basket call served by the stub, saw ${served.byTool.get_basket || 0}`);
  if (gateCalls === null) throw new Error(`${name}: the plan carries no call count, so isolation cannot be proved`);
  if (served.byTool.search_products !== gateCalls) {
    throw new Error(`${name}: the planner counted ${gateCalls} search call(s) but the stub served ${served.byTool.search_products || 0} - the child reached something other than the stub`);
  }
  const skus = (plan.items || []).map((i) => String(i.sku)).sort();
  return {
    case: name,
    served: { toolCalls: served.toolCalls, byTool: served.byTool, healthz: served.healthz, gateCalls },
    items: (plan.items || []).length,
    total: Number(plan.planTotal ?? 0),
    unresolved: (plan.unresolved || []).length,
    skus,
    hash: skuHash(skus),
    plan,
    problems: validatePlan(plan),
    child: { code: child.code },
  };
}

/** One measured line per case, in the order given. */
export function lineOf(r) {
  return `${r.case.padEnd(22)} items=${String(r.items).padStart(3)} total=${r.total.toFixed(2).padStart(9)} `
    + `unresolved=${String(r.unresolved).padStart(3)} skus=${r.hash}`;
}

/**
 * The regression rule. Compares a fresh run of every case with test/golden/expected:
 *   - the weighted score drops REGRESSION_DROP or more (against the stored baseline, and
 *     for the set as a whole), or
 *   - a case loses a sku the baseline had, or
 *   - a case moves: the item count, the NOT FOUND count, or the total by more than
 *     TOTAL_TOLERANCE_KR.
 * Returns the list of problems; the caller turns that into exit code 1.
 */
function compare(rows, runs) {
  const problems = [];
  const baseDims = [];
  const nowDims = [];
  for (const expected of rows) {
    const run = runs.get(expected.case);
    const base = expected.score || {};
    const name = expected.case;
    baseDims.push({ accuracy: 1, completeness: base.completeness ?? 1, format: base.format ?? 1, determinism: base.determinism ?? 1 });
    const dims = scoreCase(run, expected, run);
    nowDims.push(dims);
    const lost = (expected.skus || []).map(String).filter((s) => !run.skus.includes(s));
    const grew = run.skus.filter((s) => !(expected.skus || []).map(String).includes(s));
    const itemsDelta = run.items - Number(expected.items || 0);
    const totalDelta = Number(run.total.toFixed(2)) - Number(expected.total || 0);
    const unresolvedDelta = run.unresolved - Number(expected.unresolved || 0);
    if (lost.length > 0) problems.push(`${name}: lost ${lost.length} sku(s) it had: ${lost.slice(0, 6).join(", ")}${lost.length > 6 ? " ..." : ""}`);
    const dropped = (base.weighted ?? 1) - dims.weighted;
    if (dropped >= REGRESSION_DROP) {
      problems.push(`${name}: weighted score moved ${(dropped * 100).toFixed(1)} % down (${(base.weighted ?? 1).toFixed(3)} -> ${dims.weighted.toFixed(3)})`);
    }
    if (Math.abs(itemsDelta) > 0 || Math.abs(totalDelta) > TOTAL_TOLERANCE_KR || Math.abs(unresolvedDelta) > 0) {
      console.log(`MOVED ${name}: items ${expected.items} -> ${run.items} (${itemsDelta > 0 ? "+" : ""}${itemsDelta}), `
        + `total ${Number(expected.total).toFixed(2)} -> ${run.total.toFixed(2)} (${totalDelta > 0 ? "+" : ""}${totalDelta.toFixed(2)} kr), `
        + `unresolved ${expected.unresolved} -> ${run.unresolved} (${unresolvedDelta > 0 ? "+" : ""}${unresolvedDelta})`);
    }
    if (Math.abs(totalDelta) > TOTAL_TOLERANCE_KR) problems.push(`${name}: total moved ${(totalDelta > 0 ? "+" : "")}${totalDelta.toFixed(2)} kr, over the ${TOTAL_TOLERANCE_KR} kr tolerance`);
    if (Math.abs(itemsDelta) > 0) problems.push(`${name}: item count moved by ${itemsDelta}`);
    if (Math.abs(unresolvedDelta) > 0) problems.push(`${name}: the NOT FOUND list moved by ${unresolvedDelta}`);
    if (grew.length > 0) console.log(`note  ${name}: ${grew.length} new sku(s) not in the baseline: ${grew.slice(0, 6).join(", ")}`);
  }
  const before = meanDims(baseDims).weighted;
  const after = meanDims(nowDims).weighted;
  const move = after - before;
  console.log(`weighted score baseline=${before.toFixed(4)} now=${after.toFixed(4)} move=${(move * 100).toFixed(1)} % drop-limit=${(REGRESSION_DROP * 100).toFixed(0)} %`);
  if (-move >= REGRESSION_DROP) problems.push(`set: weighted score dropped ${(move * 100).toFixed(1)} % or more`);
  return problems;
}

/** Command line. */
async function main() {
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const all = flags.includes("--all") || flags.includes("--compare");
  const names = all || wanted.length === 0 ? caseNames() : wanted;
  const rows = [];
  const runs = new Map();
  const failures = [];
  for (const name of names) {
    try {
      const r = await runCase(name);
      runs.set(name, r);
      console.log(lineOf(r));
      if (r.problems.length > 0) failures.push(`${name}: validator says ${r.problems.length} problem(s): ${r.problems[0]}`);
      if (flags.includes("--compare")) {
        const expected = readExpected(name, EXPECTED_DIR);
        if (!expected) failures.push(`${name}: no baseline in ${EXPECTED_DIR} - run node tools/golden-baseline.mjs --write`);
        else rows.push({ ...expected, case: name });
      }
    } catch (e) {
      failures.push(e.message);
      console.log(`${name.padEnd(22)} FAILED ${redact(e.message).slice(0, 200)}`);
    }
  }
  if (flags.includes("--compare")) {
    const problems = compare(rows, runs);
    for (const p of problems) console.log("REGRESSION " + p);
    if (problems.length > 0 || failures.length > 0) process.exitCode = 1;
    return;
  }
  if (failures.length > 0) {
    for (const f of failures) console.error("FAILED: " + f);
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith("golden-run.mjs")) {
  main().catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  });
}
