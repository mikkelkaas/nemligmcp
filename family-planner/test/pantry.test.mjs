// pantry.test.mjs - the rebuy list compiler.
//
// The pantry is money: a wrong entry buys a second pack of something a recipe
// already bought. These tests pin the classifier, the schedule arithmetic and the
// merge rules that keep a hand-written entry intact.
import test from "node:test";
import assert from "node:assert/strict";
import { blockOf, scheduleFor, slugId, buildPantry } from "../pantry.mjs";

test("a short keyword must stand alone", () => {
  assert.equal(blockOf("Letmælk 1,5%"), "breakfast");
  assert.equal(blockOf("Rugbrød øko."), "kidLunchbox");
  assert.equal(blockOf("Toiletpapir"), "household");
  assert.equal(blockOf("Banan"), "snacks");
  assert.equal(blockOf("Fiskefars m. hvidfisk"), null, "is is not a token inside fisk");
  assert.equal(blockOf("Tofu"), null);
});

test("a schedule is 80 percent of the measured gap, within bounds", () => {
  assert.equal(scheduleFor(52, 9), 42);
  assert.equal(scheduleFor(24, 9), 19);
  assert.equal(scheduleFor(9, 9), null, "bought every order, no gate");
  assert.equal(scheduleFor(12, 9), null, "less than 1.5 cycles is every order");
  assert.equal(scheduleFor(0, 9), null);
  assert.equal(scheduleFor(1000, 9), 180, "a gate is capped at half a year");
});

test("an id is stable and carries the sku when the name repeats", () => {
  assert.equal(slugId("Letmælk 1,5%", "5062511"), "letmaelk-1-5-062511");
  assert.match(slugId("Æble Royal Gala", "2301197"), /^aeble-royal-gala-301197$/);
});

const milk = {
  sku: "1", name: "Letmælk 1,5%", orders: 40, ordersPct: 60,
  medianQty: 2, medianUnitPrice: 16, lastDate: "2026-10-20", medianGapDays: 9,
};
const toilet = {
  sku: "2", name: "Toiletpapir", orders: 12, ordersPct: 18,
  medianQty: 1, medianUnitPrice: 24, lastDate: "2026-08-26", medianGapDays: 27,
};
const tomato = {
  sku: "3", name: "Tomatpuré", orders: 27, ordersPct: 41,
  medianQty: 1, medianUnitPrice: 12, lastDate: "2026-10-20", medianGapDays: 12,
};
const fancy = {
  sku: "4", name: "Trøffelsalami", orders: 30, ordersPct: 45,
  medianQty: 1, medianUnitPrice: 40, lastDate: "2026-10-20", medianGapDays: 15,
};

const base = {
  schemaVersion: 1,
  cycleDays: 9,
  mining: { minOrders: 6, minPct: 8, now: Date.parse("2026-10-01") },
  blocks: {
    breakfast: [{ id: "minimaelk", query: "Letmælk 1,5%", sku: "1",
      mode: "history", qtyPerCycle: 2, everyNDays: 25, note: "hand written" }],
    kidLunchbox: [],
    snacks: [],
    household: [],
  },
};

test("the merge keeps a hand-written note and schedule", () => {
  const { pantry, added } = buildPantry([milk, toilet, tomato, fancy], base);
  const kept = pantry.blocks.breakfast[0];
  assert.equal(kept.note, "hand written");
  assert.equal(kept.everyNDays, 25, "a manual gate is not overwritten");
  assert.equal(kept.minedOrders, 40, "the evidence is refreshed");
  assert.equal(kept.medianGapDays, 9);
  assert.deepEqual(added.map((a) => a.id), ["toiletpapir-2"]);
  assert.equal(pantry.blocks.household[0].everyNDays, 22);
  assert.ok(!pantry.blocks.kidLunchbox.some((e) => e.query === "Tomatpuré"),
    "a cooking ingredient is not a rebuy staple");
  assert.ok(!pantry.blocks.snacks.some((e) => e.query === "Trøffelsalami"),
    "an unclassified product is not guessed into a block");
});

test("a removed entry stays removed", () => {
  const { pantry, added } = buildPantry([milk, toilet], { ...base, rejected: ["Toiletpapir"] });
  assert.equal(added.length, 0);
  assert.equal(pantry.blocks.household.length, 0);
});

test("a low-frequency product is not a staple yet", () => {
  const rare = { ...toilet, orders: 3, ordersPct: 4 };
  const { added } = buildPantry([rare], base);
  assert.equal(added.length, 0);
});

test("mining is idempotent", () => {
  const first = buildPantry([milk, toilet], base);
  const second = buildPantry([milk, toilet], first.pantry);
  assert.equal(second.added.length, 0);
  assert.equal(second.pantry.blocks.household.length, 1);
});

test("a second flavour of the same staple is not a second line", () => {
  const yoghurt = { ...toilet, sku: "9", name: "Yoghurt m. æble og kiwi 1,4%", orders: 20, ordersPct: 30 };
  const { pantry, added, skipped } = buildPantry([yoghurt], {
    ...base,
    blocks: {
      breakfast: [{ id: "yoghurt", query: "Yoghurt m. jordbær 3,1%", sku: "8", mode: "history", qtyPerCycle: 1 }],
      kidLunchbox: [], snacks: [], household: [],
    },
  });
  assert.equal(added.length, 0);
  assert.equal(pantry.blocks.breakfast.length, 1);
  assert.equal(skipped[0].why, "variant of an existing line");
});

test("a partial block override keeps the other default lists", () => {
  const oats = { ...toilet, sku: "10", name: "Havregryn fine", orders: 12, ordersPct: 18 };
  const { added } = buildPantry([oats, toilet], {
    ...base,
    mining: { minPct: 8, now: Date.parse("2026-10-01"), blocks: { household: ["papir"] } },
  });
  assert.ok(added.some((a) => a.block === "breakfast"), "oats still use the breakfast default");
  assert.ok(added.some((a) => a.block === "household"), "the custom household word is used");
});

test("the default threshold only adds a staple bought in most orders", () => {
  const { added } = buildPantry([toilet], { schemaVersion: 1, cycleDays: 9, blocks: {} });
  assert.equal(added.length, 0, "18 percent is an occasional buy, not a pantry line");
});

test("a pruned auto line is removed, a manual line is kept", () => {
  const auto = { ...toilet, sku: "88", name: "Peberfrugt grøn", orders: 12, ordersPct: 18 };
  const existing = {
    ...base,
    blocks: {
      breakfast: [{ id: "manual", query: "Havregryn", sku: "1", qtyPerCycle: 1 }],
      kidLunchbox: [], snacks: [],
      household: [{ id: "auto", query: "Peberfrugt rød", sku: "99", qtyPerCycle: 1,
        scheduleSource: "mined", qtySource: "mined" }],
    },
  };
  const { pantry, pruned } = buildPantry([milk, auto], existing, { prune: true });
  assert.equal(pruned.length, 1);
  assert.equal(pantry.blocks.breakfast.length, 1, "the manual line stays");
  assert.equal(pantry.blocks.household.length, 0, "the auto line is gone");
});
