// guards.test.mjs — the refusals that stand between a plan file and a real basket.
// Pure calls on plan objects: no shop, no basket, no endpoint, nobody's credentials.
import { test } from "node:test";
import assert from "node:assert/strict";

import { refusalReason, planAgeHours } from "../apply.mjs";

const hour = 3600000;
const plan = (over = {}) => ({
  kind: "nemlig-plan", schemaVersion: 1, atIso: new Date().toISOString(),
  items: [], unresolved: [], ...over,
});
const plain = ["node", "apply.mjs"];
const oldPlan = () => plan({ atIso: new Date(Date.now() - 40 * hour).toISOString() });

test("a plan made now with every line answered is applicable", () => {
  assert.equal(refusalReason(plan(), 12, plain), null);
});

test("a line nobody found stops the write, and the refusal names it", () => {
  const r = refusalReason(plan({ unresolved: [{ query: "Ost 38+", source: "dinners:lasagne" }] }), 12, plain);
  assert.equal(r.code, 4);
  assert.match(r.text, /REFUSED: 1 intent/);
  assert.match(r.text, /Ost 38\+/, "a person has to be able to fix it from the message alone");
});

test("--ignore-unresolved is the only way past that refusal", () => {
  const p = plan({ unresolved: [{ query: "Ost 38+", source: "dinners:lasagne" }] });
  assert.equal(refusalReason(p, 12, [...plain, "--ignore-unresolved"]), null);
});

test("a plan older than the price day is refused, and says how old it is", () => {
  const r = refusalReason(oldPlan(), 12, plain);
  assert.equal(r.code, 5);
  assert.match(r.text, /4[01]\.\d h old/);
  assert.match(r.text, /--allow-stale/, "and the way round it, out loud");
});

test("--allow-stale is the only way past the age refusal", () => {
  assert.equal(refusalReason(oldPlan(), 12, [...plain, "--allow-stale"]), null);
});

test("a profile may set a tighter age than the default 12 hours", () => {
  const aged = plan({ atIso: new Date(Date.now() - 3 * hour).toISOString() });
  assert.equal(refusalReason(aged, 2, plain).code, 5, "3 h old against a 2 h limit");
  assert.equal(refusalReason(aged, 12, plain), null, "and the same plan is fine against the default");
});

test("one hour old is read as one hour, in both stamp formats", () => {
  const iso = plan({ atIso: new Date(Date.now() - hour).toISOString() });
  assert.equal(planAgeHours(iso).toFixed(0), "1");
  const daText = new Date(Date.now() - 40 * hour).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false })
    + " (Europe/Copenhagen)";
  const age = planAgeHours({ createdAt: daText });
  assert.ok(age !== null && age > 39 && age < 41, `age read from "${daText}" came out as ${age}`);
});

test("a plan that carries only the da-DK stamp is refused as too old", () => {
  // Every written plan carries atIso, so the da-DK branch had never run: it reached for a
  // seventh capture group out of six, which made the age gate quiet instead of strict.
  const text = new Date(Date.now() - 40 * hour).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false })
    + " (Europe/Copenhagen)";
  const p = { kind: "nemlig-plan", schemaVersion: 1, items: [], unresolved: [], createdAt: text };
  assert.equal(refusalReason(p, 12, plain).code, 5, `stamp "${text}" was read as no age at all`);
  assert.equal(refusalReason(p, 12, [...plain, "--allow-stale"]), null);
});

test("a stamp that cannot be read is refused, never taken for fresh", () => {
  assert.equal(planAgeHours({}), null);
  assert.equal(planAgeHours({ createdAt: "sidst" }), null);
  const r = refusalReason(plan({ atIso: null, createdAt: "sidst" }), 12, plain);
  assert.equal(r.code, 5, "a plan file is hand-editable, so a lost stamp is not proof of a fresh plan");
  assert.match(r.text, /no readable time stamp/);
  assert.equal(refusalReason(plan({ atIso: null, createdAt: "sidst" }), 12, [...plain, "--allow-stale"]), null,
    "--allow-stale is the way a person accepts an age they cannot be told");
});
