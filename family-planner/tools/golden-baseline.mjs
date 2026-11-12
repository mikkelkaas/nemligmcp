#!/usr/bin/env node
// golden-baseline.mjs — writes the measured baseline the regression detector compares with.
//
// For every case it runs the case twice through tools/golden-run.mjs (the same path the
// test and the scorer use: fixture home, loopback stub, plan.mjs child) and writes
//   test/golden/expected/<case>.json = { items, total, skus, unresolved, score }
// `score` holds the four dimension scores of this build (see tools/golden-score.mjs).
// The file is committed; the fixture home under test/golden/home/ is not.
//
// Usage:
//   node tools/golden-baseline.mjs --write              every case
//   node tools/golden-baseline.mjs --write normal-8d …  only the named cases
//   node tools/golden-baseline.mjs                      print the stored baseline, write nothing
// A baseline is only written when the plan itself validates: a broken plan must not be
// frozen as the expected answer. Exit code 1 when a case failed or its plan is invalid.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCase, lineOf } from "./golden-run.mjs";
import { caseNames } from "./golden-build.mjs";
import { scoreCase } from "./golden-score.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_DIR = join(ROOT, "test", "golden", "expected");

/** The stored shape for one case. Exactly five keys, so the diff stays readable. */
function expectedOf(r, dims) {
  return {
    items: r.items,
    total: r.total,
    skus: r.skus,
    unresolved: r.unresolved,
    score: {
      accuracy: dims.accuracy,
      completeness: dims.completeness,
      format: dims.format,
      determinism: dims.determinism,
      weighted: dims.weighted,
    },
  };
}

/** Print what is stored, so a plain run of this tool is a question, not a change. */
function printStored() {
  if (readdirSync(EXPECTED_DIR, { recursive: true }).length === 0) {
    console.log("no baseline stored - run: node tools/golden-baseline.mjs --write");
    return;
  }
  for (const f of readdirSync(EXPECTED_DIR).filter((x) => x.endsWith(".json")).sort()) {
    const e = JSON.parse(readFileSync(join(EXPECTED_DIR, f), "utf8"));
    console.log(`${f.replace(/\.json$/, "").padEnd(22)} items=${String(e.items).padStart(3)} total=${String(e.total).padStart(9)} `
      + `skus=${e.skus.length} unresolved=${String(e.unresolved).padStart(3)} weighted=${e.score.weighted}`);
  }
}

/** Build one baseline entry from two measured runs of the same case. */
async function writeOne(name) {
  const first = await runCase(name);
  const second = await runCase(name);
  const self = { skus: first.skus, total: first.total, items: first.items, plan: first.plan };
  const dims = scoreCase(first, self, second);
  if (first.problems.length > 0) {
    console.log(`SKIP  ${name}: validator says ${first.problems.length} problem(s): ${first.problems[0]}`);
    return null;
  }
  mkdirSync(EXPECTED_DIR, { recursive: true });
  const file = join(EXPECTED_DIR, name + ".json");
  writeFileSync(file, JSON.stringify(expectedOf(first, dims), null, 1) + "\n");
  console.log(`${lineOf(first)}  deterministic=${dims.determinism === 1 ? "yes" : "NO"}`);
  console.log(`wrote ${file}`);
  return file;
}

async function main() {
  const write = process.argv.includes("--write");
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!write) {
    printStored();
    return;
  }
  const names = wanted.length > 0 ? wanted : caseNames();
  let failed = 0;
  for (const name of names) {
    try {
      if (!(await writeOne(name))) failed++;
    } catch (e) {
      failed++;
      console.log(`FAILED ${name}: ${e.message}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed} case(s) produced no baseline`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
});
