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
