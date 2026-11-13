// trim.test.mjs — what a budget ceiling is allowed to do to a basket, and what it is not.
// Pure arithmetic on already-resolved lines: no shop, no cache, no clock.
import { test } from "node:test";
import assert from "node:assert/strict";

import { trimItems, bestSwap, packsForAlt, delivered, rankOf, rankLabel } from "../trim.mjs";

const item = (over = {}) => ({
  sku: "100", name: "Produkt", brand: "Brand", price: 10, packs: 1, total: 10,
  sources: ["snacks:x"], needMeasure: null, needAmount: 0, alternatives: [], ...over,
});
const alt = (over = {}) => ({ sku: "200", name: "Billigere", brand: "Budget", price: 5, unitPrice: 20, pack: { qty: 250, unit: "g" }, ...over });

test("a plan inside its ceiling, or with no ceiling, is returned untouched", () => {
  const items = [item({ total: 60 }), item({ sku: "101", total: 40 })];
  for (const cap of [null, 0, "abc", 100, 500]) {
    const r = trimItems(items, { capKr: cap });
    assert.equal(r.actions.length, 0, `cap ${cap}`);
    assert.equal(r.items.length, 2, `cap ${cap}`);
    assert.equal(r.shortfall, 0);
    assert.equal(r.after, 100);
  }
});

test("a cheaper rival of the same product is bought first, and the line keeps its need", () => {
  const items = [item({
    name: "Rugbrød", sources: ["kidLunchbox:rugbraod"], price: 24, packs: 4, total: 96,
    needMeasure: "g", needAmount: 2000, alternatives: [alt({ price: 21, pack: { qty: 500, unit: "g" } })],
  })];
  const r = trimItems(items, { capKr: 90, minSwapKr: 5 });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].action, "swap");
  assert.equal(r.actions[0].to.sku, "200");
  assert.equal(r.items[0].sku, "200");
  assert.equal(r.items[0].packs, 4, "2000 g of a 500 g pack is 4 packs");
  assert.equal(r.items[0].total, 84);
  assert.equal(r.actions[0].savedKr, 12);
  assert.match(r.items[0].why, /trimmed to Billigere for 12\.00 kr less/);
  assert.equal(r.after, 84);
  assert.equal(r.shortfall, 0);
});

test("the input is not mutated: the caller's own list still holds the product it bought", () => {
  const original = item({ name: "Mælk", price: 40, total: 40, alternatives: [alt({ price: 10, pack: { qty: 1, unit: "stk" } })] });
  const r = trimItems([original], { capKr: 20, minSwapKr: 5 });
  assert.equal(r.items[0].sku, "200", "the trimmed copy moved to the rival");
  assert.equal(original.sku, "100");
  assert.equal(original.total, 40);
});

test("a saving under minSwapKr is brand churn, not a saving", () => {
  const items = [item({ total: 40, price: 40, alternatives: [alt({ price: 37, pack: { qty: 1, unit: "stk" } })] })];
  // The cap is 38: the rival fits under it, so a willing planner takes the swap and a
  // careful one leaves the whole line on the shelf instead.
  const churn = trimItems(items, { capKr: 38, minSwapKr: 5 });
  assert.deepEqual(churn.actions.map((a) => a.action), ["defer"], "3 kr is not worth a different brand");
  assert.equal(churn.after, 0);
  const willing = trimItems(items, { capKr: 38, minSwapKr: 3 });
  assert.deepEqual(willing.actions.map((a) => a.action), ["swap"]);
  assert.equal(willing.after, 37);
});

test("swaps go biggest saving first and stop as soon as the plan fits", () => {
  const items = [
    item({ sku: "a", name: "A", total: 50, price: 50, alternatives: [alt({ sku: "x", name: "Ax", price: 40, pack: { qty: 1, unit: "stk" } })] }),
    item({ sku: "b", name: "B", total: 50, price: 50, alternatives: [alt({ sku: "y", name: "By", price: 20, pack: { qty: 1, unit: "stk" } })] }),
  ];
  const r = trimItems(items, { capKr: 80, minSwapKr: 5 });
  assert.deepEqual(r.actions.map((a) => [a.action, a.from.sku]), [["swap", "b"]], "B's 30 kr saving goes first, then the plan already fits");
  assert.equal(r.after, 70);
  assert.equal(r.items.find((i) => i.sku === "a").sku, "a", "A keeps the product the family asked for");
});

test("a rival that is already another line in the plan is not a rival", () => {
  const items = [
    item({ sku: "200", name: "The cheap one", total: 20, price: 20 }),
    item({ sku: "100", name: "The dear one", total: 60, price: 60, alternatives: [alt({ sku: "200", price: 8, pack: { qty: 1, unit: "stk" } })] }),
  ];
  assert.equal(bestSwap(items[1], { minSwapKr: 5, planSkus: new Set(items.map((i) => i.sku)) }), null);
});

test("what gets put back, in what order: a treat, the household, breakfast, the child's box - never a dinner", () => {
  const items = [
    item({ sku: "d", name: "Potatoes", sources: ["dinner:mad"], total: 60, price: 60 }),
    item({ sku: "s", name: "Chips", sources: ["snacks:chips"], total: 20, price: 20 }),
    item({ sku: "h", name: "Toilet paper", sources: ["household:toiletpapir"], total: 30, price: 30 }),
    item({ sku: "b", name: "Muesli", sources: ["breakfast:muesli"], total: 40, price: 40 }),
    item({ sku: "k", name: "Cheese slices", sources: ["kidLunchbox:ost"], total: 50, price: 50 }),
  ];
  const r = trimItems(items, { capKr: 100, minSwapKr: 5 });
  assert.deepEqual(r.actions.map((a) => [a.action, a.sku]), [["defer", "s"], ["defer", "h"], ["defer", "b"], ["defer", "k"]]);
  assert.equal(r.after, 60);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].sku, "d", "the evening's own ingredient survives to the end");
  assert.deepEqual(r.actions.map((a) => a.protectedBy), ["a treat", "the household", "breakfast", "the child's lunch box"]);
});

test("when even that is not enough, the plan says so instead of cutting a dinner", () => {
  const items = [item({ sku: "d", name: "Potatoes", sources: ["dinner:mad"], total: 60, price: 60 })];
  const r = trimItems(items, { capKr: 10, minSwapKr: 5 });
  assert.equal(r.actions.length, 0);
  assert.equal(r.items.length, 1);
  assert.equal(r.shortfall, 50);
});

test("rankOf protects the most protected thing a line feeds", () => {
  assert.equal(rankOf(item({ sources: ["breakfast:æg", "dinner:bolognese"] })), 0);
  assert.equal(rankOf(item({ sources: ["snacks:banan", "kidLunchbox:banan"] })), 4, "a banana in the child's box is not a treat to cut");
  assert.equal(rankOf(item({ sources: ["snacks:chips"] })), 1);
  assert.equal(rankOf(item({ sources: ["husholdning:ukendt"] })), 2, "a block this planner does not know is treated as household");
  assert.equal(rankOf(item({ sources: [] })), 2);
  assert.equal(rankLabel(0), "a dinner");
  assert.equal(rankLabel(99), "the household");
});

test("packsForAlt: a need in grams uses the pack size, a need counted in packs does not", () => {
  const grams = item({ needMeasure: "g", needAmount: 1000, packs: 4, total: 48 });
  assert.equal(packsForAlt(grams, alt({ price: 10, pack: { qty: 250, unit: "g" } }), {}).packs, 4);
  const packs = item({ packs: 3, total: 60, needMeasure: null, needAmount: 0 });
  assert.equal(packsForAlt(packs, alt({ price: 10, pack: { qty: 2, unit: "stk" } }), {}).packs, 3, "3 packs of milk stays 3 packs in a bigger carton");
});

test("a pack-based need is only a saving when the same count of packs costs less", () => {
  const items = [item({
    name: "Mælk", sources: ["breakfast:mælk"], price: 15, packs: 2, total: 30,
    alternatives: [alt({ name: "Billig mælk", price: 12, pack: { qty: 2, unit: "stk" } })],
  })];
  const r = trimItems(items, { capKr: 25, minSwapKr: 5 });
  assert.equal(r.actions[0].action, "swap");
  assert.equal(r.items[0].packs, 2);
  assert.equal(r.items[0].total, 24, "2 x 12 kr, not 1 x 12 kr: the family drinks 2 cartons");
  assert.equal(r.actions[0].savedKr, 6);
});

test("delivered: what a pack and its count really is", () => {
  assert.deepEqual(delivered({ qty: 430, unit: "g" }, 2), { measure: "g", value: 860 });
  assert.deepEqual(delivered({ qty: 2, unit: "kg" }, 1), { measure: "g", value: 2000 });
  assert.deepEqual(delivered({ qty: 1500, unit: "ml" }, 2), { measure: "l", value: 3 });
  assert.deepEqual(delivered({ qty: 10, unit: "stk" }, 1), { measure: "stk", value: 10 });
  assert.equal(delivered({ qty: null, unit: "g" }, 2), null, "a shop that does not say, does not get a decision");
  assert.equal(delivered({ qty: 6, unit: "bakker" }, 1), null);
  assert.equal(delivered(null, 3), null);
});

test("a cheaper pack that holds less is not a saving, it is a smaller shop", () => {
  // The family's own tub: 430 g at 30,95 kr, two of them. The rival: a 180 g cup at 9,95 kr.
  // Two cups are 360 g against the 860 g they had asked for, so the plan keeps the tub.
  const items = [item({
    name: "Skyr m. vanilje", sources: ["breakfast:skyr"], price: 30.95, packs: 2, total: 61.9,
    pack: { qty: 430, unit: "g" }, alternatives: [alt({ name: "Skyr cup", price: 9.95, pack: { qty: 180, unit: "g" } })],
  })];
  const r = trimItems(items, { capKr: 50, minSwapKr: 5 });
  assert.equal(bestSwap(items[0], { minSwapKr: 5 }), null);
  assert.deepEqual(r.actions.map((a) => a.action), ["defer"], "the line goes back rather than shrinking the breakfast");
});

test("two pack sizes that nearly meet are the same breakfast", () => {
  // 2 x 200 g against 2 x 180 g: nine tenths is met, and 9,95 kr against 30,95 kr is a saving.
  const items = [item({
    name: "Skyr m. vanilje", sources: ["breakfast:skyr"], price: 30.95, packs: 2, total: 61.9,
    pack: { qty: 200, unit: "g" }, alternatives: [alt({ name: "Skyr cup", price: 9.95, pack: { qty: 180, unit: "g" } })],
  })];
  const r = trimItems(items, { capKr: 50, minSwapKr: 5 });
  assert.deepEqual(r.actions.map((a) => a.action), ["swap"]);
  assert.deepEqual([r.actions[0].fromPack, r.actions[0].toPack], ["200 g", "180 g"]);
});

test("budget.swapNeverWords keeps a named line out of the swap", () => {
  const build = () => [item({
    name: "Bleer XL str. 6", brand: "Grønkål", sources: ["household:bleer"], price: 49, packs: 1, total: 49,
    pack: { qty: 22, unit: "stk" }, alternatives: [alt({ name: "Bleer XL str. 6 (pants)", brand: "Grønkål", price: 42, pack: { qty: 20, unit: "stk" } })],
  })];
  const free = trimItems(build(), { capKr: 40, minSwapKr: 5 });
  assert.equal(free.actions[0].action, "swap", "20 pants against 22 tapes is inside the slack, so it is allowed by default");
  const kept = trimItems(build(), { capKr: 40, minSwapKr: 5, swapNeverWords: ["bleer"] });
  assert.deepEqual(kept.actions.map((a) => a.action), ["defer"], "one word in the profile and the size stays as the family bought it");
});

test("the child's lunch box is the last thing a ceiling cuts", () => {
  assert.equal(rankOf(item({ sources: ["lunchbox:aebler"] })), 4);
  assert.equal(rankOf(item({ sources: ["kidLunchbox:aebler"] })), 4);
  assert.equal(rankLabel(rankOf(item({ sources: ["lunchbox:aebler"] }))), "the child's lunch box");
  const items = [
    item({ sku: "a", name: "Æble", sources: ["lunchbox:aebler"], total: 30, price: 30 }),
    item({ sku: "b", name: "Müsli", sources: ["breakfast:muesli"], total: 40, price: 40 }),
  ];
  const r = trimItems(items, { capKr: 35, minSwapKr: 5 });
  assert.deepEqual(r.actions.map((a) => [a.action, a.sku]), [["defer", "b"]], "breakfast goes before the lunch box");
});
