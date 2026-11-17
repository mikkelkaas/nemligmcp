#!/usr/bin/env node
/**
 * run.mjs - the whole run in one command: plan, then write the basket, in one
 * process with one start-up and the search cache warm from the plan.
 *
 *   node run.mjs --days 7 --breakfast yes --lunchbox yes --snacks no \
 *     --household auto --approve I-APPROVE-THIS-BASKET --slot 2452582
 *
 * Every flag plan.mjs knows belongs here unchanged. run.mjs owns four:
 *   --approve <token>  the same token apply.mjs demands; required without --dry
 *   --slot <id>        a numeric timeslot id from slots.mjs; optional
 *   --dry              plan only, then stop (for testing the command itself)
 *   --keep-going       forwarded to apply.mjs
 *
 * Safety: this never clears or reduces the basket. It adds what the plan lists,
 * top-ups what is there, and orders nothing. A plan that fails stops the run
 * before anything is written. apply.mjs keeps its own lock and its freshness
 * check, so a plan older than its limit is still refused here.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "I-APPROVE-THIS-BASKET";
const OWN_VALUE = new Set(["--approve", "--slot"]);
const OWN_FLAG = new Set(["--dry", "--keep-going"]);

/** Split one argv into the plan's part and run.mjs's own four flags. */
function split(argv) {
  const planArgs = [];
  const own = { approve: null, slot: null, dry: false, keepGoing: false };
  for (let i = 0; i < argv.length && i < 300; i++) {
    const a = argv[i];
    if (OWN_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        console.error(`FAILED: ${a} needs a value.`);
        process.exit(2);
      }
      own[a.slice(2)] = v;
      i++;
      continue;
    }
    if (OWN_FLAG.has(a)) {
      if (a === "--dry") own.dry = true;
      else own.keepGoing = true;
      continue;
    }
    planArgs.push(a);
  }
  return { planArgs, own };
}

/** Keep run.mjs in argv[1] so plan.mjs and apply.mjs do not self-start on import;
 *  their own flag readers take argv from index 2, which is where the args go. */
function setArgv(args) {
  process.argv = [process.execPath, path.join(HERE, "run.mjs"), ...args];
}

async function run() {
  const t0 = Date.now();
  const { planArgs, own } = split(process.argv.slice(2));
  // --help answers before the approval check: it writes nothing and needs no token.
  const wantHelp = planArgs.includes("--help") || planArgs.includes("-h");
  if (own.slot !== null && (!/^\d+$/.test(String(own.slot)) || Number(own.slot) <= 0)) {
    console.error(`FAILED: --slot "${own.slot}" is not a numeric timeslot id.`);
    process.exit(3);
  }
  if (!wantHelp && !own.dry && own.approve !== TOKEN) {
    console.error(`FAILED: the full run needs --approve ${TOKEN} (or --dry to stop at the plan).`);
    console.error("Nothing was written to the basket.");
    process.exit(2);
  }
  setArgv(planArgs);
  const { main: planMain } = await import("./plan.mjs");
  await planMain();
  if (process.exitCode) {
    console.error("FAILED: the plan did not finish - nothing was written to the basket.");
    process.exit(typeof process.exitCode === "number" ? process.exitCode : 1);
  }
  if (wantHelp) {
    console.log("usage: node run.mjs <plan.mjs flags> --approve I-APPROVE-THIS-BASKET [--slot <id>] [--dry] [--keep-going]");
    console.log("Plans, then writes the basket, in one process. --dry stops at the plan. Nothing is ever ordered.");
    return;
  }
  if (own.dry) {
    console.log(`run: dry mode stops here. Whole run ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    return;
  }
  const applyArgs = ["--plan", path.join(HERE, "data/plans/plan-latest.json")];
  const famAt = planArgs.indexOf("--family");
  if (famAt > -1 && planArgs[famAt + 1]) applyArgs.push("--family", planArgs[famAt + 1]);
  if (own.keepGoing) applyArgs.push("--keep-going");
  if (own.slot !== null) applyArgs.push("--slot", own.slot);
  applyArgs.push("--approve", own.approve);
  setArgv(applyArgs);
  const { main: applyMain } = await import("./apply.mjs");
  await applyMain();
  console.log(`run: plan and basket in one command, ${((Date.now() - t0) / 1000).toFixed(1)}s total.`);
}

run().catch((e) => {
  console.error(`FAILED: ${e && e.message ? e.message : String(e)}`);
  process.exitCode = 1;
});
