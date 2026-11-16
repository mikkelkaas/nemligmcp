// pool.test.mjs — the traffic gate, the worker pool, the cache prune and the plan check.
// No network: the gate is tested against functions that only count and sleep.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Limiter, mapPool } from "../lib.mjs";
import { pruneCache } from "../catalog.mjs";
import { validatePlan } from "../apply.mjs";
import { mergeItems } from "../plan.mjs";

const now = () => Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("mapPool keeps the input order", async () => {
  const items = [5, 1, 4, 2, 3];
  const out = await mapPool(items, async (n, i) => { await wait(n * 4); return n * 10 + i; }, { concurrency: 3 });
  assert.deepEqual(out, [50, 11, 42, 23, 34]);
});

test("mapPool never runs more workers than asked", async () => {
  let live = 0;
  let peak = 0;
  await mapPool(new Array(12).fill(0), async () => {
    live++;
    peak = Math.max(peak, live);
    await wait(6);
    live--;
    return 1;
  }, { concurrency: 3 });
  assert.ok(peak <= 3, `peak ${peak} should be at most 3`);
});

test("mapPool on an empty list returns an empty list", async () => {
  assert.deepEqual(await mapPool([], async () => 1, { concurrency: 4 }), []);
});

test("the gate keeps at most its number of calls in flight", async () => {
  const gate = new Limiter({ concurrency: 2, minIntervalMs: 0, jitterMs: 0 });
  let live = 0;
  let peak = 0;
  await Promise.all(new Array(9).fill(0).map(() => gate.run(async () => {
    live++;
    peak = Math.max(peak, live);
    await wait(8);
    live--;
    return "ok";
  })));
  assert.ok(peak <= 2, `peak ${peak} should be at most 2`);
  assert.equal(gate.stats.calls, 9);
});

test("the gate keeps a set distance between two starts", async () => {
  const gate = new Limiter({ concurrency: 4, minIntervalMs: 50, jitterMs: 0 });
  const starts = [];
  await Promise.all(new Array(4).fill(0).map(() => gate.run(async () => { starts.push(now()); return 1; })));
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  assert.ok(gaps.every((g) => g >= 45), `starts were ${JSON.stringify(starts)}, gaps ${JSON.stringify(gaps)}`);
});

test("a call held back by the spacing still runs, with nobody in flight", async () => {
  // One lane, a second call right after the first: only the spacing holds it, and a
  // release will never come to wake it. This used to end the process with code 0 and
  // half a plan written.
  const gate = new Limiter({ concurrency: 1, minIntervalMs: 300, jitterMs: 0 });
  assert.equal(await gate.run(async () => 1), 1);
  const t0 = now();
  const timer = setTimeout(() => assert.fail("the second call was never started"), 4000);
  const r = await gate.run(async () => 2);
  clearTimeout(timer);
  assert.equal(r, 2);
  assert.ok(now() - t0 >= 250, "the spacing was honoured");
});

test("a transient failure is retried and then succeeds", async () => {
  const gate = new Limiter({ concurrency: 1, minIntervalMs: 0, jitterMs: 0, attempts: 3, backoffStartMs: 20, backoffMaxMs: 40 });
  let calls = 0;
  const r = await gate.run(async () => {
    calls++;
    if (calls < 3) throw new Error("HTTP 503 from tools/call");
    return "recovered";
  });
  assert.equal(r, "recovered");
  assert.equal(calls, 3);
  assert.equal(gate.stats.retries, 2);
  assert.equal(gate.stats.backoffs, 2);
});

test("a wrong secret is not retried", async () => {
  const gate = new Limiter({ concurrency: 1, minIntervalMs: 0, jitterMs: 0, attempts: 3, backoffStartMs: 20 });
  let calls = 0;
  await assert.rejects(
    () => gate.run(async () => { calls++; throw new Error("404 from MCP endpoint — check MCP_SECRET"); }),
    /MCP_SECRET/,
  );
  assert.equal(calls, 1);
});

test("the gate stops the run when nothing answers", async () => {
  const gate = new Limiter({ concurrency: 1, minIntervalMs: 0, jitterMs: 0, attempts: 2, backoffStartMs: 5, maxConsecutiveFailures: 3 });
  const boom = () => gate.run(async () => { throw new Error("HTTP 500 from tools/call"); });
  await assert.rejects(boom, /HTTP 500/, "the first run reports the shop error");
  await assert.rejects(boom, /failed 3 calls in a row/, "the next run is stopped by the breaker");
  await assert.rejects(boom, /product-cache/, "and the message names what to do next");
  assert.equal(gate.stats.backoffs >= 3, true, "the breaker counted its backoffs");
});

test("a run that passes its deadline ends with a named reason", async () => {
  const gate = new Limiter({ concurrency: 1, minIntervalMs: 0, deadlineAtMs: now() - 1000 });
  await assert.rejects(() => gate.run(async () => "late"), /run deadline of/);
});

test("the cache keeps what is recent and drops what nobody asked for again", () => {
  const fresh = { "mælk|12": { ts: now(), products: [1] } };
  const week = Object.assign({ "æg|12": { ts: now() - 8 * 24 * 3600 * 1000, products: [2] }, broken: null }, fresh);
  const kept = pruneCache(week);
  assert.ok(kept["mælk|12"], "the recent entry should survive");
  assert.equal(kept["æg|12"], undefined, "an entry older than a week should go");
  assert.equal(kept.broken, undefined, "an entry without a stamp should go");
});

test("a recipe line the shop has nothing for is a gap, not a blocker", () => {
  const gone = { ok: false, query: "Naanbrød (tilføj selv til kurv)", source: "dinner:/opskrifter/x", why: "search returned nothing", candidates: 0 };
  const breakfast = { ok: false, query: "Müsli", source: "breakfast", why: "search returned nothing", candidates: 0 };
  const noStock = { ok: false, query: "Peberfrugt", source: "dinner:/opskrifter/x", why: "all 4 name matches were unavailable", candidates: 4 };
  const merged = mergeItems([gone, breakfast, noStock], {});
  assert.equal(merged.recipeGaps.length, 1, "only the dinner line with an empty shelf is a gap");
  assert.equal(merged.recipeGaps[0].query, "Naanbrød (tilføj selv til kurv)");
  assert.deepEqual(merged.unresolved.map((u) => u.query).sort(), ["Müsli", "Peberfrugt"], "a breakfast gap and a line that exists but cannot be bought still block the basket");
});

/** A plan that passes, so the failures below are about the change and not the fixture. */
function goodPlan() {
  return {
    kind: "nemlig-plan", schemaVersion: 1, planTotal: 64.95,
    items: [
      { sku: "5053034", name: "Æg", brand: "", packs: 1, price: 54.95, total: 54.95 },
      { sku: "1234567", name: "Mælk", brand: "", packs: 2, price: 5.0, total: 10.0 },
    ],
  };
}

test("a plan that holds up is accepted", () => {
  assert.deepEqual(validatePlan(goodPlan()), []);
});

test("planTotal is checked against what the run adds, not the whole plan", () => {
  // The basket already held the maelk, so keep-and-top-up left it out of the adds. The plan
  // is right and the old check refused it: planTotal is the adds sum, items is every product.
  const kept = goodPlan();
  kept.planTotal = 54.95;
  kept.adds = [{ sku: "5053034", name: "Æg", packs: 1, price: 54.95, total: 54.95 }];
  assert.deepEqual(validatePlan(kept), [], "a colliding basket line is not a broken plan");
  const emptyAdd = goodPlan();
  emptyAdd.planTotal = 0;
  emptyAdd.adds = [];                                  // the basket holds all of it already
  assert.deepEqual(validatePlan(emptyAdd), []);
  const off = validatePlan(Object.assign(kept, { adds: [] }));
  assert.match(off.join("; "), /planTotal 54\.95 does not match the adds, which add up to 0/, "a real mismatch is still caught");
  const noAdds = goodPlan();
  noAdds.planTotal = 12.5;                             // an older plan file without an adds list
  assert.match(validatePlan(noAdds).join("; "), /does not match the items/, "without adds the items are the basis");
});

test("the plan check refuses what cannot go to the shop", () => {
  const cases = [
    [{ kind: "nemlig-draft" }, /kind/],
    [{ schemaVersion: 2 }, /schemaVersion/],
    [{ items: "not a list" }, /items/],
  ];
  for (const [patch, re] of cases) {
    const plan = Object.assign(goodPlan(), patch);
    assert.match(validatePlan(plan).join("; "), re, JSON.stringify(patch));
  }
  const broken = goodPlan();
  broken.items[1].sku = "5053034";                    // the same product twice
  assert.match(validatePlan(broken).join("; "), /already planned as/);
  const noSku = goodPlan();
  noSku.items[0].sku = "abc";
  assert.match(validatePlan(noSku).join("; "), /not a product number/);
  const halfPack = goodPlan();
  halfPack.items[0].packs = 1.5;
  assert.match(validatePlan(halfPack).join("; "), /whole number/);
  const nanPrice = goodPlan();
  nanPrice.items[0].price = "billig";
  assert.match(validatePlan(nanPrice).join("; "), /plausible kr/);
  const wrongTotal = goodPlan();
  wrongTotal.items[0].total = 99.0;
  assert.match(validatePlan(wrongTotal).join("; "), /is not 1 x 54.95/);
  const lyingSum = goodPlan();
  lyingSum.planTotal = 900;
  assert.match(validatePlan(lyingSum).join("; "), /does not match the items/);
  const empty = goodPlan();
  empty.items = [];
  assert.match(validatePlan(empty).join("; "), /no products/);
});

// --- plan.mjs: the budget a run is measured against belongs to the family ---------
import { softCapOf } from "../plan.mjs";

test("the soft cap comes from the flag, then the profile, then nowhere", () => {
  assert.equal(softCapOf("50", 1200), 50, "--soft-cap wins when it is given");
  assert.equal(softCapOf(null, 1200), 1200, "no flag, so the profile decides");
  assert.equal(softCapOf("", 1200), 1200, "an empty flag is not a flag");
  assert.equal(softCapOf("abc", 900), 900, "a flag that is not a number falls back to the profile");
  assert.equal(softCapOf("0", null), null, "a zero cap is not a cap");
  assert.equal(softCapOf(null, null), null, "a family that set no budget gets no cap and no warning");
});

// --- plan.mjs: what a pantry line's quantity counts ------------------------------
import { blockIntents } from "../plan.mjs";

const noHistory = new Map();
const saleOff = { preferSale: false, saleTolerancePct: 0 };
const oneLine = (extra) => [{ id: "x", query: "Æble", qtyPerCycle: 1, unit: "stk", ...extra }];
// 8 days planned, a 9-day cycle: the numbers below are chosen so each basis gives a
// different, hand-checkable count and no rounding can hide a wrong factor.
const lineFor = (extra, people) => blockIntents(oneLine(extra), "lunchbox", 8, 9, noHistory, noHistory, saleOff, people)[0];

test("a pantry line states the basis its quantity is written on", () => {
  assert.equal(lineFor({}, 3).need, "1 stk", "a mined line is what the household buys per cycle");
  assert.match(lineFor({}, 3).note, /1 stk per cycle x 8 d \/ 9 d cycle/, "the old wording is unchanged");
  assert.equal(lineFor({ per: "person-day" }, 3).need, "24 stk", "1 x 3 people x 8 days");
  assert.equal(lineFor({ per: "person-day" }, 3).note, "1 stk per person-day x 3 people x 8 d");
  assert.equal(lineFor({ per: "person-cycle" }, 3).need, "3 stk", "1 x 3 x 8 / 9 rounds up to 3");
  assert.equal(lineFor({ per: "person-cycle" }, 1).note, "1 stk per person-cycle x 1 person x 8 d / 9 d cycle");
  assert.equal(lineFor({ per: "person-day" }, 0).need, undefined, "nobody to count for buys nothing");
  assert.match(lineFor({ per: "person-day" }, 0).skipped, /household.blockPeople.lunchbox is 0/, "and says why");
  assert.equal(lineFor({}, 0).need, "1 stk", "a mined line keeps its floor even with no head-count");
});

import { parsePack } from "../units.mjs";

test("a count ask is not bargained away by a summed measure", () => {
  // Breakfast wants 2 packs of the milk; the æggekage recipe needs 1 dl of the same sku.
  const milk = { sku: "5019862", name: "Letmælk 0,4%", brand: "Danmælk", price: 10.5, unitPrice: 10.5,
    unitLabel: "kr/l", pack: parsePack("1000 ml"), url: "", onSale: true };
  const rows = [
    { ok: true, source: "dinner:/opskrifter/aeggekage", mode: "cheapest", need: { qty: 0.1, unit: "l" }, packs: 1, pick: milk, why: "cheapest", rationale: "0.1 l" },
    { ok: true, source: "breakfast:minimaelk", mode: "history", need: { qty: 2, unit: "stk" }, packs: 2, pick: milk, why: "your block", rationale: "2 stk" },
  ];
  const merged = mergeItems(rows, {}).items;
  assert.equal(merged.length, 1, "one shelf item, one basket line");
  assert.equal(merged[0].packs, 2, "the litre sum covers 0,1 l in one pack, and must not cut the 2 packs the block asked for");
  assert.equal(merged[0].total, 21, "2 x 10,50 kr");
  assert.ok(String(merged[0].why).includes("count stands"), "the plan says why the count won");
});

test("a limiter wants a clock time for its deadline, not a duration", () => {
  assert.throws(() => new Limiter({ deadlineAtMs: 10 * 60 * 1000 }), /absolute clock time/,
    "one caller passed 10 minutes here: the deadline landed in 1970 and every basket write died before its first shop call");
  const gate = new Limiter({ deadlineAtMs: Date.now() + 10 * 60 * 1000 });
  assert.equal(gate.deadlineMinutes, 10, "the message quotes the minutes the run was given, never the raw clock");
});
