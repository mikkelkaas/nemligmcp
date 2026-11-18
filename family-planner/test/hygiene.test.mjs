// hygiene.test.mjs — the promise MODEL.md makes, checked against the files git would ship.
//
// The planner is built from one family's order history, and that history is meant to stay
// at home: profiles/*.json and data/ are ignored. This test is the guard that the same
// history does not walk out through a comment, a README example or a User-Agent string.
// It reads `git ls-files`, so it checks what is tracked, not what happens to sit in a tree.
//
// It is not a general secret scanner. It looks for facts about one household and for the
// one thing that must never be committed: a credential.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLANNER = dirname(dirname(fileURLToPath(import.meta.url)));
const GIT_TIMEOUT_MS = 15000;
const READ_LIMIT_BYTES = 400000;
const READ_LIMIT_LINES = 20000;   // the order history only grows; a guard must not read forever

/**
 * Facts that belong to one household. The first list is this repo's own history: a family
 * that forks this adds their own words here, because the guard only knows what it is told.
 * The last two are general: an age in prose and a budget in prose say too much anywhere.
 */
/** Every pattern is case-insensitive: a mention in lower case is still a mention. */
const PRIVATE = [
  [/family-of-3\b/i, "the profile name of one family"],
  [/\bMarco\b/i, "a person's first name"],
  [/homeserver-iac/i, "the owner's private infrastructure repo"],
  [/Grana Padano|Puntalette/i, "a product one family buys, mined from their own orders"],
  [/Kokosflager|Solsikkerugbrød|Flødehavarti|Minimælk/i, "a product one family buys, named in their own history or learned on their shelf"],
  [/1113,49 kr|1105 kr/i, "a total out of one family's real baskets"],
  [/\b66 orders\b/i, "how many orders one family has placed"],
  [/\b\d+-year-old\b/i, "a child's age"],
  [/softCapKr"?\s*:\s*1500|the 1500 kr soft cap/i, "one family's budget"],
];

/** A credential pattern is always a failure, whatever the file. */
// The value class excludes every character that shows up in source text - parentheses,
// backslashes, quotes, commas - because tools/golden-run.mjs writes .env files and holds
// patterns like /NEMLIG_PASS=\S+/g in its own text. A guard that fires on the shape of a
// regular expression teaches people to switch it off.
const VALUE = "[A-Za-z0-9/+_.=-]{16,}";
const SECRETS = [
  [new RegExp("NEMLIG_PASS\\s*=\\s*" + VALUE, "g"), "a password value in a tracked file"],
  [new RegExp("MCP_SECRET\\s*=\\s*" + VALUE, "g"), "an MCP secret value in a tracked file"],
];

function trackedFiles() {
  const r = spawnSync("git", ["-C", PLANNER, "ls-files", "-z", "--", "."], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) return null;                      // not a git checkout: nothing to guard
  return String(r.stdout || "").split("\0").filter(Boolean).filter((f) => /\.(mjs|js|json|md|ts|ya?ml|sh|example)$|\.env\.example$/.test(f));
}

function readText(file) {
  try {
    const raw = readFileSync(join(PLANNER, file), "utf8");
    return raw.length > READ_LIMIT_BYTES ? raw.slice(0, READ_LIMIT_BYTES) : raw;
  } catch {
    return "";                                          // binary or unreadable: not prose
  }
}

function hits(text, patterns) {
  const found = [];
  for (const [re, what] of patterns) {
    const m = text.match(re);
    if (m) found.push(what + ": " + JSON.stringify(String(m[0]).slice(0, 60)));
  }
  return found;
}

test("no tracked file carries a fact about one family", () => {
  const files = trackedFiles();
  if (files === null) return;                            // skipped, and the reason is in the next line
  const bad = [];
  for (const file of files) {
    if (file === "test/hygiene.test.mjs") continue;   // this guard names the facts it forbids; it would match itself
    for (const hit of hits(readText(file), PRIVATE)) bad.push(file + " - " + hit);
  }
  assert.deepEqual(bad, [], "these tracked files name one household:\n" + bad.join("\n"));
});

test("no tracked file carries a credential value", () => {
  const files = trackedFiles();
  if (files === null) return;
  const bad = [];
  for (const file of files) {
    for (const hit of hits(readText(file), SECRETS)) bad.push(file + " - " + hit);
  }
  assert.deepEqual(bad, [], "a credential must live only in the .env the server and the planner read");
});

test("the suite does not read anybody's own profile", () => {
  const files = trackedFiles();
  if (files === null) return;
  const tests = files.filter((f) => f.startsWith("test/") && f.endsWith(".mjs"));
  const bad = [];
  for (const file of tests) {
    const text = readText(file);
    // A test that loads the real profile cannot run on a clone: the profile is ignored.
    // The fixture under test/fixtures/profiles/ is there so it can.
    const direct = text.match(/loadFamily\(\s*\)/) || text.match(/PROFILES[^)]*family-(?!example|demo)/i);
    if (direct) bad.push(file + " - reads a family profile instead of the fixture: " + direct[0]);
  }
  assert.deepEqual(bad, [], "a clean clone has no private profile, so every case must use test/fixtures/profiles/");
});

/**
 * The order totals on THIS machine, as "1113,49", 1000 kr and up. Null when there is no
 * history here, which is the case on a clean clone: then the case skips and says so.
 * A total is one household's spending, not a shop fact, so it belongs at home.
 */
function orderTotals(path = join(PLANNER, "data/order-lines-raw.jsonl")) {
  if (!existsSync(path)) return null;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;                                          // unreadable: not this guard's business
  }
  const out = new Set();
  for (const line of raw.split("\n").slice(0, READ_LIMIT_LINES)) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;                                           // a half-written line is not a total
    }
    const value = Number(row && row.total);
    if (Number.isFinite(value) && value >= 1000) out.add(value.toFixed(2).replace(".", ","));
  }
  return out;
}

/** Money written in a file that matches one of those totals, in either 1.113,49 or 1113,49 form. */
function quotedTotals(text, totals) {
  const out = [];
  for (const m of String(text).matchAll(/\d[\d .]{0,6},\d{2}\s*kr/g)) {
    const bare = m[0].replace(/[ .]/g, "").replace(/kr$/, "").trim();
    if (totals.has(bare)) out.push("an order total of " + bare + " kr");
  }
  return out;
}

test("no tracked file quotes an order total out of this machine's history", () => {
  const files = trackedFiles();
  if (files === null) return;
  const totals = orderTotals();
  if (totals === null) {
    console.log("skipped: this machine has no data/order-lines-raw.jsonl, so there is no history to protect");
    return;
  }
  const bad = [];
  for (const file of files) {
    if (file === "test/hygiene.test.mjs") continue;
    for (const hit of quotedTotals(readText(file), totals)) bad.push(file + " - " + hit);
  }
  assert.deepEqual(bad, [], "an order total is one household's spending and must not be shipped:\n" + bad.join("\n"));
});
