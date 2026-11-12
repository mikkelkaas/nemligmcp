// refresh.mjs — one command that closes the loop.
//
// The miners read what is true now (your orders, Namlig's prices and recipes), and
// learn.mjs compares what the planner proposed with the basket you actually approved.
// Run this after you have shopped from a plan a couple of times, or put it in cron
// weekly. It changes generated files only, never profiles/family-*.json.
//
//   node refresh.mjs            orders, amounts, the learning loop
//   node refresh.mjs --recipes  also re-mine the recipe coverage (slow, hundreds of pages)
//   node refresh.mjs --dry      learn only, nothing fetched
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEPS = {
  live: [["mine-history.mjs", "your orders afresh"], ["mine-amounts.mjs", "how much you buy of each thing"], ["learn.mjs", "plan vs the basket you approved"]],
  recipes: [["mine-recipes.mjs", "what your recipes ask for"], ["mine-recipes-fetch.mjs", "the recipe pages"], ["mine-recipes-analyze.mjs", "recipe vs your own cart"], ["mine-recipe-pool.mjs", "the rotation pool"], ["learn.mjs", "plan vs the basket you approved"]],
  dry: [["learn.mjs", "plan vs the basket you approved"]],
};

function run(script, label) {
  console.log(`\n=== ${script} — ${label}`);
  const r = spawnSync(process.execPath, [`${HERE}/${script}`], { timeout: 900000, stdio: "inherit" });
  if (r.error) {
    console.error(`FAILED ${script}: ${r.error.message}${r.error.code === "ETIMEDOUT" ? " (15 min timeout)" : ""}`);
    return false;
  }
  if (r.status !== 0) {
    console.error(`FAILED ${script}: exit ${r.status}`);
    return false;
  }
  return true;
}

function main() {
  const mode = process.argv.includes("--dry") ? "dry" : process.argv.includes("--recipes") ? "recipes" : "live";
  const steps = STEPS[mode];
  const failed = [];
  for (const [script, label] of steps) {
    if (!run(script, label)) { failed.push(script); break; }
  }
  console.log("");
  if (failed.length > 0) {
    console.error(`Stopped: ${failed.join(", ")} did not finish. The files it wrote before the failure are valid; re-run when the cause is fixed.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Done (${mode}). Plan again and the numbers, the pool and the learned habits are this month's, not the first run's.`);
  console.log("Nothing in profiles/family-*.json was touched.");
}

main();
