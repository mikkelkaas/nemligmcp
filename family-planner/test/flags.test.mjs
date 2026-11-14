// flags.test.mjs — what a flag word means, and what the planner says about a value it could
// not use as given. Every case here was a silent default once: "--trim off" trimmed anyway,
// "--breakfast off" bought breakfast, and "--days 99999" became 14 evenings without a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boolWord, clampInt, capOf, flagNotes, maxRunMinutes, previousPlanOf } from "../plan.mjs";

const notes = (argv) => flagNotes(["node", "plan.mjs", ...argv]);

test("on and off are flag words, so a documented value is believed", () => {
  assert.equal(boolWord("off"), false, "the word --trim is documented with");
  assert.equal(boolWord("on"), true);
  assert.equal(boolWord("NEJ"), false, "Danish, in any case");
  assert.equal(boolWord("maybe"), null, "a word that means neither is reported, not swallowed");
});

test("the ceiling a run must meet, or no ceiling at all", () => {
  assert.equal(capOf("off", "1500", null), null, "the one case that used to trim anyway");
  assert.equal(capOf("nej", "1500", null), null);
  assert.equal(capOf("on", "1500", null), 1500);
  assert.equal(capOf(null, null, 1500), 1500, "no flag, so the profile decides");
  assert.equal(capOf("maybe", "1500", null), 1500, "an unusable word keeps the default, and a note says so");
});

test("a value that cannot be used as given is named, with the value used instead", () => {
  assert.match(notes(["--days", "99999"])[0], /--days 99999 is outside 1-14 - this run uses 14 evenings instead/);
  assert.match(notes(["--days", "0"])[0], /this run uses 1 evening instead/, "one evening, not one evenings");
  assert.match(notes(["--days", "abc"])[0], /is not a number - this run uses 8 evenings instead/);
  assert.match(notes(["--max-kr", "abc"])[0], /is not an amount in kr above 0 - this run uses the profile's ceiling instead/);
  assert.match(notes(["--breakfast", "maybe"])[0], /is not yes or no - this run uses yes instead/);
  assert.match(notes(["--avoid", ""])[0], /--avoid "" names nothing - this run avoids nothing/);
  assert.match(notes(["--family", ""])[0], /names no profile/);
  assert.equal(notes([]).length, 0, "a run that asks for nothing unusual earns no note");
});

test("a run asked for correctly earns no note, --trim off included", () => {
  const out = notes(["--days", "8", "--breakfast", "yes", "--snacks", "off", "--trim", "off", "--avoid", "Arla"]);
  assert.deepEqual(out, [], "off is believed now, so it needs no warning");
});

test("a flag word in the value position is no value, not a value of --days", () => {
  assert.match(notes(["--avoid", "--days", "8"])[0], /--avoid "" names nothing/);
});

test("clampInt: a whole number inside its range, else the default", () => {
  assert.equal(clampInt("99999", 1, 14, 8), 14);
  assert.equal(clampInt("0", 1, 14, 8), 1);
  assert.equal(clampInt("abc", 1, 14, 8), 8);
  assert.equal(clampInt("7.6", 1, 14, 8), 8, "a whole number of evenings is a rounded one");
});

test("max-minutes stays inside a wall clock a person can wait for", () => {
  assert.equal(maxRunMinutes("0.4"), 1);
  assert.equal(maxRunMinutes("99"), 60);
  assert.equal(maxRunMinutes("abc"), 15);
});

test("the menu names the plan it was ranked against, or says it cannot", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "flags-plans-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(previousPlanOf(dir), null, "no earlier plan is a fact, not a guess");
  writeFileSync(join(dir, "plan-latest.json"), JSON.stringify({
    atIso: "2025-11-13T11:00:00.000Z",
    createdAt: "13.11.2025, 12.00.00 (Europe/Copenhagen)",
    dinnerMenu: [{ name: "A" }, { name: "B" }],
    planTotal: 471.5,
  }));
  const prev = previousPlanOf(dir);
  assert.equal(prev.dinners, 2);
  assert.equal(prev.total, 471.5);
  assert.match(prev.at, /Europe\/Copenhagen/, "the stamp the person reads, not a UTC instant");
  writeFileSync(join(dir, "plan-latest.json"), "{ half a file");
  assert.equal(previousPlanOf(dir).broken, true, "an unreadable plan is reported as unreadable");
});
