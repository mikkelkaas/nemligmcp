#!/usr/bin/env node
// golden-score.mjs — the rule-based evaluator for the golden basket plan.
//
// Four dimensions, fixed weights, fixed thresholds. A run passes when every
// dimension reaches its threshold AND the weighted score reaches 0.85.
//   Accuracy      0.40  >= 0.80  share of the expected skus that are present
//   Completeness  0.30  >= 0.70  required plan fields present and non-empty:
//                                items, dinnerMenu, planTotal, timing, options, createdAt
//   Format        0.20  >= 0.90  apply.mjs validatePlan returns no problems, schemaVersion is 1
//   Determinism   0.10  >= 1.00  the same case run twice gives the same skus and the same total
//
// Usage:
//   node tools/golden-score.mjs                 build + run every case twice, print the table
//   node tools/golden-score.mjs normal-8d ...   only the named cases
// Exit code: 0 on PASS, 1 on FAIL, 2 on a usage or fixture error.
// Nothing here talks to the shop: every plan comes through tools/golden-run.mjs, which
// points the child at the loopback stub.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validatePlan } from "../apply.mjs";
import { CASE_DIR, caseNames } from "./golden-build.mjs";

export const WEIGHTS = { accuracy: 0.4, completeness: 0.3, format: 0.2, determinism: 0.1 };
export const THRESHOLDS = { accuracy: 0.8, completeness: 0.7, format: 0.9, determinism: 1 };
export const PASS_WEIGHTED = 0.85;
export const REQUIRED_FIELDS = ["items", "dinnerMenu", "planTotal", "timing", "options", "createdAt"];

/** Read one number out of a run result, null when absent. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Accuracy: how many of the expected skus are still in the plan. */
export function accuracyOf(expectedSkus, skus) {
  const want = [...new Set((expectedSkus || []).map(String))];
  if (want.length === 0) return 0;
  const have = new Set((skus || []).map(String));
  let hit = 0;
  for (const s of want) if (have.has(s)) hit++;
  return Number((hit / want.length).toFixed(4));
}

/** Completeness: the six fields a plan must carry, each present and non-empty. */
export function completenessOf(plan) {
  if (!plan || typeof plan !== "object") return 0;
  let ok = 0;
  for (const f of REQUIRED_FIELDS) {
    const v = plan[f];
    if (Array.isArray(v) && v.length === 0) continue;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "number" && !Number.isFinite(v)) continue;
    if (typeof v === "number" && v <= 0) continue;
    if (f === "items" && !Array.isArray(v)) continue;
    if (f === "dinnerMenu" && !Array.isArray(v)) continue;
    if ((f === "timing" || f === "options") && (typeof v !== "object" || Object.keys(v).length === 0)) continue;
    ok++;
  }
  return Number((ok / REQUIRED_FIELDS.length).toFixed(4));
}

/** Format: the plan's own validator says yes, and the schema version is the one we write. */
export function formatOf(plan, problems = null) {
  const list = problems === null ? validatePlan(plan) : problems;
  const valid = Array.isArray(list) && list.length === 0;
  const versioned = Number(plan && plan.schemaVersion) === 1;
  return Number(((valid ? 1 : 0) + (versioned ? 1 : 0)) / 2);
}

/** Determinism: a second run of the same case answers with the same skus and total. */
export function determinismOf(first, second) {
  if (!first || !second) return 0;
  const a = (first.skus || []).map(String).join(",");
  const b = (second.skus || []).map(String).join(",");
  const ta = num(first.total);
  const tb = num(second.total);
  if (a !== b) return 0;
  if (ta === null || tb === null) return 0;
  return Math.abs(ta - tb) < 0.005 ? 1 : 0;
}

/** One case's four scores. `run` is the measured result, `expected` the stored baseline. */
export function scoreCase(run, expected, repeat) {
  const dims = {
    accuracy: accuracyOf(expected && expected.skus, run.skus),
    completeness: completenessOf(run.plan),
    format: formatOf(run.plan, run.problems),
    determinism: determinismOf(run, repeat),
  };
  return { ...dims, weighted: weighted(dims), pass: passes(dims) };
}

/** The weighted mean of the four dimensions. */
export function weighted(dims) {
  let sum = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) sum += w * (num(dims[key]) || 0);
  return Number(sum.toFixed(4));
}

/** True when every dimension clears its own threshold and the total clears 0.85. */
export function passes(dims) {
  for (const [key, t] of Object.entries(THRESHOLDS)) {
    if (num(dims[key]) === null || Number(dims[key]) < t) return false;
  }
  return weighted(dims) >= PASS_WEIGHTED;
}

/** The printed table: one row per case, then the set row. ASCII only, fixed columns. */
export function tableLines(rows) {
  const head = "case                    items  total     acc    comp   fmt    det    weight  pass";
  const lines = [head, "-".repeat(head.length)];
  for (const r of rows) {
    lines.push(r.case.padEnd(22)
      + String(r.items).padStart(5) + " "
      + String(r.total.toFixed(2)).padStart(8) + " "
      + r.dims.accuracy.toFixed(2).padStart(6) + "  "
      + r.dims.completeness.toFixed(2).padStart(5) + "  "
      + r.dims.format.toFixed(2).padStart(5) + "  "
      + r.dims.determinism.toFixed(2).padStart(5) + "  "
      + r.dims.weighted.toFixed(3).padStart(6) + "  "
      + (r.dims.pass ? "yes" : "NO"));
    if (r.problems && r.problems.length > 0) lines.push("  validator: " + r.problems.slice(0, 3).join(" | "));
  }
  return lines;
}

/** Mean of a list of dimension sets, used for the set line and the comparison. */
export function meanDims(rows) {
  const out = { accuracy: 0, completeness: 0, format: 0, determinism: 0 };
  if (rows.length === 0) return { ...out, weighted: 0, pass: false };
  for (const r of rows) for (const k of Object.keys(out)) out[k] += num(r[k]) || 0;
  for (const k of Object.keys(out)) out[k] = Number((out[k] / rows.length).toFixed(4));
  out.weighted = weighted(out);
  out.pass = passes(out);
  return out;
}

/** Read the stored baseline for one case, null when it is missing. */
export function readExpected(name, dir = join(CASE_DIR, "..", "expected")) {
  const file = join(dir, name + ".json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} is not readable JSON: ${e.message}`);
  }
}

/** Command line: run every case twice, score it, print the table and one score line. */
async function main() {
  const { runCase } = await import("./golden-run.mjs");
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const names = wanted.length > 0 ? wanted : caseNames();
  const rows = [];
  for (const name of names) {
    const expected = readExpected(name);
    if (!expected) throw new Error(`no baseline for ${name}: run node tools/golden-baseline.mjs --write`);
    const first = await runCase(name);
    const second = await runCase(name);
    const dims = scoreCase(first, expected, second);
    rows.push({ case: name, items: first.items, total: first.total, dims, problems: first.problems || [] });
    console.log(`ran  ${name.padEnd(22)} items=${String(first.items).padStart(3)} total=${first.total.toFixed(2).padStart(9)} weighted=${dims.weighted.toFixed(3)} ${dims.pass ? "" : "FAILING"}`);
  }
  console.log("");
  console.log(tableLines(rows).join("\n"));
  const set = meanDims(rows.map((r) => r.dims));
  const verdict = rows.every((r) => r.dims.pass) && set.pass ? "PASS" : "FAIL";
  console.log("");
  console.log(`SCORE weighted=${set.weighted.toFixed(4)} threshold=${PASS_WEIGHTED.toFixed(2)} `
    + `accuracy=${set.accuracy.toFixed(2)} completeness=${set.completeness.toFixed(2)} `
    + `format=${set.format.toFixed(2)} determinism=${set.determinism.toFixed(2)} cases=${rows.length} -> ${verdict}`);
  if (verdict === "FAIL") process.exitCode = 1;
}

if (process.argv[1] && process.argv[1].endsWith("golden-score.mjs")) {
  main().catch((e) => {
    console.error("FAILED:", e.message);
    process.exitCode = 2;
  });
}
