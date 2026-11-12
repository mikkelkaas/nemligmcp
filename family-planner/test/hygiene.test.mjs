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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PLANNER = dirname(dirname(fileURLToPath(import.meta.url)));
const GIT_TIMEOUT_MS = 15000;
const READ_LIMIT_BYTES = 400000;

/**
 * Facts that belong to one household. The first list is this repo's own history: a family
 * that forks this adds their own words here, because the guard only knows what it is told.
 * The last two are general: an age in prose and a budget in prose say too much anywhere.
 */
const PRIVATE = [
  [/family-of-3\b/, "the profile name of one family"],
  [/\bMarco\b/, "a person's first name"],
  [/homeserver-iac/, "the owner's private infrastructure repo"],
  [/Grana Padano|Puntalette/, "a product one family buys, mined from their own orders"],
  [/1113,49 kr|1105 kr/, "a total out of one family's real baskets"],
  [/\b66 orders\b/, "how many orders one family has placed"],
  [/\b\d+-year-old\b/, "a child's age"],
  [/softCapKr"?\s*:\s*1500|the 1500 kr soft cap/, "one family's budget"],
];

/** A credential pattern is always a failure, whatever the file. */
const SECRETS = [
  [/NEMLIG_PASS\s*=\s*(?!<|\s*$)[^\s"'`]{4,}/, "a password value in a tracked file"],
  [/MCP_SECRET\s*=\s*(?!<|\s*\$)[A-Za-z0-9+/_-]{20,}/, "an MCP secret value in a tracked file"],
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
