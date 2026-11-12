// fortify.test.mjs — degradation and refusal: a stale shelf, the breaker on shop errors,
// the call budget, the flags a person typo, and how a failure is printed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { Limiter, reportFailure, pickEndpoint } from "../lib.mjs";
import { search } from "../catalog.mjs";
import { householdMode, unknownFlags, extraIntents } from "../plan.mjs";

const hour = 3600 * 1000;
const shelf = [{ id: "1", name: "Mælk", price: 12, pack: { qty: 1, unit: "l", raw: "1 l" } }];

test("a shelf the shop cannot answer falls back to the one from last time", async () => {
  const dead = { call: async () => { throw new Error("HTTP 503 from tools/call"); } };
  // 30 h old: past the 24 h freshness, inside the 7 day keep window.
  const cache = { "mælk|12": { ts: Date.now() - 30 * hour, products: shelf } };
  const r = await search(dead, "mælk", { take: 12, cache });
  assert.equal(r.products.length, 1, "the old shelf is used");
  assert.equal(r.stale, true, "and it is marked stale");
  assert.ok(r.ageMs > 29 * hour, "with its age");
});

test("a shelf older than a week is a guess, so it is refused", async () => {
  const dead = { call: async () => { throw new Error("HTTP 503 from tools/call"); } };
  const cache = { "mælk|12": { ts: Date.now() - 9 * 24 * hour, products: shelf } };
  await assert.rejects(() => search(dead, "mælk", { take: 12, cache }), /HTTP 503/);
});

test("a shop that answers every call with an error is stopped by the breaker", () => {
  const gate = new Limiter({ maxConsecutiveFailures: 3 });
  gate.noteToolError("search_products", "MCP error -32603: backend exploded");
  gate.noteToolError("search_products", "MCP error -32603: backend exploded");
  assert.equal(gate.broken, null, "two errors are not the threshold");
  gate.noteToolError("search_products", "MCP error -32603: backend exploded");
  assert.match(String(gate.broken), /answered 3 calls in a row with an error/);
});

test("after the cooldown the breaker lets one call try again", async () => {
  const gate = new Limiter({ maxConsecutiveFailures: 2 });
  gate.noteToolError("get_basket", "boom");
  gate.noteToolError("get_basket", "boom");
  assert.ok(gate.broken, "open");
  gate.brokenAt = Date.now() - 60000;   // the cooldown has passed
  assert.equal(await gate.run(async () => "through"), "through", "half-open probe got through");
  assert.equal(gate.broken, null, "and a success closes the breaker");
});

test("a run cannot ask the shop more often than the budget", async () => {
  const gate = new Limiter({ maxCalls: 2, minIntervalMs: 0, concurrency: 1 });
  await gate.run(async () => 1);
  await gate.run(async () => 2);
  await assert.rejects(() => gate.run(async () => 3), /the limit is 2/);
});

test("the household block is only off when the value says off", () => {
  assert.equal(householdMode("off"), "off");
  assert.equal(householdMode("no"), "off");
  assert.equal(householdMode("auto"), "auto");
  assert.equal(householdMode(undefined), "auto");
  assert.equal(householdMode("nonsense"), "auto", "an unknown value warns and stays on");
});

test("a typo in a flag is named instead of ignored", () => {
  assert.deepEqual(unknownFlags(["node", "plan.mjs", "--dayz", "8", "--days", "8"], ["days"]), ["dayz"]);
  assert.deepEqual(unknownFlags(["--days", "8"], ["days"]), []);
});

test("an extra line without a product name is skipped and said so", () => {
  const rules = { preferSale: true, saleTolerancePct: 10 };
  const out = extraIntents(["Mælk:1l", ":1", "Æg", "  "], null, rules);
  assert.deepEqual(out.map((i) => i.query), ["Mælk", "Æg"]);
  assert.equal(out[0].need, "1l");
});

test("a failure is printed as one line, and the stack stays behind --debug", () => {
  const e = new Error("search failed\n    at x (/a/b.mjs:1:1)\n    at y");
  e.stack = "Error: search failed\n    at x (/a/b.mjs:1:1)";
  assert.equal(reportFailure(e, []), "search failed");
  assert.ok(!reportFailure(e, []).includes("\n"), "never more than the first line");
});

test("an explicit NEMLIG_MCP_URL is the only endpoint the client will try", async () => {
  // The offline golden set points the client at a stub on loopback. A fallback to the
  // container name, to the host port or to docker inspect would let a failed probe plan
  // against the real shop - one health check away. So an explicit URL stands alone.
  await assert.rejects(
    () => pickEndpoint({ NEMLIG_MCP_URL: "http://127.0.0.1:1/mcp" }),
    (e) => {
      const msg = String(e.message);
      assert.match(msg, /no MCP endpoint answered/, "the failure names the probe that failed");
      assert.equal(msg.split("|").length, 2, "one base, tried twice, nothing else: " + msg);
      assert.doesNotMatch(msg, /docker|namligmcp:3000|127\.0\.0\.1:3900/, "no container name, no candidate list, no docker lookup");
      return true;
    },
  );
});
