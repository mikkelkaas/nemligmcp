// test/golden.test.mjs — the golden set: one node:test case per fixture, no network.
//
// What it proves, per case: plan.mjs built the same basket it built when the baseline was
// written. The sku set must be identical, the item count identical, the total within
// 0,50 kr. On top of that the plan file must pass the planner's own validator
// (apply.mjs validatePlan) with zero problems, because that is the file apply.mjs writes.
//
// How it runs offline: tools/golden-run.mjs builds a fixture home under test/golden/home/,
// starts the stub shop on 127.0.0.1 and runs plan.mjs as a child pointed at it. Nothing
// here reaches the real shop, and the fixture tree is gitignored.
//
// Usage:
//   node --test test/golden.test.mjs         all ten cases (about 2 minutes)
//   node --test --test-name-pattern=normal-8d test/golden.test.mjs
// Before the first run, write the baseline: node tools/golden-baseline.mjs --write
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, lineOf } from "../tools/golden-run.mjs";
import { caseNames } from "../tools/golden-build.mjs";
import { validatePlan } from "../apply.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_DIR = join(ROOT, "test", "golden", "expected");
const TOTAL_TOLERANCE_KR = 0.5;

/** Read the committed baseline for one case, or say what to run. */
function expectedOf(name) {
  const file = join(EXPECTED_DIR, name + ".json");
  assert.ok(existsSync(file), `no baseline for ${name}. Run: node tools/golden-baseline.mjs --write`);
  return JSON.parse(readFileSync(file, "utf8"));
}

const names = caseNames();
assert.ok(names.length > 0, "no cases under test/golden/cases");

for (const name of names) {
  test(`golden ${name}`, async () => {
    const expected = expectedOf(name);
    const run = await runCase(name);
    assert.deepEqual(run.skus, expected.skus.map(String), `${name}: sku set moved\n${lineOf(run)}`);
    assert.equal(run.items, expected.items, `${name}: item count moved (${run.items} vs ${expected.items})`);
    assert.ok(Math.abs(run.total - expected.total) <= TOTAL_TOLERANCE_KR,
      `${name}: total moved ${run.total.toFixed(2)} vs ${expected.total.toFixed(2)} (over ${TOTAL_TOLERANCE_KR} kr)`);
    const problems = validatePlan(run.plan);
    assert.deepEqual(problems, [], `${name}: the plan file does not validate: ${problems.slice(0, 4).join(" | ")}`);
    assert.equal(run.unresolved, expected.unresolved, `${name}: the NOT FOUND list moved (${run.unresolved} vs ${expected.unresolved})`);
  });
}
