// flags.test.mjs — what a flag word means, and what the planner says about a value it could
// not use as given. Every case here was a silent default once: "--trim off" trimmed anyway,
// "--breakfast off" bought breakfast, and "--days 99999" became 14 evenings without a word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { boolWord, clampInt, capOf, flagNotes, maxRunMinutes, previousPlanOf, nameSpan } from "../plan.mjs";
import { extraFlag } from "../catalog.mjs";

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

test("a printed --extra flag is safe to paste, whatever the shelf called the product", () => {
  // The plan prints this text for a person to copy. It is never handed to a shell by the code,
  // so the only risk is the paste: a quote inside the name must not end the quoted region early,
  // because then the shell joins the rest of the name to the next argument and buys something else.
  assert.equal(extraFlag("Revet Ost Danbo", "400 g"), `--extra "Revet Ost Danbo:400 g"`, "the usual case, unchanged");
  assert.equal(extraFlag("Grønt", null), `--extra "Grønt"`, "a need is optional");
  assert.equal(extraFlag('Grønt "Blandet"', "300 g"), `--extra 'Grønt "Blandet":300 g'`, "a double quote inside moves the flag between single quotes");
  const single = extraFlag('Grønt "Blandet"', "300 g");
  assert.ok(!single.slice(9, -1).includes("'"), "and the value holds no single quote, so the quotes around it cannot be escaped by the name");
  assert.equal(extraFlag(`Blandet "Bland"ed'`, "300 g"), null, "a name holding both quote kinds gets no flag at all");
});

test("a name is fenced where it is read, so a quote cannot move its end", () => {
  assert.equal(nameSpan("Revet Ost Danbo"), "`Revet Ost Danbo`", "the name is a code span in the plan");
  assert.equal(nameSpan("Ost `Danbo`"), "Ost `Danbo`", "a name holding a backtick is left plain, and the sku identifies it");
});

// A word the shelf spells differently (or does not use at all) used to end the line: the
// substitution search tried the profile's alts and the head nouns, but only for a product the
// shop had and could not sell. Now the same shortening runs for both, and it is bounded.
test("a substitute query drops one word, the one that tells how it was cooked", async () => {
  const { relaxedQueries } = await import("../catalog.mjs");
  assert.deepEqual(relaxedQueries("Stegt gulerødder")[0], "gulerødder",
    "the leading preparation word goes first: the shop names the flakes, not the frying");
  assert.ok(relaxedQueries("Grovbrød øko skiver").includes("Grovbrød øko"),
    "a trailing form word goes too, because the bread is the thing: " + relaxedQueries("Grovbrød øko skiver").join(" / "));
  assert.deepEqual(relaxedQueries("Kaffefe"), [], "a one-word query cannot be shortened, so nothing is searched");
  assert.deepEqual(relaxedQueries("a b c d e f"), [], "a six-word ask is not the shop's problem to guess: at most five words");
  const many = relaxedQueries("Ristede løg i skiver øko");
  assert.ok(many.length <= 3, "at most three reads of the shelf per blocked line: " + many.join(" / "));
  for (const q of many) {
    assert.ok(q.split(" ").length < 5, `the shortened query is shorter than the ask: ${q}`);
    assert.ok(!q.includes("undefined"), `no hole left in the query: ${q}`);
  }
});

test("init-family --force keeps the aliases a family taught it", async () => {
  const { learnedAliases } = await import("../init-family.mjs");
  const old = { exclusions: { queryAliases: { risoni: "Orzo", parmesan: "Aged Block" } } };
  const merged = learnedAliases(old, { parmesan: "A parmesan block", vannamei: "Prawn Cooked" });
  assert.deepEqual(merged, { parmesan: "Aged Block", vannamei: "Prawn Cooked", risoni: "Orzo" },
    "the family's word wins over the generated one, a new generated word is added, the learned one survives");
  assert.deepEqual(learnedAliases(null, { risoni: "Orzo" }), { risoni: "Orzo" }, "a first init has nothing to keep");
});
