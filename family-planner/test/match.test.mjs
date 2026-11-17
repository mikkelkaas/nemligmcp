// Regression tests for the product matcher and the unit maths. Run:
//   node --test test/match.test.mjs
// Every case below is a real Namlig name from this household's history or search
// results. A new failure means the planner would put a different product in the
// basket than the profile asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, tokens, score, nameMatches, shelfContext } from "../match.mjs";
import { parsePack, packsFor, cheapest, toBaseMeasure, pieceGrams, pieceWeightOf, choosePack, subunitGrams, SUBUNIT_GRAMS, eligibleOf, nameHasWord, amountNumber, normalizeAmountText } from "../units.mjs";
import { saleBeatsPin, parseNeed } from "../catalog.mjs";
import { consolidateIntents, searchIntentOf } from "../plan.mjs";
import { pairPlanToOrder, observedDelta, learnedFrom, biasIntent, addIntentsOf } from "../learn.mjs";

const MATCH = [
  ["Spaghetti", "Spaghetti øko."],
  ["Spaghetti", "Spaghetti m. fuldkorn øko."],
  ["Panang karrypasta", "Frisk panang karrypasta (sød)"],
  ["Dild", "Dild øko."],
  ["Karry", "Karry styrk 23"],
  ["Rugbrød", "Rugbrød grov"],
  ["Makrel i tomat", "Makrel i tomat dåse"],
];

const NO_MATCH = [
  ["Jordbær", "Yoghurt m. jordbær 3,1%"],
  ["Dild", "Laksepaté m. dild"],
  ["Ost", "Pølse m. ost"],
  ["Agurk", "Agurkesalat"],
  ["Ris", "Rismel"],
  ["Kartoffel", "Flutekartofler chips"],
];

test("norm folds case and punctuation, keeps the Danish letters", () => {
  assert.equal(norm("Æble ØKO. 1,5%"), "æble øko 1 5");
  // numbers and grade words carry no product identity, so tokens drops them
  assert.deepEqual(tokens("Mælk 1,5% let"), ["mælk"]);
});

test("same product matches", () => {
  for (const [q, n] of MATCH) {
    assert.ok(nameMatches(q, n), `expected match: "${q}" vs "${n}" (score ${score(q, n)})`);
  }
});

test("different product does not match", () => {
  for (const [q, n] of NO_MATCH) {
    assert.equal(nameMatches(q, n), false, `expected NO match: "${q}" vs "${n}" (score ${score(q, n)})`);
  }
});

// parsePack takes the Namlig "AmountDescription" (a size first), not a product name.
test("pack sizes parse", () => {
  assert.deepEqual(parsePack("500 g"), { qty: 500, unit: "g", raw: "500 g" });
  assert.deepEqual(parsePack("1,5 l"), { qty: 1500, unit: "ml", raw: "1,5 l" });
  assert.deepEqual(parsePack("200 stk"), { qty: 200, unit: "stk", raw: "200 stk" });
  assert.deepEqual(parsePack("4 x 150 g"), { qty: 600, unit: "g", raw: "4 x 150 g" });
  assert.deepEqual(parsePack("24 x 0,33 l / ex. pant"), { qty: 7920, unit: "ml", raw: "24 x 0,33 l / ex. pant" });
  assert.deepEqual(parsePack("15 stk. / Danæg"), { qty: 15, unit: "stk", raw: "15 stk. / Danæg" });
  assert.deepEqual(parsePack("0,25 l / Oma"), { qty: 250, unit: "ml", raw: "0,25 l / Oma" });
  assert.equal(parsePack("Uden størrelse").qty, null);
  assert.equal(parsePack("").qty, null);
});

test("need converts to base measure", () => {
  assert.deepEqual(toBaseMeasure(2, "kg"), { measure: "g", value: 2000 });
  assert.deepEqual(toBaseMeasure(0.5, "l"), { measure: "ml", value: 500 });
});

test("packs cover the need", () => {
  assert.equal(packsFor({ qty: 1000, unit: "g" }, { qty: 500, unit: "g" }), 2);
  assert.equal(packsFor({ qty: 750, unit: "g" }, { qty: 500, unit: "g" }), 2);
  assert.equal(packsFor({ qty: 400, unit: "g" }, { qty: 500, unit: "g" }), 1);
  // never compare units: 500 g need against a 500 ml pack buys 1 pack, not a guess
  assert.equal(packsFor({ qty: 500, unit: "g" }, { qty: 500, unit: "ml" }), 1);
  assert.equal(packsFor(null, { qty: 500, unit: "g" }), 1);
});

const P = (id, name, price, unitPrice, unitLabel, extra = {}) => ({
  id, name, brand: extra.brand || "", price, unitPrice, unitLabel,
  availability: { IsDeliveryAvailable: extra.outOfStock ? false : true, IsAvailableInStock: extra.outOfStock ? false : true },
});

test("cheapest compares inside one unit axis", () => {
  const list = [
    P("1", "Ost Block", 17.5, 70, "kg"),
    P("2", "Ost Skive", 12, 60, "kg"),
    P("3", "Ost Snacks", 9, 30, "stk"),
  ];
  const r = cheapest(list);
  assert.equal(r.pick.id, "2");
  assert.equal(r.mode, "unit:kg");
  assert.equal(r.considered, 3);
});

test("unavailable and avoided brands are rejected", () => {
  const list = [
    P("1", "Mælk Økologisk", 12, 8, "l", { outOfStock: true }),
    P("2", "Mælk NotInBrand", 10, 7, "l", { brand: "Thise" }),
    P("3", "Mælk Mejeriet", 14, 9, "l"),
  ];
  const r = cheapest(list, { avoidBrands: ["thise"] });
  assert.equal(r.pick.id, "3");
  assert.equal(r.considered, 1);
  assert.deepEqual(r.rejected.map((x) => x.why).sort(), ["brand Thise", "not available"]);
});

test("empty candidate list returns no pick instead of throwing", () => {
  const r = cheapest([]);
  assert.equal(r.pick, null);
  assert.equal(r.considered, 0);
});

test("preferSku wins over a cheaper rival", () => {
  const list = [P("1", "Yoghurt Billig", 8, 5, "kg"), P("2", "Yoghurt Yndlings", 12, 9, "kg")];
  const r = cheapest(list, { preferSku: "2" });
  assert.equal(r.pick.id, "2");
});

test("a need in pieces means that many packs", () => {
  // "2 stk kokosmælk" is 2 cans, not 2 grams and not 1 can
  assert.equal(packsFor({ qty: 2, unit: "stk" }, { qty: 400, unit: "ml" }), 2);
  assert.equal(packsFor({ qty: 3, unit: "stk" }, { qty: 400, unit: "g" }), 3);
  assert.equal(packsFor({ qty: 1, unit: "stk" }, { qty: null, unit: null }), 1);
  assert.equal(packsFor({ qty: 1, unit: "bundt" }, { qty: 1, unit: "bundt" }), 1);
});

test("length labels are not pack sizes", () => {
  // Dild is sold as "7cm" - that is a size descriptor, not a quantity
  assert.equal(parsePack("7cm").qty, null);
  assert.equal(parsePack("10.5cm").qty, null);
});

test("on-sale product wins inside the tolerance band", () => {
  const P = (id, price, unitPrice, onSale) => ({
    id, name: "Produkt " + id, brand: "", price, unitPrice, unitLabel: "kr/kg", onSale,
    availability: { IsDeliveryAvailable: true, IsAvailableInStock: true },
  });
  const cheap = P("1", 20, 40, false);
  const sale = P("2", 21.6, 43.2, true); // 8 % more per unit, on sale
  const r = cheapest([cheap, sale], { preferSale: true, saleTolerancePct: 10 });
  assert.equal(r.pick.id, "2");
  assert.match(r.saleNote, /on sale/);
  // beyond the band the flat cheapest wins
  const far = P("3", 30, 60, true);
  assert.equal(cheapest([cheap, far], { preferSale: true, saleTolerancePct: 10 }).pick.id, "1");
  // preferSale false always takes the cheapest
  assert.equal(cheapest([cheap, sale], { preferSale: false }).pick.id, "1");
});

test("a bulk campaign is reported, never bought silently", () => {
  const P = (id, price, unitPrice, extra = {}) => ({
    id, name: "Produkt " + id, brand: "", price, unitPrice, unitLabel: "kr/kg",
    pack: { qty: 500, unit: "g", raw: "500 g" },
    availability: { IsDeliveryAvailable: true, IsAvailableInStock: true }, ...extra,
  });
  const single = P("1", 15, 30);
  // 5 packs for 30 kr = 6 kr a pack = 12 kr/kg, cheaper than the 20 kr/kg shelf price
  const bulk = P("2", 10, 20, { campaign: { min: 5, totalPrice: 30, type: "ProductCampaignMixOffer" } });
  const r = cheapest([single, bulk], {});
  assert.equal(r.pick.id, "2");
  assert.equal(r.campaignTip.min, 5);
  assert.equal(r.campaignTip.perUnit, 12);
  assert.equal(r.campaignTip.beatsBy, 8);
  // no pack size means no comparison - a bulk tip must never be invented
  assert.equal(cheapest([single, { ...bulk, pack: { qty: null, unit: null, raw: "" } }], {}).campaignTip, null);
});

test("Danish inflection and prepared products", () => {
  assert.ok(nameMatches("Gulerod", "Gulerødder snack"), "gulerod must reach gulerødder");
  assert.ok(nameMatches("Peberfrugt", "Peberfrugter"));
  assert.equal(nameMatches("Dild", "Dild dip mix"), false, "a dip mix is not fresh dill");
  assert.equal(nameMatches("Citron", "Citronsaft koncentreret"), false, "lemon juice is not a lemon");
  assert.equal(nameMatches("Makrel", "Makrelsalat"), false, "fish salad is not whole mackerel");
  assert.equal(nameMatches("Karry", "Rød karrypasta"), false, "curry paste is not curry powder");
  assert.ok(nameMatches("Mayonnaise", "Mayonnaise (let)"), "a word the query asked for is never an extra");
});

test("one letter inside a long name is still the same dish", () => {
  assert.ok(nameMatches("Tortellini m. skinke frisk", "Tortelloni m. skinke (frisk)"));
  // short words keep the strict rule, so these must stay different products
  assert.equal(nameMatches("Ris", "Rismel"), false);
  assert.equal(nameMatches("Ost", "Pølse m. ost"), false);
});

// --- resolver behaviour with a stubbed Namlig search (no network) ---
import { resolveIntent } from "../catalog.mjs";
import { cleanQuery, recipeIntents, chooseDinners } from "../dinners.mjs";

const RAW = {
  "spaghetti m. fuldkorn øko": [
    { Id: "5601415", Name: "Spaghetti m. fuldkorn øko.", Price: 11.95, UnitPriceCalc: 23.9, UnitPriceLabel: "kr/kg",
      Description: "500 g / Casaneo", Availability: { IsDeliveryAvailable: false, IsAvailableInStock: false } },
  ],
  spaghetti: [
    { Id: "5601001", Name: "Spaghetti al dente", Price: 9.95, UnitPriceCalc: 19.9, UnitPriceLabel: "kr/kg",
      Description: "500 g / First Price", Availability: { IsDeliveryAvailable: true, IsAvailableInStock: true } },
    { Id: "5601002", Name: "Spaghetti øko.", Price: 7.95, UnitPriceCalc: 15.9, UnitPriceLabel: "kr/kg",
      Description: "500 g / Casaneo", Labels: ["Discount"], Availability: { IsDeliveryAvailable: true, IsAvailableInStock: true } },
  ],
};

function stubMcp() {
  return {
    async call(tool, args) {
      if (tool !== "search_products") return { isError: true, text: "unexpected tool " + tool, json: null };
      const list = RAW[String(args.query).toLowerCase()] || [];
      return { isError: false, text: "", json: { Products: { Products: list } } };
    },
  };
}

test("out of stock: nothing is bought, the cheapest alternative is proposed", async () => {
  const r = await resolveIntent(stubMcp(), { query: "Spaghetti m. fuldkorn øko", need: "500 g" }, {});
  assert.equal(r.ok, false);
  assert.ok(r.substitution, "a substitution must be proposed");
  assert.equal(r.substitution.name, "Spaghetti øko.");
  assert.equal(r.substitution.packs, 1);
  assert.equal(r.substitution.onSale, true);
  assert.equal(r.substitution.accept, '--extra "Spaghetti øko.:500 g"');
});

test("profile alt queries are used before any proposal", async () => {
  const r = await resolveIntent(stubMcp(), { query: "Spaghetti m. fuldkorn øko", need: "500 g", alt: ["Spaghetti"] }, {});
  assert.equal(r.ok, true);
  assert.equal(r.pick.name, "Spaghetti øko.");
  assert.equal(r.substitutedFrom, "Spaghetti m. fuldkorn øko");
  assert.match(r.why, /swapped from/);
});

test("cleanQuery turns a Namlig ingredient sentence into a searchable product name", () => {
  assert.equal(cleanQuery("Håndfuld bønnespirer"), "Bønnespirer");
  assert.equal(cleanQuery("Sojasauce - evt. glutenfri"), "Sojasauce");
  assert.equal(cleanQuery("Ægnudler, ca. 200 g"), "Ægnudler");
  assert.equal(cleanQuery("Oksekød i strimler, fx flankesteak eller entrecote"), "Oksekød strimler");
  assert.equal(cleanQuery("Lime, saften heraf"), "Lime");
  assert.equal(cleanQuery("Frisk spinat"), "Spinat");
  assert.equal(cleanQuery("Ærter, optøede eller friske"), "Ærter");
  assert.equal(cleanQuery("Gode pølser"), "Gode pølser");
});

test("cleanQuery cuts the second choice a recipe line names", () => {
  // These six lines an 8-day plan could not answer on 12 Nov: the aside was searched
  // instead of the product, so nothing on the shelf reached the name threshold.
  assert.equal(cleanQuery("Spinat alternativt grønkål"), "Spinat");
  assert.equal(cleanQuery("Frisk spinat alternativt grønkål"), "Spinat");
  assert.equal(cleanQuery("Kaffir limeblade alternativt"), "Kaffir limeblade");
  assert.equal(cleanQuery("Nødder eventuelt"), "Nødder");
  assert.equal(cleanQuery("Sojasauce evt glutenfri"), "Sojasauce");
  assert.equal(cleanQuery("Naanbrød (tilføj selv til kurv)"), "Naanbrød");
  assert.equal(cleanQuery("Raita link opskrift"), "Raita");
  // A family's own wording comes from its profile, not from code.
  assert.equal(cleanQuery("Ost alternativ eller", ["eller"]), "Ost");
  // An aside that opens the line still leaves a product to search for.
  assert.equal(cleanQuery("Alternativt sojasauce"), "Sojasauce");
});

test("a family that buys rice both ways is not blocked by how it is sold", () => {
  const rice = ["parboiled", "basmati", "jasmin", "sushi", "kogepose", "løse"];
  assert.equal(nameMatches("Ris", "Parboiled ris i kogepose"), false, "without the family's own list the head-noun guard holds");
  assert.equal(nameMatches("Ris", "Parboiled ris i kogepose", 0.7, rice), true, "parboiled rice is the rice the recipe asked for");
  assert.equal(nameMatches("Ris", "Basmati ris", 0.7, rice), true, "and so is basmati - the price rule picks between them");
  // Strictness survives in both other directions: the query's own word must still be there,
  // and a family list never makes another product into this one.
  assert.equal(nameMatches("Basmati ris", "Ris", 0.7, rice), false, "asking for basmati is not answered by plain rice");
  assert.equal(nameMatches("Ris", "Risotto ris", 0.7, rice), false, "a variety the family did not list stays refused");
  assert.equal(nameMatches("Karry", "Karry sauce", 0.7, rice), false, "a sauce is another product, list or not");
  assert.equal(nameMatches("Ost", "Pølse m. ost", 0.7, rice), false, "and a sausage with cheese is not cheese");
});

test("a line with a second choice searches the product, not the sentence", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 5, ingredients: [
    { text: "Asparges (alternativt kan asparges erstattes af spinat)", amount: "1", unit: "stk" },
  ] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions });
  assert.equal(out.intents[0].query, "Asparges", "the product, with no aside words");
  assert.deepEqual(out.intents[0].alt, [], "the cut text is the first query, so there is nothing to retry");
});

test("recipeIntents scales to 5 servings, merges repeats and skips pantry words", async () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: ["salt"] }, freshHerbs: { words: ["persille"] }, neverBought: { words: ["kapers"] } };
  const recipe = { name: "Test", servings: 4, ingredients: [
    { text: "Kylling", amount: "250", unit: "g", grams: 250 },
    { text: "Kylling", amount: "100", unit: "g", grams: 100 },
    { text: "Salt", amount: "1", unit: "tsk", grams: 5 },
    { text: "Persille", amount: "1", unit: "stk", grams: 10 },
    { text: "Kapers", amount: "1", unit: "spsk", grams: 5 },
  ] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions });
  assert.equal(out.intents.length, 1, "salt, herbs and never-bought items are not intents");
  assert.equal(out.intents[0].need, "500 g", "250+100 g for 4 persons scales to 5 servings without doubling");
  assert.match(out.intents[0].rationale, /5 portions/);
  assert.deepEqual(out.leftOut.map((l) => l.text), ["Persille", "Kapers"]);
});

test("a family that cooks by the pack scales named proteins, and toppings keep the recipe", async () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] } };
  const recipe = { name: "Pack", servings: 4, ingredients: [
    { text: "Hakket oksekød", amount: "250", unit: "g", grams: 250 },
    { text: "Bacon i tern", amount: "100", unit: "g", grams: 100 },
  ] };
  const grams = (n) => Number(String(n).match(/\d+/)[0]);
  const plain = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions });
  const packed = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions,
    purchasing: { proteinNightFactor: 1.8, proteinScaleWords: ["hakket"] } });
  assert.equal(packed.intents.length, plain.intents.length, "nothing is skipped or added");
  assert.equal(grams(packed.intents[0].need), Math.round(grams(plain.intents[0].need) * 1.8),
    "the named main protein grows by the profile factor");
  assert.equal(packed.intents[1].need, plain.intents[1].need, "an unnamed topping keeps the recipe size");
  const off = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions,
    purchasing: { proteinNightFactor: 1, proteinScaleWords: ["hakket"] } });
  assert.deepEqual(off.intents.map((i) => i.need), plain.intents.map((i) => i.need),
    "factor 1 changes nothing for a family that says nothing");
});

test("a liked dish leads the queue even when it was cooked recently", () => {
  const pool = [
    { url: "/liked", name: "Liked", protein: "kylling", format: "gryde", score: 5 },
    { url: "/old", name: "Old", protein: "oksekod", format: "gryde", score: 5 },
  ];
  const r = chooseDinners(pool, { days: 2, coversDays: 1, maxPerProtein: 2, minFish: 0,
    lastUsed: { "/liked": "2026-11-16", "/old": "2026-08-01" },
    taste: { liked: ["/liked"], refused: [] }, wanted: [] });
  assert.equal(r.menu[0].name, "Liked");
});

test("chooseDinners alternates a new dish with one the family knows", async () => {
  const pool = [
    { url: "/a", name: "Known A", protein: "oksekod", score: 50 },
    { url: "/b", name: "Known B", protein: "kylling", score: 40 },
    { url: "/c", name: "New C", protein: "fisk", score: 10 },
    { url: "/d", name: "New D", protein: "svinepolse", score: 9 },
  ];
  const pick = chooseDinners(pool, { days: 8, coversDays: 2, lastUsed: { "/a": "2026-01-01", "/b": "2026-02-01" }, wanted: [] });
  assert.equal(pick.chosen.length, 4);
  const names = pick.chosen.map((c) => c.name);
  assert.ok(names.includes("New C") && names.includes("Known A"), "the rotation mixes new and known: " + names.join(", "));
  assert.equal(pick.daysPerDinner, 2);
});

// --- apply.mjs: recipe card first, plan quantity second, rejects third -------------
import { wantQtyOf, cardDecisions, cardLineOf, slotOutcomeOf } from "../apply.mjs";
import { recipeIngredients, cardSelections, planItemForIngredient, cardPayload } from "../recipes.mjs";
import { basketDelta } from "../tools/mine-basket.mjs";
import { keptDinners, poolEntry, capPool } from "../tools/mine-menu.mjs";
import { bestSku } from "../pin-skus.mjs";

test("a plan quantity overwrites the amount a recipe card put in, down as well as up", () => {
  assert.equal(wantQtyOf({ packs: 2 }, 5, true), 2);
  assert.equal(wantQtyOf({ packs: 3 }, 1, true), 3);
});

test("without a recipe card the basket quantity only ever goes up", () => {
  assert.equal(wantQtyOf({ packs: 2 }, 5, false), 5);
  assert.equal(wantQtyOf({ packs: 4 }, 1, false), 4);
});

test("a planned quantity of zero is refused instead of wiping a line", () => {
  assert.equal(wantQtyOf({ packs: 0 }, 2, true), null);
});

test("a card product the plan wants at that quantity is kept, not written again", () => {
  const cards = [{ sku: "5001", name: "Spaghetti", qty: 2 }];
  const plan = [{ sku: "5001", name: "Spaghetti", packs: 2 }];
  const out = cardDecisions(cards, plan);
  assert.deepEqual(out.keep.map((d) => d.sku), ["5001"], "the card already holds it");
  assert.deepEqual(out.topUp, []);
  assert.deepEqual(out.zero, []);
  assert.equal(out.covered.has("5001"), true, "so writeItems does not touch it");
});

test("a card product the plan wants more of is topped up, never added again", () => {
  const cards = [{ sku: "5002", name: "Ris", qty: 1 }];
  const plan = [{ sku: "5002", name: "Ris", packs: 3 }];
  const out = cardDecisions(cards, plan);
  assert.deepEqual(out.topUp.map((d) => [d.sku, d.setTo]), [["5002", 3]], "set_basket_quantity, not add_to_basket");
  assert.equal(out.keep.length, 0);
  assert.equal(out.covered.has("5002"), true);
});

test("a card product no plan line matches is zeroed", () => {
  const cards = [{ sku: "5003", name: "Dild", qty: 1 }];
  const plan = [{ sku: "5001", name: "Spaghetti", packs: 2 }];
  const out = cardDecisions(cards, plan);
  assert.equal(out.zero.length, 1);
  assert.match(out.zero[0].why, /no plan line for it/);
  assert.equal(out.covered.size, 0);
});

test("a card product the plan buys as another product is zeroed, and the plan's pick wins", () => {
  const cards = [{ sku: "5004", name: "Spaghetti", qty: 1 }];
  const plan = [{ sku: "5005", name: "Spaghetti øko.", packs: 2 }];
  const out = cardDecisions(cards, plan);
  assert.equal(out.zero.length, 1);
  assert.match(out.zero[0].why, /plan buys it as Spaghetti øko\./);
  assert.equal(out.topUp.length, 0, "the card sku is not the plan sku, so nothing is topped up");
});

test("one decision per sku, and a card line with no sku is skipped", () => {
  const cards = [
    { sku: "5001", name: "Spaghetti", qty: 2 },
    { sku: "5001", name: "Spaghetti", qty: 2 },
    { sku: "", name: "Salt", qty: 1 },
  ];
  const plan = [{ sku: "5001", name: "Spaghetti", packs: 2 }];
  const out = cardDecisions(cards, plan);
  assert.equal(out.keep.length, 1);
  assert.equal(out.zero.length, 0, "a line with no sku cannot be acted on");
});

test("a card line reads the field names recipeLines returns", () => {
  const line = cardLineOf({ recipe: "A", productId: 5001, name: "Spaghetti", quantity: "2" });
  assert.deepEqual(line, { sku: "5001", name: "Spaghetti", qty: 2 });
  assert.equal(cardLineOf({ sku: "9", productNumber: "9", quantity: 1 }).sku, "", "the old wrong field is not read");
});

test("a card that brings more than the plan is zeroed before the plan line is written", () => {
  const out = cardDecisions([{ sku: "5001", name: "Spaghetti", qty: 7 }], [{ sku: "5001", name: "Spaghetti", packs: 3 }]);
  assert.equal(out.zero.length, 1);
  assert.match(out.zero[0].why, /plan wants 3/);
  assert.equal(out.covered.has("5001"), false, "so writeItems puts the plan amount in a line");
});

test("an over-bought card product with a line already there is left alone", () => {
  const out = cardDecisions([{ sku: "5001", name: "Spaghetti", qty: 7 }], [{ sku: "5001", name: "Spaghetti", packs: 3 }], new Map([["5001", 2]]));
  assert.equal(out.keep.length, 1);
  assert.equal(out.zero.length, 0, "zeroing would take the existing line with it");
});

test("a card product that finishes a line already in the basket is kept, not topped up", () => {
  const cards = [{ sku: "5001", name: "Spaghetti", qty: 1 }];
  const plan = [{ sku: "5001", name: "Spaghetti", packs: 3 }];
  const out = cardDecisions(cards, plan, new Map([["5001", 2]]));
  assert.equal(out.keep.length, 1, "1 on the card plus 2 in the basket is the 3 the plan wants");
  assert.equal(out.topUp.length, 0);
  assert.equal(out.covered.has("5001"), true);
});

test("a card product that leaves a gap is topped up to the plan total, never the full count", () => {
  const cards = [{ sku: "5002", name: "Ris", qty: 1 }];
  const plan = [{ sku: "5002", name: "Ris", packs: 3 }];
  const out = cardDecisions(cards, plan, new Map([["5002", 1]]));
  assert.deepEqual(out.topUp.map((d) => [d.setTo, d.held]), [[2, 1]], "the card target is 3 - 1, not 3");
});

test("a recipe page number with a Danish comma is read as a number", () => {
  const page = { content: [{ Header: "Test ret", NumberOfPersons: 4, IngredientGroups: [{ Ingredients: [
    { ProductSelectionId: "11111111-1111-1111-1111-111111111111", Text: "Sauce", Amount: "0,5", Unit: "l", MesaureWeightInGram: null, MeasureMassInLiter: "0,1" },
  ] }] }] };
  assert.equal(recipeIngredients(page).ingredients[0].litres, 0.1);
  assert.equal(recipeIngredients(page).ingredients[0].grams, null);
});

test("a recipe page gives the selection ids the card API needs", () => {
  const page = { content: [{ Header: "Test ret", NumberOfPersons: 4, IngredientGroups: [{ Ingredients: [
    { ProductSelectionId: "11111111-1111-1111-1111-111111111111", Text: "Spaghetti", Amount: "500", Unit: "g", MesaureWeightInGram: "500", MeasureMassInLiter: null },
    { Text: "Salt" },
  ] }] }] };
  assert.deepEqual(recipeIngredients(page), {
    name: "Test ret",
    servings: 4,
    ingredients: [{ selectionId: "11111111-1111-1111-1111-111111111111", text: "Spaghetti", amount: "500", unit: "g", grams: 500, litres: null }],
  });
});

test("the plan's own pick fills the card, in the quantity the plan still needs", () => {
  const recipe = {
    url: "/opskrifter/test-98000001",
    ingredients: [
      { selectionId: "11111111-1111-1111-1111-111111111111", text: "Spaghetti" },
      { selectionId: "22222222-2222-2222-2222-222222222222", text: "Dild" },
      { selectionId: "33333333-3333-3333-3333-333333333333", text: "Spaghetti" },
    ],
  };
  const plan = [{ sku: "7001", name: "Spaghetti øko.", packs: 2, sources: ["dinner:/opskrifter/test-98000001"], why: "cheapest" }];
  const out = cardSelections(recipe, plan, new Map([["7001", 1]]));
  assert.deepEqual(out.selected, [{
    ProductSelectionId: "11111111-1111-1111-1111-111111111111",
    ProductSelectionName: "Spaghetti øko.",
    ProductId: "7001",
    Quantity: 1,
    name: "Spaghetti øko.",
    ingredient: "Spaghetti",
    why: "cheapest",
  }], "one pack, because the basket already holds one");
  assert.equal(out.skipped.length, 2, "no plan line for dill, and the second spaghetti is the same product");
  assert.match(out.skipped[1].why, /already on another card/);
  assert.equal(out.expected, 1, "one plan line for this recipe");
});

test("a product the basket already holds at the plan quantity is not put on a card", () => {
  const recipe = { url: "/opskrifter/test-98000002", ingredients: [
    { selectionId: "44444444-4444-4444-4444-444444444444", text: "Ris" },
  ] };
  const plan = [{ sku: "7002", name: "Ris", packs: 2, sources: ["dinner:/opskrifter/test-98000002"] }];
  const out = cardSelections(recipe, plan, new Map([["7002", 2]]));
  assert.equal(out.selected.length, 0);
  assert.match(out.skipped[0].why, /already in the basket/);
});

test("a recipe word finds the plan's pack: a chicken cut is chicken", () => {
  assert.equal(planItemForIngredient("Kylling i wok strimler", [{ sku: "1", name: "Kyllingebrystfilet" }]).sku, "1");
  assert.equal(planItemForIngredient("Sojasauce - evt. glutenfri", [{ sku: "2", name: "Sojasauce" }]).sku, "2");
  assert.equal(planItemForIngredient("Dild", [{ sku: "3", name: "Spaghetti" }]), null);
});

test("a family alias and a long stem put the right product on the card", () => {
  assert.equal(planItemForIngredient("Parmesan", [{ sku: "1", name: "Ost E" }], { parmesan: "Ost E" }).sku, "1");
  assert.equal(planItemForIngredient("Spaghetti", [{ sku: "2", name: "Spaghettoni øko." }]).sku, "2");
});

test("a teaspoon is a kitchen measure, not the page's gram figure", () => {
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 4, ingredients: [
    { text: "Chiliflager", amount: "2", unit: "tsk", grams: 50 },
    { text: "Østerssauce", amount: "1", unit: "spsk", litres: 0.1 },
  ] };
  const out = recipeIntents(recipe, { amounts: { household: { cookServings: 4 } }, meat: { rules: [] }, exclusions, portions: 4, standardPortions: 4 });
  assert.equal(out.intents.find((i) => i.query === "Chiliflager").need, "10 g", "2 tsk is 10 g, not the 50 g the page states");
  assert.equal(out.intents.find((i) => i.query === "Østerssauce").need, "15 ml", "1 spsk is 15 ml, not 0.1 l");
  for (const [amount, want] of [["1,5", "10 g"], ["1/2", "5 g"]]) {
    const one = { name: "T", servings: 4, ingredients: [{ text: "Chiliflager", amount, unit: "tsk", grams: 50 }] };
    const out2 = recipeIntents(one, { amounts: { household: { cookServings: 4 } }, meat: { rules: [] }, exclusions, portions: 4, standardPortions: 4 });
    assert.equal(out2.intents[0].need, want, `${amount} tsk is ${want}, not read as 1 tsk`);
  }
});

test("a tiny pack is refused before it becomes ten packs", () => {
  const tiny = { name: "Chiliflager", price: 5.95, pack: parsePack("5 g") };
  assert.equal(choosePack({ qty: 50, unit: "g" }, [tiny], { name: "Chiliflager", maxPacksPerLine: 4 }), null);
  assert.equal(choosePack({ qty: 10, unit: "g" }, [tiny], { name: "Chiliflager", maxPacksPerLine: 4 }).packs, 2);
});

test("a generic category in front of a shape is dropped: pasta penne is penne", () => {
  assert.equal(cleanQuery("Pasta penne"), "Penne");
  assert.equal(cleanQuery("Pasta"), "Pasta", "a category on its own is still the product");
});

test("a baby recipe is excluded by its name", () => {
  const pool = [
    { url: "/a", name: "Hurtige pizzasnegle - fra 9 mdr.", protein: "svinepolse", format: "pizza", score: 9 },
    { url: "/b", name: "Kylling A", protein: "kylling", format: "gryde", score: 8 },
    { url: "/c", name: "Okse B", protein: "oksekod", format: "gryde", score: 7 },
  ];
  const r = chooseDinners(pool, { days: 2, coversDays: 1, maxPerProtein: 4, minFish: 0, noVegetarian: true, excludeWords: ["baby", "fra 9 mdr"], lastUsed: {}, wanted: [] });
  assert.ok(r.menu.every((m) => !m.name.toLowerCase().includes("mdr")), "no baby recipe: " + r.menu.map((m) => m.name).join(", "));
});

test("at most two new dinners, and a new one must be quick", () => {
  const pool = [
    { url: "/n1", name: "New 1", protein: "kylling", format: "gryde", minutes: 20, score: 5 },
    { url: "/n2", name: "New 2", protein: "oksekod", format: "gryde", minutes: 25, score: 5 },
    { url: "/n3", name: "New 3", protein: "fisk", format: "gryde", minutes: 20, score: 5 },
    { url: "/n4", name: "New 4", protein: "svinepolse", format: "gryde", minutes: 45, score: 5 },
    { url: "/k1", name: "Known 1", protein: "kylling", format: "fad", minutes: 20, score: 5 },
    { url: "/k2", name: "Known 2", protein: "oksekod", format: "fad", minutes: 25, score: 5 },
    { url: "/k3", name: "Known 3", protein: "fisk", format: "fad", minutes: 30, score: 5 },
  ];
  const lastUsed = { "/k1": "2026-08-01", "/k2": "2026-08-02", "/k3": "2026-08-03" };
  const r = chooseDinners(pool, { days: 10, coversDays: 2, maxPerProtein: 5, minFish: 0, lastUsed,
    taste: { liked: [], refused: [] }, wanted: [], maxNewPerPlan: 2, newMaxMinutes: 30 });
  const fresh = r.menu.filter((m) => m.cookedAgo === "never");
  assert.ok(fresh.length <= 2, "fresh: " + fresh.map((m) => m.name).join(", "));
  assert.ok(fresh.every((m) => m.minutes <= 30), "a new dinner must be quick: " + fresh.map((m) => `${m.name} ${m.minutes}`).join(", "));
});

test("an avoided word is found in the recipe URL too", () => {
  const pool = [
    { url: "/opskrifter/salatpizza-kyllingekebab-1", name: "Salatpizza med kebab", protein: "oksekod", format: "pizza", score: 9 },
    { url: "/butter", name: "Butter chicken", protein: "oksekod", format: "gryde", score: 9, ingredients: [{ text: "Kyllingebrystfilet" }] },
    { url: "/b", name: "Okse B", protein: "oksekod", format: "gryde", score: 8 },
    { url: "/c", name: "Fisk C", protein: "fisk", format: "gryde", score: 7 },
  ];
  const r = chooseDinners(pool, { days: 4, coversDays: 2, maxPerProtein: 3, minFish: 0, excludeWords: ["kylling"], lastUsed: {}, wanted: [] });
  assert.ok(!r.chosen.some((d) => d.url.includes("kylling") || d.name.includes("chicken")), "the avoided word in the URL or an ingredient excludes the dish");
});

test("a family that wants meat never gets a vegetarian dinner from the rotation", () => {
  const pool = [
    { url: "/a", name: "Kylling A", protein: "kylling", format: "gryde", score: 9 },
    { url: "/b", name: "Okse B", protein: "oksekod", format: "gryde", score: 8 },
    { url: "/c", name: "Veg C", protein: "vegetar", format: "gryde", score: 7 },
    { url: "/e", name: "Ost E", protein: "ostaeq", format: "gryde", score: 5 },
    { url: "/d", name: "Fisk D", protein: "fisk", format: "gryde", score: 6 },
  ];
  const r = chooseDinners(pool, { days: 4, coversDays: 2, maxPerProtein: 4, minFish: 1, noVegetarian: true, lastUsed: {}, wanted: [] });
  assert.ok(r.menu.length >= 2, "the pool still fills the period");
  assert.ok(r.menu.every((m) => !["vegetar", "ostaeq", "aeg"].includes(m.protein)), "meat or fish only: " + r.menu.map((m) => `${m.name} (${m.protein})`).join(", "));
});

test("only the dinners whose products survived the correction are kept", () => {
  const plan = {
    dinnerMenu: [{ name: "Dinner A", url: "/a" }, { name: "Dinner B", url: "/b" }, { name: "Dinner C", url: "/c" }],
    items: [
      { sku: "1", name: "Spaghetti", packs: 1, sources: ["dinner:/a"] },
      { sku: "2", name: "Ris", packs: 1, sources: ["dinner:/b"] },
      { sku: "3", name: "Dild", packs: 1, sources: ["dinner:/c"] },
      { sku: "4", name: "Salt", packs: 1, sources: ["dinner:/c"] },
    ],
  };
  const basket = { Lines: [{ Id: "1", Name: "Spaghetti", Quantity: 1 }, { Id: "3", Name: "Dild", Quantity: 1 }], Recipes: [] };
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), ["Dinner A"], "Dinner C has only one of two lines");
});

test("a corrected basket reports what was removed, reduced, increased and added", () => {
  const plan = { items: [
    { sku: "1", name: "Spaghetti", packs: 2 },
    { sku: "2", name: "Ris", packs: 1 },
    { sku: "3", name: "Dild", packs: 1 },
  ], dinnerMenu: [{ name: "Dinner A" }] };
  const basket = {
    Lines: [{ Id: "1", Name: "Spaghetti", Quantity: 1 }, { Id: "4", Name: "Salt", Quantity: 1 }],
    Recipes: [{ Title: "Dinner B", RecipeLineItems: [{ ProductId: "2", ProductName: "Ris", Quantity: 2 }] }],
    TotalProductsPrice: 100, TotalPrice: 120, DeliveryPrice: 20,
  };
  const d = basketDelta(plan, basket);
  assert.deepEqual(d.cards.removed, ["Dinner A"]);
  assert.deepEqual(d.cards.added, ["Dinner B"]);
  assert.deepEqual(d.reduced.map((x) => x.sku), ["1"]);
  assert.deepEqual(d.increased.map((x) => x.sku), ["2"]);
  assert.deepEqual(d.removed.map((x) => x.sku), ["3"]);
  assert.deepEqual(d.added.map((x) => x.sku), ["4"]);
});

test("a refused timeslot is a failure even when the HTTP call succeeded", () => {
  assert.equal(slotOutcomeOf({ isError: false, text: "", json: { IsReserved: true } }, 5).isError, false);
  assert.equal(slotOutcomeOf({ isError: false, text: "", json: { IsReserved: false, ProductLineDiffs: [1] } }, 5).isError, true);
  assert.equal(slotOutcomeOf({ isError: false, text: "" }, 5).isError, false, "no flag is not a refusal");
  assert.equal(slotOutcomeOf({ isError: true, text: "boom" }, 5).isError, true);
});

test("the card body sends selected products and no default product list", () => {
  const payload = cardPayload({ guid: "recipe-guid" }, 5, [{
    ProductSelectionId: "11111111-1111-1111-1111-111111111111",
    ProductSelectionName: "Spaghetti",
    ProductId: "7001",
    Quantity: 2,
  }]);
  assert.deepEqual(payload, {
    RecipeId: "recipe-guid",
    NumberOfPeople: 5,
    Sorting: "priceasc",
    SelectedProducts: [{
      ProductSelectionId: "11111111-1111-1111-1111-111111111111",
      ProductSelectionName: "Spaghetti",
      ProductId: "7001",
      Quantity: 2,
    }],
    SoldOutProducts: [],
    SupplementProducts: [],
    IsNem3: false,
  });
});

// --- similarity.mjs: the same dinner in another wrapper ---------------------------
import { conflicts, mainProtein, dishFormat } from "../similarity.mjs";

test("spaghetti bolognese and spaghetti with meatballs are the same dinner", () => {
  assert.equal(conflicts({ name: "Klassisk spaghetti bolognese" }, { name: "Spaghetti med kødboller i tomatsauce" }), true);
});

test("chili con carne and tortillas are two different dinners", () => {
  const a = { name: "Chili con carne", ingredients: [{ text: "Oksekød" }, { text: "Bønner" }] };
  const b = { name: "Tortillas med oksekød", ingredients: [{ text: "Tortillas" }, { text: "Oksekød" }] };
  assert.equal(conflicts(a, b), false);
});

test("two chicken pasta salads are the same dinner", () => {
  assert.equal(conflicts(
    { name: "Nem pastasalat med kylling og pesto" },
    { name: "Pastasalat med kylling og karrydressing" }), true);
});

test("the protein comes from the name, not from one garnish line", () => {
  assert.equal(mainProtein({ name: "Nudler med kylling og broccoli", ingredients: [{ text: "Vannamei rejer" }] }), "kylling");
  assert.equal(mainProtein({ name: "Bami goreng med okse", ingredients: [{ text: "Kyllingestrimler" }] }), "oksekod");
  assert.equal(mainProtein({ name: "Salatpizza med kebab og dressing", url: "/opskrifter/salatpizza-kyllingekebab-98004472" }), "kylling");
  assert.equal(mainProtein({ name: "Forårsrulle", ingredients: [{ text: "Forårsløg" }] }), "vegetar",
    "a spring onion is not a spring chicken");
  assert.equal(dishFormat({ name: "Æggekage med spinat og laks" }), "aeg");
});

// --- family.mjs: one profile, the shapes the planner already speaks ----------------
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFamily, findProfileFile } from "../family.mjs";

// A profile of one's own is private and stays out of git, so these four cases read the
// committed fixture: same keys, same derived shapes, invented people, budget and aliases.
// Without it a clean clone cannot run its own suite.
const FIXTURE_PROFILES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "profiles");
const demoFamily = () => loadFamily({ dir: FIXTURE_PROFILES, name: "demo" });

test("the family profile carries the household essentials", () => {
  const fam = demoFamily();
  assert.equal(fam.name, "family-demo");
  assert.equal(fam.household.people, 3);
  assert.equal(fam.household.dinnersForPeople, 5);
  assert.equal(fam.household.daysCoveredByOneDinner, 2);
  assert.equal(fam.household.basketPolicy.neverClearBasket, true);
  assert.equal(fam.household.softCapKr, 900);
});

test("the family's fat band and ceiling sit on top of the generated meat rules", () => {
  const fam = demoFamily();
  const okse = fam.meat.rules.find((r) => r.id === "hakket-okse");
  assert.equal(okse.maxKrPerKg, 99, "the profile's ceiling wins over the mined one");
  assert.ok(fam.meat.rules.length >= 2);
  assert.ok(fam.meat.rules.every((r) => r.query), "every rule still names a query");
});

test("the three recipe filters come from the profile", () => {
  const fam = demoFamily();
  assert.ok(fam.exclusions.freshHerbs.words.includes("persille"));
  assert.ok(fam.exclusions.pantryWords.words.includes("olie"));
  assert.ok(fam.exclusions.neverBought.words.includes("kapers"));
  assert.equal(fam.exclusions.queryAliases.words.parmesan, "Ost E");
});

test("a profile that does not exist is refused by name", () => {
  assert.throws(() => findProfileFile(FIXTURE_PROFILES, "does-not-exist"), /not found/);
});

// --- the piece and the folded word: two real plan bugs ----------------------------
test("eight eggs out of a ten-pack is one pack, not eight", () => {
  assert.equal(packsFor({ qty: 8, unit: "stk" }, { qty: 10, unit: "stk" }), 1);
  assert.equal(packsFor({ qty: 12, unit: "stk" }, { qty: 10, unit: "stk" }), 2);
  assert.equal(packsFor({ qty: 2, unit: "stk" }, { qty: 1, unit: "stk" }), 2);
  assert.equal(packsFor({ qty: 2, unit: "stk" }, { qty: null, unit: null }), 2);
});

test("a size word in front of the product does not hide it: baby salatmix is salatmix", () => {
  assert.equal(score("Salatmix", "Baby salatmix øko."), 1);
});

test("four folded letters still find the compound: milk finds a compound milk", () => {
  assert.ok(score("Mælk", "Skummetmælk 1,5%") > 0);
  assert.ok(score("Mælk", "Letmælk 1,5%") > 0);
  assert.equal(score("Agurk", "Agurkesalat"), 0);
});

test("a single-night format covers one day and the period is still filled", () => {
  const pool = [{ url: "/p", name: "Pizza med kebab", protein: "oksekod", format: "pizza", score: 9 },
    { url: "/a", name: "Kylling med ris", protein: "kylling", format: "ris", score: 8 },
    { url: "/b", name: "Torsk med kartofler", protein: "fisk", format: "kartoffel", score: 7 },
    { url: "/c", name: "Pølser med kartofler", protein: "svinepolse", format: "kartoffel", score: 6 }];
  const r = chooseDinners(pool, { days: 4, coversDays: 2, lastUsed: {}, singleNight: ["pizza"], minFish: 0 });
  const pizza = r.menu.find((m) => m.format === "pizza");
  assert.equal(pizza.covers, 1);
  assert.equal(pizza.days, "1-1");
  assert.ok(r.coveredDays >= 4);
});

test("an out-of-stock protein has more than one name to fall back on", () => {
  // The fixture, not a real profile: a clone carries none, so this threw there.
  const fam = demoFamily();
  // Mined rules only. A family rule may stop at one fallback on purpose: when the second
  // name would be a grade the family refused, the honest outcome is a line the person sees,
  // not a product the profile said never.
  const swappable = fam.meat.rules.filter((r) => !r.family && r.alt.length > 0);
  assert.ok(swappable.length >= 2, "a profile with no alternatives cannot swap a sold-out protein");
  assert.ok(swappable.every((r) => r.alt.length >= 2), `${fam.name} names one fallback at most somewhere`);
  assert.ok(fam.meat.rules.some((r) => r.family && r.alt.length === 1), "a family rule is allowed to stop at one");
});

// --- measures, not pack counts: 1 pære is not a 1 kg bag --------------------------
test("a need that counts pieces meets the pack's weight", () => {
  const oneKg = { qty: 1000, unit: "g", raw: "1 kg" };
  assert.equal(packsFor({ qty: 8, unit: "stk" }, oneKg, { name: "Pærer Conference" }), 2);
  assert.equal(packsFor({ qty: 1, unit: "stk" }, oneKg, { name: "Pærer Conference" }), 1);
  assert.equal(packsFor({ qty: 4, unit: "stk" }, { qty: 1, unit: "stk" }, { name: "Æble Royal Gala" }), 4);
  assert.equal(pieceGrams("Pærer Conference"), 190);
  assert.equal(pieceGrams("Mælk"), null);
});

// --- nights.mjs: a dinner runs as long as it keeps --------------------------------
import { nightsOf, reheatOf, portionsPerNight, coverEvenings } from "../nights.mjs";

const members = [{ role: "adult", count: 2, appetite: 1 }, { role: "child", count: 1, appetite: 0.6 }];

test("a stew runs two nights, a pizza one", () => {
  assert.equal(nightsOf({ name: "Kødboller i karry", format: "gryde" }, { maxNights: 2 }), 2);
  assert.equal(nightsOf({ name: "Pizza med kebab", format: "pizza" }, { maxNights: 2 }), 1);
  assert.equal(reheatOf({ name: "Tortellini suppe", format: "suppe" }), "great");
});

test("one recipe can break the rule without touching code", () => {
  const opts = { maxNights: 2, overrides: { "/opskrifter/x": 1 } };
  assert.equal(nightsOf({ url: "/opskrifter/x", name: "Karry", format: "gryde" }, opts), 1);
});

test("portions come from appetites: 2 adults and a small child cook 5 portions for 2 nights", () => {
  assert.equal(portionsPerNight(members), 2.6);
  assert.equal(Math.round(portionsPerNight(members) * 2), 5);
});

test("8 evenings is 4 dinners when they keep, and 5 when one is fresh", () => {
  const good = [1, 2, 3, 4].map((i) => ({ name: "g" + i, format: "gryde" }));
  assert.equal(coverEvenings(good, { maxNights: 2 }).covered, 8);
  const mixed = [...good.slice(0, 3), { name: "pizza", format: "pizza" }];
  assert.equal(coverEvenings(mixed, { maxNights: 2 }).covered, 7);
});

// --- the purchase decision: cover the need for the lowest total price ---

const EGGS = { name: "Æg str. M/L øko.", price: 41.95, pack: { qty: 10, unit: "stk" } };
const EGGS15 = { name: "Æg str. L øko.", price: 54.95, pack: { qty: 15, unit: "stk" } };
const SALMON200 = { name: "Røget laks", price: 40, pack: { qty: 200, unit: "g" } };
const SALMON1KG = { name: "Røget laks, stor", price: 120, pack: { qty: 1, unit: "kg" } };
const BUY = { name: "Æg", overshootPctFresh: 25, overshootPctStable: 400, tieBreakKr: 3, maxOverrunFreshMl: 150, stableWords: ["æg"] };

test("two recipes needing 4 eggs each buy one pack of 10, not two", () => {
  const b = choosePack({ qty: 8, unit: "stk" }, [EGGS, EGGS15], BUY);
  assert.equal(b.packs, 1);
  assert.equal(b.candidate.pack.qty, 10);
});

test("12 eggs take the 15-pack because it costs less in total", () => {
  const b = choosePack({ qty: 12, unit: "stk" }, [EGGS, EGGS15], BUY);
  assert.equal(b.candidate.pack.qty, 15);
  assert.equal(b.packs, 1);
  assert.equal(b.total, 54.95);
  assert.match(b.why, /15 stk for 12 stk/);
});

test("a better price per egg never costs more kroner", () => {
  // 4 eggs: the 15-pack is the cheaper per egg but dearer overall, so it is refused.
  const cheapPerEgg = { name: "Æg str. L", price: 44.95, pack: { qty: 15, unit: "stk" } };
  const b = choosePack({ qty: 4, unit: "stk" }, [EGGS, cheapPerEgg], BUY);
  assert.equal(b.candidate.pack.qty, 10);
});

test("fresh fish does not overrun the need for a saving on paper", () => {
  const b = choosePack({ qty: 300, unit: "g" }, [SALMON200, SALMON1KG], { ...BUY, name: "Røget laks", stableWords: [] });
  assert.equal(b.candidate.pack.qty, 200);
  assert.equal(b.packs, 2);
  assert.equal(b.total, 80);
});

test("two dinners asking for the same product become one need", () => {
  const { intents, collapsed } = consolidateIntents([
    { source: "dinner:1", query: "Æg", need: "4 stk", rationale: "2 nights" },
    { source: "dinner:2", query: "æg", need: "4 stk" },
  ]);
  assert.equal(collapsed, 1);
  assert.equal(intents.length, 1);
  assert.equal(intents[0].need, "8 stk");
  assert.match(intents[0].rationale, /8 stk in total from 2 lines/);
  assert.match(intents[0].rationale, /dinner:2/);
});

test("grams and pieces are not added together, and a pinned sku is left alone", () => {
  const { intents, collapsed } = consolidateIntents([
    { source: "a", query: "Mel", need: "500 g" },
    { source: "b", query: "Mel", need: "2 stk" },
    { source: "c", query: "Skrabeæg", need: "6 stk", sku: "12345" },
  ]);
  assert.equal(collapsed, 0);
  assert.equal(intents.length, 3);
});

test("a need that counts packs never buys the catering size", () => {
  const butter = { name: "Smør (saltet)", price: 7.96, pack: { qty: 200, unit: "g" }, onSale: false };
  const tub = { name: "Kuvertsmør (saltet)", price: 154.95, pack: { qty: 100, unit: "stk" }, onSale: true };
  const b = choosePack({ qty: 1, unit: "stk" }, [tub, butter], { name: "Smør", ...BUY, stableWords: [] });
  assert.equal(b.candidate.name, "Smør (saltet)");
  assert.equal(b.total, 7.96);
});

test("salted butter is fresh, bouillon keeps", () => {
  const buy = { ...BUY, stableWords: ["æg", "bouillon", "mel"], freshWords: ["smør", "mælk"] };
  const butterBig = { name: "Smør (saltet)", price: 60, pack: { qty: 2, unit: "kg" } };
  const butterSmall = { name: "Smør (saltet)", price: 70, pack: { qty: 3, unit: "kg" } };
  assert.equal(choosePack({ qty: 1, unit: "kg" }, [butterBig, butterSmall], { name: "Smør (saltet)", ...buy }).packs, 1);
  const bouillonSmall = { name: "Grøntsagsbouillon", price: 20, pack: { qty: 50, unit: "g" } };
  const bouillonBig = { name: "Grøntsagsbouillon", price: 30, pack: { qty: 130, unit: "g" } };
  const b = choosePack({ qty: 60, unit: "g" }, [bouillonSmall, bouillonBig], { name: "Grøntsagsbouillon", ...buy });
  assert.equal(b.candidate.pack.qty, 130);
});

test("a counted pack is still an option when the need weighs", () => {
  // The family buys round pizza bases sold as "2 stk"; frozen 230 g bases are dearer
  // per kg only in total, and must not win because the units are hard to compare.
  const roundBase = { name: "Pizzabund Ø 32 cm", price: 38.51, pack: { qty: 2, unit: "stk" } };
  const frozen = { name: "Pizzabund bianca", price: 36, pack: { qty: 230, unit: "g" } };
  const b = choosePack({ qty: 600, unit: "g" }, [frozen, roundBase], { name: "Pizzabund", ...BUY, stableWords: [] });
  assert.equal(b.candidate.name, "Pizzabund Ø 32 cm");
  assert.equal(b.total, 38.51);
});

test("a small extra of a fresh thing is not waste", () => {
  const small = { name: "Karry (madras) øko.", price: 17.17, pack: { qty: 50, unit: "g" } };
  const big = { name: "Karry (madras) øko.", price: 5.95, pack: { qty: 90, unit: "g" } };
  const b = choosePack({ qty: 50, unit: "g" }, [small, big], { name: "Karry", ...BUY, stableWords: [], maxOverrunFreshMl: 150 });
  assert.equal(b.candidate.pack.qty, 90);
  assert.equal(b.total, 5.95);
});

// --- the feedback loop: plan vs the baskets that followed it ---

const PLANNED = [
  { sku: "1", name: "Oliveolie extra virgin", qty: 1 },
  { sku: "2", name: "Skyr natural", qty: 2 },
  { sku: "3", name: "Grød havregryn", qty: 1 },
];
const PLAN_1 = { at: "2026-01-01", menu: ["/opskrifter/a"], items: PLANNED };
const PLAN_2 = { at: "2026-01-12", menu: ["/opskrifter/a"], items: PLANNED };
const BASKETS = [
  { at: "2026-01-03", orderId: "A1", lines: [{ sku: "2", name: "Skyr natural", qty: 3 }, { sku: "9", name: "Rugbrød groft", qty: 1 }] },
  { at: "2026-01-08", orderId: "A2", lines: [{ sku: "1", name: "Oliveolie extra virgin", qty: 1 }] },
  { at: "2026-01-14", orderId: "B1", lines: [{ sku: "2", name: "Skyr natural", qty: 3 }, { sku: "9", name: "Rugbrød groft", qty: 1 }] },
];

test("a plan is compared with every basket in its period, not just the first", () => {
  const pairs = pairPlanToOrder([PLAN_1, PLAN_2], BASKETS, { maxGapDays: 21 });
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[0].orders.map((o) => o.orderId), ["A1", "A2"]);
  assert.deepEqual(pairs[1].orders.map((o) => o.orderId), ["B1"]);
  const d = observedDelta(PLAN_1, pairs[0].orders);
  assert.deepEqual(d.removed.map((r) => r.sku), ["3"]);
  assert.deepEqual(d.added.map((a) => a.sku), ["9"]);
});

test("what the family repeats becomes learned, what only once does not", () => {
  const learned = learnedFrom(pairPlanToOrder([PLAN_1, PLAN_2], BASKETS), { minObservations: 2, maxQuantityFactor: 2 });
  assert.deepEqual(learned.avoid.map((a) => a.word), ["grød"], "the oil bought late in period 1 is not a rejection");
  assert.deepEqual(learned.add.map((a) => a.word), ["rugbrød"]);
  const skyr = learned.quantityBias.find((q) => q.word === "skyr");
  assert.ok(skyr, "skyr correction expected: " + JSON.stringify(learned.quantityBias));
  assert.equal(skyr.factor, 1.5);
});

test("the learned multiplier scales the need and says so", () => {
  const { intent, changed } = biasIntent({ query: "Skyr natural", need: "2 stk", rationale: "recipe" }, [{ word: "skyr", factor: 1.5 }]);
  assert.equal(changed, true);
  assert.equal(intent.need, "3 stk");
  assert.match(intent.rationale, /buys 1.5x/);
  assert.equal(biasIntent({ query: "Bananer", need: "1 stk" }, [{ word: "skyr", factor: 1.5 }]).changed, false);
});

// --- the milk ratchet: agreed baskets hold the learned quantity down ---

const MILK = [{ sku: "5", name: "Letmælk 1500 ml", qty: 2 }];
const milkPlans = ["2026-02-01", "2026-02-12", "2026-02-23", "2026-03-06"]
  .map((at) => ({ at, menu: ["/opskrifter/a"], items: MILK }));
const milkBaskets = (qtys) => qtys.map((q, i) =>
  ({ at: ["2026-02-03", "2026-02-14", "2026-02-25", "2026-03-08"][i], orderId: `M${i}`, lines: [{ sku: "5", name: "Letmælk 1500 ml", qty: q }] }));
const milkLearned = (qtys) => learnedFrom(pairPlanToOrder(milkPlans, milkBaskets(qtys)), { minObservations: 2, maxQuantityFactor: 2 });
const milkBias = (learned) => learned.quantityBias.find((q) => q.word === "letmælk");

test("two big baskets out of four never raise the weekly milk line", () => {
  assert.ok(!milkBias(milkLearned([3, 3, 2, 2])),
    "agreed baskets must outvote the two extras: " + JSON.stringify(milkLearned([3, 3, 2, 2]).quantityBias));
});

test("buying more in every basket still teaches the planner", () => {
  const milk = milkBias(milkLearned([3, 3, 3, 3]));
  assert.ok(milk && milk.factor === 1.5, "consistent extra buying must show up: " + JSON.stringify(milk));
  assert.match(milk.evidence, /4 baskets, 4 of them differed/);
});

test("buying less in every basket lowers the line", () => {
  const milk = milkBias(milkLearned([1, 1, 1, 1]));
  assert.ok(milk && milk.factor === 0.5, "a smaller habit must lower the need: " + JSON.stringify(milk));
});

test("one small basket among agreed ones changes nothing", () => {
  assert.ok(!milkBias(milkLearned([1, 2, 2, 2])),
    "the plan must not shrink on a single light basket: " + JSON.stringify(milkLearned([1, 2, 2, 2]).quantityBias));
});

test("two pack sizes of one product vote once per basket", () => {
  const plans = ["2026-02-01", "2026-02-12"].map((at) => ({
    at, menu: ["/opskrifter/a"],
    items: [{ sku: "5", name: "Letmælk 1500 ml", qty: 1 }, { sku: "6", name: "Letmælk 800 ml", qty: 1 }],
  }));
  const orders = ["2026-02-03", "2026-02-14"].map((at, i) => ({
    at, orderId: `D${i}`,
    lines: [{ sku: "5", name: "Letmælk 1500 ml", qty: 1 }, { sku: "6", name: "Letmælk 800 ml", qty: 2 }],
  }));
  const milk = learnedFrom(pairPlanToOrder(plans, orders)).quantityBias.find((q) => q.word === "letmælk");
  assert.ok(milk && milk.factor === 1.5 && milk.seen === 2, "sum per word, one vote per basket: " + JSON.stringify(milk));
});

test("a family add-on becomes an intent over the period", () => {
  const adds = addIntentsOf([{ query: "Rugbrød groft", medianQty: 1, times: 3, evidence: "you added it in 3 of 4 baskets" }], { gapDays: 9, days: 8 });
  assert.equal(adds.length, 1);
  assert.equal(adds[0].source, "learned:add");
  assert.equal(adds[0].need, "1 stk");
  assert.match(adds[0].note, /added it in 3/);
});

test("a refused dish never comes back and a rested one waits its turn", () => {
  const pool = [
    { url: "/a", name: "Ret A", protein: "okse", format: "gryde", minutes: 30 },
    { url: "/b", name: "Ret B", protein: "kylling", format: "fad", minutes: 30 },
    { url: "/c", name: "Ret C", protein: "svin", format: "pasta", minutes: 30 },
  ];
  const recent = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  const pick = chooseDinners(pool, {
    days: 4, coversDays: 2, lastUsed: { "/a": "2026-01-01", "/b": "2026-01-02" },
    taste: { liked: [], refused: ["/b"] },
    cookedTimes: { "/a": { last: recent(1)[0], dates: recent(3), times: 3 } },
    exploration: { cooldownTimes: 3, cooldownDays: 42 },
  });
  const urls = pick.chosen.map((c) => c.url);
  assert.ok(!urls.includes("/b"), "refused dish must not be chosen: " + urls.join(","));
  assert.deepEqual(urls, ["/c", "/a"]);
});

// --- one pot, sized by who eats it -----------------------------------------------
// The ask for a dinner is portions a night times the nights the dish runs; the number it
// is divided by is the pot the mined amounts were already scaled to,
// household.cookServings in profiles/amounts.json. Both sides of that division used to
// carry the household's own appetite, so appetite cancelled out and every family bought
// the identical pot whatever it ate.
const curry = { name: "Kylling curry", slug: "kylling-curry", servings: 4,
  ingredients: [{ text: "Kyllingekød", amount: 400, unit: "g", grams: 400, litres: null }] };
const noFilters = { pantryWords: { words: [] }, freshHerbs: { words: [] },
  neverBought: { words: [] }, queryAsides: { words: [] } };
// 400 g over the recipe's 4 servings is 100 g a portion, so the expectations below are
// exact and carry no rounding argument. A need is rounded UP to the nearest 50 g below a
// kilo and to the nearest 250 g above it (dinners.mjs:109), which the second case pins.
const potFor = (portions, standardPortions) => recipeIntents(curry, {
  amounts: { household: { cookServings: 5 } }, meat: { rules: [] }, exclusions: noFilters,
  portions, standardPortions,
}).intents[0].need;

test("the pot a dinner buys follows the appetites that eat it", () => {
  assert.equal(potFor(4, 5), "400 g", "a four-portion ask buys what the recipe states");
  assert.equal(potFor(8, 5), "800 g", "double the eaters, double the chicken");
  assert.equal(potFor(2, 5), "200 g", "half the eaters, half the chicken");
});

test("a need is rounded up to a weight a shopper can read", () => {
  // 1.25 (4 servings to the 5-serving pot) x 1.36 (5 portions to 6.8) x 400 g = 680 g.
  assert.equal(potFor(6.8, 5), "700 g", "680 g rounds up to the nearest 50 g below a kilo");
  // 1.25 x 1.6 x 400 = 800 g exactly, so this line proves the 250 g step is not a fudge
  // factor: an exact number stays exact.
  assert.equal(potFor(8, 5), "800 g", "an exact figure is left alone");
});

// --- who a pantry block is bought for --------------------------------------------
import { blockPeopleOf } from "../family.mjs";

test("a block's head-count comes from the members and can be overridden", () => {
  const twoAdultsOneChild = { dinners: { members: [{ role: "adult", count: 2, appetite: 1 }, { role: "child", count: 1, appetite: 0.6 }] } };
  const derived = blockPeopleOf(twoAdultsOneChild, { people: 5 }).people;
  assert.deepEqual(derived, { breakfast: 3, kidLunchbox: 1, snacks: 1, household: 1 });
  // A family where the grown-ups take a lunch box too says so; the planner cannot guess it.
  const adultsToo = blockPeopleOf({ ...twoAdultsOneChild, household: { blockPeople: { kidLunchbox: 3 } } }, { people: 5 });
  assert.equal(adultsToo.people.kidLunchbox, 3, "the profile wins");
  assert.deepEqual(adultsToo.fromOverride, ["kidLunchbox"], "and the plan says which block was overridden");
  // A family with no children buys no child lines, rather than one set by habit.
  const noChildren = blockPeopleOf({ dinners: { members: [{ role: "adult", count: 2, appetite: 1 }] } }, { people: 2 });
  assert.equal(noChildren.people.kidLunchbox, 0, "nobody to pack for");
  assert.equal(noChildren.people.breakfast, 2, "but breakfast is still for everyone");
});

// --- what one piece of a pack weighs, from the shop's own declaration ---------

const declared = (description, name) => ({ name, description, pack: parsePack(description) });

test("pieceWeightOf: the pack the shop describes beats the word table", () => {
  assert.equal(pieceWeightOf(declared("4 x 125 g / Taste of Nature", "Parboiled ris i kogepose")), 125);
  assert.equal(pieceWeightOf(declared("24 x 0,33 l / ex. pant / Coca-Cola", "Coca-Cola Zero (dåse)")), 330);
  assert.equal(pieceWeightOf(declared("2 stk. / 260 g / Santa Maria", "Naanbrød m. hvidløg")), 130);
  assert.equal(pieceWeightOf(declared("350 g / frost / 2 stk.", "Hvidløgsbaguettes")), 175);
  assert.equal(pieceWeightOf(declared("180 g / 10 skiver / Arla", "Ost skåret")), 18);
});

test("pieceWeightOf: no claim, no number - and no absurd number either", () => {
  assert.equal(pieceWeightOf(declared("375 g / Nestlé", "Cheerios m. fuldkorn")), null, "a cereal pack claims no pieces");
  assert.equal(pieceWeightOf(declared("900 stk. / 300 g", "Uden Navn")), null, "a third of a gram per piece is a parsing mistake, not a weight");
  assert.equal(pieceWeightOf(declared("", "Pærer Conference")), 190, "the word table stays the fallback, and it is a guess");
  assert.equal(pieceWeightOf(declared("15 stk. / Danæg", "Skrabeæg str. M/L")), 65, "15 eggs declare no weight, so the table speaks");
});

test("choosePack measures a candidate with its own piece weight, on both sides", () => {
  // 3 pears wanted. One pack is "4 stk. / 500 g" - the shop says a pear there is 125 g, so
  // the need is 375 g and the pack covers it. The other is a 1 kg bag, which says nothing
  // about pieces and is therefore still guessed at 190 g per pear: 570 g wanted, 1000 g
  // sold, a 75 % overrun on fresh fruit. The small pack wins although it costs more.
  const pears = { qty: 3, unit: "stk" };
  const small = { id: "5012274", name: "Pærer Conference øko.", price: 30, unitPrice: 60, unitLabel: "kr/kg",
    pack: parsePack("4 stk. / 500 g"), description: "4 stk. / 500 g" };
  const big = { id: "5001423", name: "Pære Conference", price: 23, unitPrice: 23, unitLabel: "kr/kg",
    pack: parsePack("1 kg"), description: "1 kg" };
  const chosen = choosePack(pears, [big, small], { name: "Pære Conference", overshootPctFresh: 25, maxOverrunFreshMl: 150, tieBreakKr: 3 });
  assert.equal(chosen.candidate.id, "5012274");
  assert.equal(chosen.packs, 1);
});

// --- the sale rule, measured against the sku the family actually buys ---------

const usual = (over = {}) => ({ id: "605008", name: "Mayonnaise (let)", brand: "K-Salat", price: 26.25,
  pack: parsePack("375 g"), description: "375 g", onSale: false, ...over });
const tilbud = (over = {}) => ({ sku: "605009", name: "Mayonnaise (let)", brand: "First Price", price: 12.12,
  pack: parsePack("400 g"), description: "400 g", onSale: true, ...over });

test("saleBeatsPin: a tilbud beats the usual sku when it is cheaper for the same need", () => {
  const won = saleBeatsPin("Mayonnaise (let)", usual(), 1, [tilbud()], null, {});
  assert.equal(won.rival.sku, "605009");
  assert.equal(won.packs, 1);
  assert.equal(won.total, 12.12);
  assert.equal(won.savedKr, 14.13);
});

test("saleBeatsPin: four refusals", () => {
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual(), 1, [tilbud({ name: "Mayonnaise" })], null, {}), null,
    "a plain mayonnaise is not the light one, however cheap - it drops a word the family typed");
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual({ onSale: true }), 1, [tilbud()], null, {}), null,
    "the usual sku is already today's deal");
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual(), 1, [tilbud()], null, { preferSale: false }), null,
    "basket.preferSale off means the habit is not traded");
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual(), 1, [tilbud({ price: 30 })], null, {}), null,
    "a tilbud that costs more for what the plan asked for is not a saving");
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual(), 1, [tilbud()], null, { purchasing: { swapNeverWords: ["mayonnaise"] } }), null,
    "budget.swapNeverWords protects a line from a discount too");
  assert.equal(saleBeatsPin("Mayonnaise (let)", usual(), 1, [], null, {}), null, "no rival, no decision");
});

// The shop states more about a product than its name: the brand and the shelf category it
// stands in. Those words are the shop's own claim, so they may stand in for the two-way
// head-noun check - which is how a brand-first name ("Polskey Vodka") and a category word
// ("hård ost" over the shelf's own "Specialost, hård") reach the price rule at all.
// Measured 2026-11-13 over a cached shelf of 191 queries: 109 candidates came in, none went
// out, and the cheapest accepted candidate became cheaper on 42 of the queries.
const VODKA_SHELF = "Vin og spiritus Vodka";

test("the shelf's own words answer for the head noun", () => {
  const polskey = "Polskey Vodka (37,5%)";
  assert.equal(score("vodka", polskey), 0, "name alone: the first word is not vodka, so the rule refuses it");
  assert.equal(score("vodka", polskey, [], VODKA_SHELF), 1, "the shelf calls this product vodka, so it is vodka");
  assert.equal(score("vodka", "Absolut vodka (40%)", [], "Absolut Vin og spiritus Vodka"), 1,
    "a brand in front of the product word is the same case");
  assert.equal(score("færdig pizzadej", "Pizzadej m. fuldkorn", [], "Køl Fersk Dej"), 1,
    "a shopper writes 'færdig', no producer prints it, so it is not asked for");
  // "hård ost" is NOT carried by the words alone: "ost" is three letters, below the four
  // the compound suffix rule needs, so it stays at half the query and is refused. A family
  // settles that one in data - their profile maps the words onto the cheese they buy - and
  // the matcher stays what it is: a reader of names, not of tastes.
  assert.equal(score("hård ost", "Emmentaler i blok", [], "Mejeri Specialost, hård (parmesan, pecorino, osv.)"), 0.5,
    "the category word alone does not reach the threshold, so the family's own alias decides");
});

test("the shelf's words never loosen the checks that guard a different product", () => {
  assert.equal(score("jordbær", "Yoghurt m. jordbær 3,1%", [], "First Price Mejeri Yoghurt"), 0,
    "strawberry is the flavour of a yoghurt, and the category says so");
  assert.equal(score("porrer", "Fransk tærte m. laks/porrer", [], "Køl Tærter"), 0,
    "a word behind 'm.' inside a ready dish is not the ingredient");
  assert.equal(score("hakket oksekød", "Oksekød udskåret", [], "Kød Oksekød"), 0,
    "'hakket' is not a word we drop: the shelf prints it, and a steak is not mince");
  assert.equal(score("asparges (hvide)", "Aspargessnitter (fine)", [], "Paradiso Tørvarer Asparges"), 0.5,
    "the recipe asked for white asparagus: canned pieces answer one of the two words");
  assert.equal(score("asparges", "Aspargessnitter (fine)", [], "Paradiso Tørvarer Asparges"), 1,
    "a query that only says asparagus does accept the pieces - the price rule then compares them");
  assert.equal(nameMatches("agurk", "Agurkesalat", 0.7, [], "Køl Salater"), true === false,
    "a prepared salad is still not a cucumber, category or not");
  assert.equal(shelfContext({ brand: "", mainGroup: "Mejeri", subGroup: "Skyr" }), "Mejeri Skyr",
    "an empty brand contributes no word");
});

// A recipe counts PARTS of the unit the shop sells, and the shop prices some goods by the
// piece and others by the kilo. Both cases used to end in the same wrong place: "6 fed" was
// answered with 6 packs, and a per-piece product never met a per-kilo one because the
// comparison kept only the biggest price axis. Measured 2026-11-13 on a pinned 4-dinner menu:
// the same basket, 1154,53 kr before and 1105,25 kr after, on five lines that moved.
const NET = { id: "a1", name: "Hvidløg i net", price: 13.33, unitPrice: 66.65, unitLabel: "kr/kg",
  availability: { IsDeliveryAvailable: true, IsAvailableInStock: true }, pack: { qty: 200, unit: "g", raw: "200 g" } };
const HEAD = { id: "a2", name: "Hvidløg øko.", price: 4, unitPrice: 4, unitLabel: "kr/stk",
  availability: { IsDeliveryAvailable: true, IsAvailableInStock: true }, pack: { qty: 1, unit: "stk", raw: "1 stk." } };

test("a recipe's part is weighed, not counted as packs", () => {
  assert.equal(subunitGrams("fed"), 5, "a garlic clove");
  assert.equal(subunitGrams("skiver"), 25, "a slice, in whatever plural the recipe wrote");
  assert.equal(subunitGrams("stk"), null, "a pack is not a part - that stays a count");
  assert.equal(subunitGrams("fed", { fed: 8 }), 8, "a family that reads a clove heavier says so in purchasing.pieceWeights");
  assert.ok(Object.keys(SUBUNIT_GRAMS).length <= 20, "the built-in part table stays small and every entry defensible");
});

test("a 4 kr head meets a 13,33 kr net bag: the whole shelf is compared", () => {
  const OIL = { id: "a3", name: "Hvidløg i krydderolie", price: 17.8, unitPrice: 98.89, unitLabel: "kr/kg",
    availability: { IsDeliveryAvailable: true, IsAvailableInStock: true }, pack: { qty: 290, unit: "g", raw: "290 g" } };
  const shelf = [NET, OIL, HEAD];
  const cheap = cheapest(shelf, {});
  assert.equal(cheap.poolSize, 2, "the price-axis group is the two products listed per kilo, so the head is not in it");
  assert.equal(cheap.pool.some((c) => c.id === HEAD.id), false, "the head cannot be compared per unit - it is priced per piece");
  assert.equal(cheap.shelf.length, 3, "`shelf` keeps all three, because the decision is a total, not a unit price");
  const bought = choosePack({ qty: 50, unit: "g" }, cheap.shelf, { name: NET.name });
  assert.equal(bought.candidate.name, HEAD.name, "what the plan asked for costs 4 kr in one head, 13,33 kr in a net bag, 17,80 in oil");
  assert.equal(bought.packs, 1);
  assert.equal(bought.total, 4);
  const counted = choosePack({ qty: 3, unit: "stk" }, cheap.shelf, { name: NET.name, pieceGrams: pieceGrams("hvidløg") });
  assert.equal(counted.candidate.name, HEAD.name, "three of them, counted, is three heads - not three net bags");
});

test("a recipe counting parts asks for a weight, not that many packs", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 5, ingredients: [
    { text: "Hvidløg", amount: "6", unit: "fed" },
    { text: "Løg", amount: "2", unit: "stk" },
  ] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions });
  const garlic = out.intents.find((i) => i.query === "Hvidløg");
  const onion = out.intents.find((i) => i.query === "Løg");
  assert.equal(garlic.need, "50 g", "6 cloves at 5 g, rounded up on the step the planner weighs in");
  assert.match(garlic.rationale, /6 fed/, "the plan still shows the part the recipe wrote");
  assert.equal(onion.need, "2 stk", "a count of sold units stays a count: '2 stk' is two of what the shop sells");
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// A family rule is the profile's own product rule: this family buys a certain grade, or a
// certain format, whatever the shelf discounts. The words live in the profile; the code only
// carries the mechanism, so a second family changes JSON and never a .mjs file.
const creamRule = {
  id: "madlavningsfloede-4pct", family: true, match: ["fløde"], except: ["piskefløde"],
  query: "Madlavningsfløde 4%", alt: [], avoid: ["15%"], maxKrPerKg: null,
};

test("a family rule searches what the family buys and says so on the line", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 5, ingredients: [
    { text: "Fløde", amount: "200", unit: "ml", litres: 0.2 },
    { text: "Piskefløde", amount: "100", unit: "ml", litres: 0.1 },
  ] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [creamRule] }, exclusions });
  const cook = out.intents.find((i) => i.ingredient === "Fløde");
  const whip = out.intents.find((i) => i.ingredient === "Piskefløde");
  assert.equal(cook.query, "Madlavningsfløde 4%", "the family's own text is searched, not the recipe's word");
  assert.deepEqual(cook.avoidWords, ["15%"], "the grades this family will not have are kept out of the buy");
  assert.match(cook.rationale, /family rule "madlavningsfloede-4pct", buy "Madlavningsfløde 4%"/, "the line says which family rule chose it");
  assert.notEqual(cook.rationale, whip.rationale, "the two cream lines are not told apart by the same sentence");
});

test("a rule's own word does not reach a line where it means something else", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 5, ingredients: [{ text: "Piskefløde", amount: "100", unit: "ml", litres: 0.1 }] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [creamRule] }, exclusions });
  // "fløde" is inside "piskefløde", so a substring match would take the whipping cream line.
  assert.equal(out.intents[0].query, "Piskefløde", "except keeps the cooking-cream rule off the whipping cream");
  assert.doesNotMatch(out.intents[0].rationale, /family rule/);
});

test("a family rule is matched before a generated one and keeps its own shape", () => {
  const fam = demoFamily();
  const rules = fam.meat.rules;
  assert.equal(rules[0].id, "loeg-i-net", "the family's rule answers first");
  const onion = rules.find((r) => r.id === "loeg-i-net");
  assert.deepEqual(onion.match, ["løg"]);
  assert.deepEqual(onion.except, ["rødløg"], "the words that hold the rule back survive the load");
  assert.deepEqual(onion.avoid, ["sylte"], "and so do the products the family will not have");
  assert.deepEqual(onion.alt, ["Løg"], "one more search when the net is not offered");
  assert.equal(onion.maxKrPerKg, null, "no ceiling is invented for a rule that did not ask for one");
  assert.ok(rules.filter((r) => r.query).length === rules.length, "every rule still names a query");
});

test("a family rule that cannot be honoured fails when the profile is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "fp-rules-"));
  try {
    writeFileSync(join(dir, "family-bad.json"), JSON.stringify({
      name: "family-bad", purchasing: { rules: [{ match: ["fløde"] }] },
    }));
    assert.throws(() => loadFamily({ dir, name: "bad" }), /purchasing\.rules\[0\]\.id/);
    writeFileSync(join(dir, "family-bad.json"), JSON.stringify({
      name: "family-bad", purchasing: { rules: [{ id: "x", match: ["fløde"], query: "x".repeat(90) }] },
    }));
    assert.throws(() => loadFamily({ dir, name: "bad" }), /3-80 characters/);
    writeFileSync(join(dir, "family-bad.json"), JSON.stringify({
      name: "family-bad", purchasing: { rules: [{ id: "x", match: ["fløde"], query: "Fløde", maxKrPerKg: -5 }] },
    }));
    assert.throws(() => loadFamily({ dir, name: "bad" }), /maxKrPerKg/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The buy path is where a rule either lives or dies. plan.mjs builds the object it sends to
// the shop by hand, so a field left out of that one line silently makes every rule below it
// decorative: the plan still prints "never zittauer" while the basket fills with it.
test("what the plan loop asks the shop for keeps the rule's refusals", () => {
  const it = {
    query: "Ris", need: "500 g", mode: "cheapest", alt: ["Grødris"], rationale: "x",
    avoidWords: ["19-23%"], maxUnitPrice: 100, minPackGrams: 500,
  };
  const sent = searchIntentOf(it, { avoid: ["Grøn Fjer"], purchasing: { tieBreakKr: 3 }, fresh: false });
  assert.deepEqual(sent.avoidWords, ["19-23%", "Grøn Fjer"], "the rule's words and the CLI avoid list both reach the buy");
  assert.equal(sent.maxUnitPrice, 100, "and so must the ceiling they set per unit");
  assert.equal(sent.minPackGrams, 500, "and the smallest pack they buy of it");
  assert.deepEqual(sent.alt, ["Grødris"], "the alt chain travels too");
  assert.deepEqual(sent.avoidBrands, ["Grøn Fjer"], "--avoid still lands, as brands");
  assert.equal(sent.query, "Ris");
  assert.equal(searchIntentOf(it, {}).minPackGrams, 500, "no options needed to keep the rule");
});

test("a pack floor buys the net bag, not the piece that covers the need cheaper", () => {
  const CAN = { IsDeliveryAvailable: true, IsAvailableInStock: true };
  const PIECE = { id: "p1", name: "Løg i bakke", price: 5, unitPrice: 45.45, unitLabel: "kr/kg", availability: CAN, pack: { qty: 1, unit: "stk", raw: "1 stk" } };
  const NET = { id: "p2", name: "Løg Zittauer", price: 12, unitPrice: 12, unitLabel: "kr/kg", availability: CAN, pack: { qty: 1000, unit: "g", raw: "1 kg" } };
  const need = parseNeed("200 g");
  const loose = choosePack(need, [PIECE, NET], { name: "Løg", pieceWeight: 110 });
  assert.equal(loose.candidate.id, PIECE.id, "without a floor the total decides: 2 pieces at 10 kr against a 12 kr net");
  const floored = choosePack(need, [PIECE, NET], { name: "Løg", pieceWeight: 110, minPackGrams: 500 });
  assert.equal(floored.candidate.id, NET.id, "a 500 g floor buys the net at 12 kr, 800 g of it spare");
  assert.match(floored.why, /1 smaller pack\(s\) on this shelf were left out/, "and the line says what it left out");
  const alone = choosePack(need, [PIECE], { name: "Løg", pieceWeight: 110, minPackGrams: 500 });
  assert.equal(alone.candidate.id, PIECE.id, "a floor never turns a buy into a miss: no big pack here, so the pieces are bought");
});

test("a rule about the size of it keeps the recipe's own word as the search", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "T", servings: 5, ingredients: [{ text: "Løg", amount: "2", unit: "stk", grams: 200 }] };
  const sizeOnly = { id: "loeg-net", family: true, match: ["løg"], except: ["rødløg"], query: null, alt: [], avoid: [], maxKrPerKg: null, minPackGrams: 500 };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [sizeOnly] }, exclusions });
  assert.equal(out.intents[0].query, "Løg", "the word the recipe wrote is searched - a size rule has no product text to give");
  assert.equal(out.intents[0].minPackGrams, 500, "and the size still travels with the need");
  assert.match(out.intents[0].rationale, /family rule "loeg-net", 500 g or more a pack/, "the line says the size decided, with no product to name");
  const red = { name: "T", servings: 5, ingredients: [{ text: "Rødløg", amount: "1", unit: "stk", grams: 100 }] };
  const second = recipeIntents(red, { amounts, meat: { rules: [sizeOnly] }, exclusions });
  assert.equal(second.intents[0].minPackGrams, undefined, "excepted: a red onion is not bought by the net bag");
});

test("a favourite pinned on a refused brand is not bought, and the plan says why", async () => {
  // Measured on the live shelf on 2026-11-14: "--avoid First Price" emptied every rival of
  // that brand and then bought the pinned First Price yoghurt anyway, because the never-list
  // filtered the rivals and never looked at the pin.
  const CAN = { IsDeliveryAvailable: true, IsAvailableInStock: true };
  const PINNED = { Id: "5006632", Name: "Yoghurt med jordbær", Brand: "Lavpris", Price: 14.18, UnitPriceCalc: 47.25, UnitPriceLabel: "kr/l", Description: "300 ml", Availability: CAN };
  const RIVAL = { Id: "77", Name: "Yoghurt med jordbær", Brand: "Gomor", Price: 16, UnitPriceCalc: 53.33, UnitPriceLabel: "kr/l", Description: "300 ml", Availability: CAN };
  const mcp = {
    async call(tool, args) {
      if (tool !== "search_products" || String(args.query).toLowerCase() !== "yoghurt jordbær") {
        return { isError: true, text: "unexpected " + tool, json: null };
      }
      return { isError: false, text: "", json: { Products: { Products: [PINNED, RIVAL] } } };
    },
  };
  const intent = { query: "Yoghurt jordbær", need: "600 g", mode: "history", sku: "5006632" };
  const kept = await resolveIntent(mcp, intent, {});
  assert.equal(String(kept.pick.sku), "5006632", "without a refusal the favourite is bought, as always");
  assert.equal(kept.compare, "sku-pin");
  const refused = await resolveIntent(mcp, { ...intent, avoidBrands: ["Lavpris"] }, {});
  assert.equal(refused.ok, true, "the line is still filled");
  assert.equal(String(refused.pick.sku), "77", "with the rival, not the refused brand");
  assert.equal(refused.pinMissed, "5006632", "the plan knows the favourite was passed over");
  assert.match(String(refused.pinRefused), /brand Lavpris/, "and that it was the never-list, not an empty shelf");
  assert.match(refused.why, /your own never-list outranks the favourite/, "and the plan line says so in words");
  // The same refusal on a shelf that holds nothing else: not "out of stock", a refusal.
  const alone = {
    async call(tool, args) {
      if (tool !== "search_products" || String(args.query).toLowerCase() !== "yoghurt jordbær") {
        return { isError: true, text: "unexpected " + tool, json: null };
      }
      return { isError: false, text: "", json: { Products: { Products: [PINNED] } } };
    },
  };
  const empty = await resolveIntent(alone, { ...intent, avoidBrands: ["Lavpris"] }, {});
  assert.equal(empty.ok, false, "with nothing else on the shelf the line is not filled");
  assert.match(empty.why, /your own never-list refused them \(brand Lavpris\)/, "and it is named as a refusal, not as an empty shelf");
  assert.ok(!empty.substitution || String(empty.substitution.brand || "") !== "Lavpris", "a proposal never carries the refused brand either");
});

test("a close answer under the family's own bar becomes a printed decision, never a purchase", async () => {
  const CAN = { IsDeliveryAvailable: true, IsAvailableInStock: true };
  const CLOSE = {
    Id: "9000002", Name: "Revet Ost Danbo", Brand: "Arla", Price: 24,
    UnitPriceCalc: 60, UnitPriceLabel: "kr/kg", Description: "400 g", Availability: CAN,
  };
  const mcp = { async call() { return { isError: false, text: "", json: { Products: { Products: [CLOSE] } } }; } };
  const intent = { query: "Ost revet danbo fast", need: "400 g", purchasing: { minNameScore: 0.8 } };
  const r = await resolveIntent(mcp, intent, {});
  assert.equal(r.ok, false, "the family's bar still holds - a near miss is never bought on its own");
  assert.equal(r.nearMiss.length, 1, "the close name is carried to the plan, not dropped");
  assert.equal(r.nearMiss[0].sku, "9000002", "with the sku, so the line can be checked");
  assert.equal(r.nearMiss[0].score, 0.75, "with the score it reached, measured against the 0,8 bar");
  assert.equal(r.nearMiss[0].price, 24, "and the price it would cost");
  const refused = await resolveIntent(mcp, { ...intent, avoidBrands: ["Arla"] }, {});
  assert.deepEqual(refused.nearMiss, [], "a brand the family never buys is not offered back as a near miss");
  const taken = await resolveIntent(mcp, { ...intent, query: r.nearMiss[0].name, mode: "cheapest" }, {});
  assert.equal(taken.ok, true, "the flag the plan prints really lands on that product");
  assert.equal(String(taken.pick.sku), "9000002", "the same product, not another one with a similar name");
});

test("a malformed members list is an empty household, not a crash", () => {
  const b = blockPeopleOf({ dinners: { members: {} }, household: { blockPeople: {} } }, {});
  assert.equal(b.people.breakfast, 1, "with nobody readable, one person is the floor");
  assert.equal(b.people.kidLunchbox, 0);
});

test("a corrupt pool is an empty pool, not a crash", () => {
  const r = chooseDinners("not a list", { days: 1, coversDays: 1, lastUsed: {}, wanted: [] });
  assert.deepEqual(r.menu, []);
});

test("a malformed profile and missing data files do not crash the loader", () => {
  const dir = mkdtempSync(join(tmpdir(), "fam-bad-"));
  try {
    writeFileSync(join(dir, "family-bad.json"), JSON.stringify({
      name: "bad", schemaVersion: 1, dinners: { members: {} }, household: {},
    }));
    const fam = loadFamily({ dir, name: "bad" });
    assert.deepEqual(fam.household.members, [], "a members object is not a list");
    assert.deepEqual(fam.pool.pool, [], "a missing pool is an empty pool");
    assert.deepEqual(fam.pantry.blocks, {}, "a missing pantry has no blocks");
    assert.ok(fam.blockPeople.people.breakfast >= 1, "the block head-count is still usable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a short exclusion word does not match the middle of a name", () => {
  assert.equal(nameHasWord("Andebryst", "and"), true);
  assert.equal(nameHasWord("Sandwich", "and"), false);
  assert.equal(nameHasWord("Kyllingelår", "lår"), true);
  assert.equal(nameHasWord("Lammekød", "lam"), true);
  assert.equal(nameHasWord("Slam", "lam"), false);
  const shelf = [
    { id: "1", name: "Sandwich", unitPrice: 10, availability: {} },
    { id: "2", name: "Andebryst", unitPrice: 10, availability: {} },
  ];
  const { eligible, rejected } = eligibleOf(shelf, { avoidWords: ["and"] });
  assert.deepEqual(eligible.map((c) => c.name), ["Sandwich"]);
  assert.equal(rejected[0].name, "Andebryst");
});

test("a removed card is not kept by its shared ingredients", () => {
  const plan = {
    dinnerMenu: [{ name: "Carbonara", url: "/carbonara" }, { name: "Bami", url: "/bami" }],
    items: [
      { sku: "1", name: "Bacon", packs: 1, sources: ["dinner:/carbonara", "dinner:/bami"] },
      { sku: "2", name: "Æg", packs: 1, sources: ["dinner:/carbonara"] },
      { sku: "3", name: "Nudler", packs: 1, sources: ["dinner:/bami"] },
    ],
  };
  const basket = {
    Lines: [{ Id: "1" }, { Id: "2" }, { Id: "3" }],
    Recipes: [{ Id: "bami-guid", Title: "Bami" }],
  };
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), ["Bami"]);
});

test("a new package sku wins when the old one has not been bought for months", () => {
  const staples = [
    { sku: "old", name: "Smør (saltet)", orders: 10, lastDate: "2026-01-01", medianUnitPrice: 20 },
    { sku: "new", name: "Smør (saltet)", orders: 2, lastDate: "2026-11-17", medianUnitPrice: 21 },
  ];
  assert.equal(bestSku("Smør saltet", staples).sku, "new");
  const steady = staples.map((s) => ({ ...s, lastDate: "2026-11-01" }));
  steady[0].orders = 10; steady[1].orders = 2;
  assert.equal(bestSku("Smør saltet", steady).sku, "old", "the regular sku still wins");
});

test("shared lines alone do not keep a dinner when the basket has no cards", () => {
  const plan = {
    dinnerMenu: [{ name: "Carbonara", url: "/carbonara" }, { name: "Bami", url: "/bami" }],
    items: [
      { sku: "1", name: "Bacon", packs: 1, sources: ["dinner:/carbonara", "dinner:/bami"] },
      { sku: "2", name: "Æg", packs: 1, sources: ["dinner:/carbonara", "dinner:/bami"] },
      { sku: "3", name: "Nudler", packs: 1, sources: ["dinner:/bami"] },
    ],
  };
  const basket = { Lines: [{ Id: "1" }, { Id: "2" }], Recipes: [] };
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), [], "both dinners only have shared lines");
  basket.Lines.push({ Id: "3" });
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), ["Bami"], "the signature line keeps Bami");
});

test("Danish recipe numbers: comma, fraction, vulgar fraction, range and words", () => {
  assert.equal(amountNumber("1,5"), 1.5);
  assert.equal(amountNumber("1½"), 1.5);
  assert.equal(amountNumber("1 1/2"), 1.5);
  assert.equal(amountNumber("1/2"), 0.5);
  assert.equal(amountNumber("½"), 0.5);
  assert.equal(amountNumber("ca. 2"), 2);
  assert.equal(amountNumber("2-3"), 2, "the low end is the safe shopping need");
  assert.equal(amountNumber("en"), 1);
  assert.equal(amountNumber("to"), 2);
  assert.equal(amountNumber("halv"), 0.5);
  assert.equal(amountNumber("efter smag"), null);
  assert.equal(normalizeAmountText("8-12%", { range: false }), "8-12%", "a fat grade is not a range");
});

test("pack sizes: rough amounts, fractions and ranges", () => {
  assert.equal(parsePack("ca. 500 g").qty, 500);
  assert.equal(parsePack("1½ l").qty, 1500);
  assert.equal(parsePack("1/2 kg").qty, 500);
  assert.equal(parsePack("2-3 stk.").qty, 2);
  assert.equal(parsePack("24 x 0,33 l").qty, 7920);
  assert.equal(parsePack("400 g / Glyngøre").qty, 400);
});

test("query cleaning strips a decimal amount before the comma split", () => {
  assert.equal(cleanQuery("1,5 dl fløde", []), "Fløde");
  assert.equal(cleanQuery("1½ dl fløde", []), "Fløde");
  assert.equal(cleanQuery("1/2 kg hakket oksekød", []), "Oksekød");
  assert.equal(cleanQuery("2 spsk olie", []), "Olie");
  assert.equal(cleanQuery("1 fed hvidløg", []), "Hvidløg");
  assert.equal(cleanQuery("Kylling, skåret i strimler", []), "Kylling");
});

test("compound product names keep the product and refuse the prepared dish", () => {
  const scoreOf = (q, n) => score(q, n);
  assert.equal(scoreOf("kylling", "Kyllingebrystfilet"), 1);
  assert.equal(scoreOf("kylling", "Kyllingesalat"), 0);
  assert.equal(scoreOf("tomat", "Cherrytomater"), 1);
  assert.equal(scoreOf("tomat", "Tomatpuré"), 0);
  assert.equal(scoreOf("fisk", "Fiskefars"), 1);
  assert.equal(scoreOf("fisk", "Fiskesuppe"), 0);
  assert.equal(scoreOf("spaghetti", "Spaghettoni"), 1);
  assert.equal(scoreOf("agurk", "Agurkesalat"), 0);
  assert.equal(scoreOf("kylling", "Kyllingepølse"), 0);
  assert.equal(scoreOf("fløde", "Flødeost"), 0);
  assert.equal(scoreOf("mælk", "Mælkeskum"), 0);
});

test("recipe amounts convert dl, spoons and cloves before they reach the shelf", () => {
  const amounts = { household: { cookServings: 5 } };
  const exclusions = { pantryWords: { words: [] }, freshHerbs: { words: [] }, neverBought: { words: [] }, queryAsides: { words: [] } };
  const recipe = { name: "Test", servings: 4, ingredients: [
    { text: "Fløde", amount: "1,5", unit: "dl" },
    { text: "Chiliflager", amount: "2", unit: "tsk", grams: 50 },
    { text: "Hvidløg", amount: "2", unit: "fed" },
    { text: "Tomater", amount: "2", unit: "dåse" },
    { text: "Kartofler", amount: "1", unit: "kg" },
  ] };
  const out = recipeIntents(recipe, { amounts, meat: { rules: [] }, exclusions });
  const need = (q) => out.intents.find((i) => i.query === q).need;
  assert.equal(need("Fløde"), "190 ml", "1,5 dl for 4 scales to 5 servings");
  assert.equal(need("Chiliflager"), "15 g", "a teaspoon is 5 g, not the page's 50 g");
  assert.equal(need("Hvidløg"), "25 g", "two cloves are 10 g before scaling");
  assert.equal(need("Tomater"), "3 dåse", "two cans scale to three, and stay cans");
  assert.equal(need("Kartofler"), "1250 g", "a kg with no page grams still converts");
});

test("a new card takes its protein from the recipe url, not only its title", () => {
  const page = { content: [{ Header: "Salatpizza med kebab", NumberOfPersons: 4, TotalTime: "20 min",
    RecipeTags: [], IngredientGroups: [{ Ingredients: [{ ProductSelectionId: "1", Text: "Kebab", Amount: "100", Unit: "g" }] }] }] };
  const entry = poolEntry("/opskrifter/salatpizza-kyllingekebab-98004472", { name: "Salatpizza med kebab" }, page);
  assert.equal(entry.protein, "kylling", "the url says chicken even when the title says kebab");
  assert.equal(entry.minutes, 20);
});

test("the pool cap keeps a liked card before a higher-scored stranger", () => {
  const entries = [
    { url: "/a", name: "A", score: 100 },
    { url: "/b", name: "B", score: 90 },
    { url: "/liked", name: "Liked", score: 1 },
  ];
  const { pool, dropped } = capPool(entries, new Set(["/liked"]), 2);
  assert.deepEqual(pool.map((p) => p.url), ["/liked", "/a"]);
  assert.deepEqual(dropped.map((p) => p.url), ["/b"]);
});

test("two cans stay two packs, whatever each can weighs", () => {
  assert.equal(packsFor({ qty: 2, unit: "dåse" }, { qty: 400, unit: "g" }), 2);
  assert.equal(packsFor({ qty: 2, unit: "pakke" }, { qty: 500, unit: "g" }), 2);
});

test("accents do not hide a product", () => {
  assert.equal(score("creme fraiche", "Crème fraiche"), 1);
  assert.equal(score("pate", "Pâté"), 1);
  assert.equal(cleanQuery("Crème fraiche", []), "Crème fraiche");
});

test("a card with no title is kept by its url", () => {
  const plan = { dinnerMenu: [{ name: "Dinner A", url: "/a" }, { name: "Dinner B", url: "/b" }], items: [] };
  const basket = { Lines: [], Recipes: [{ Id: "guid-a", Url: "/a", Title: "" }] };
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), ["Dinner A"]);
});

test("a card and a plan may spell the same recipe url differently", () => {
  const plan = { dinnerMenu: [{ name: "Dinner A", url: "https://www.nemlig.com/opskrifter/a?from=plan" }], items: [] };
  const basket = { Lines: [], Recipes: [{ Id: "guid", Url: "/opskrifter/a/", Title: "" }] };
  assert.deepEqual(keptDinners(plan, basket).map((d) => d.name), ["Dinner A"]);
});

// --- packWindow: a band around the need where the cheapest total may undershoot ----
const pack500 = { sku: "p500", name: "Hakket oksekoed", price: 59.95, pack: { qty: 500, unit: "g" } };
const pack1000 = { sku: "p1000", name: "Hakket oksekoed", price: 96.19, pack: { qty: 1000, unit: "g" } };
const pack350 = { sku: "p350", name: "Hakket oksekoed", price: 29, pack: { qty: 350, unit: "g" } };

test("without a window the need is covered for the lowest total", () => {
  const bought = choosePack({ qty: 900, unit: "g" }, [pack500, pack1000], { name: "Hakket oksekoed" });
  assert.equal(bought.packs, 1, "one 1 kg pack costs less than two 500 g");
  assert.equal(bought.candidate.sku, "p1000");
});

test("a meat window lets a smaller total win while it still feeds everyone", () => {
  const bought = choosePack({ qty: 900, unit: "g" }, [pack350, pack500],
    { name: "Hakket oksekoed", packWindow: { min: 700, max: 1040 } });
  assert.equal(bought.packs, 2, "two 350 g packs (700 g) beat two 500 g inside the band");
  assert.equal(bought.candidate.sku, "p350");
});

test("the window floor never lets a too-small undershoot in", () => {
  const bought = choosePack({ qty: 900, unit: "g" }, [pack350],
    { name: "Hakket oksekoed", packWindow: { min: 800, max: 1040 } });
  assert.equal(bought.packs, 3, "700 g is under the 800 g floor, so 1050 g is bought");
  assert.ok(bought.supply >= 1050, "three 350 g packs is the smallest cover");
});

test("a condiment band buys one bottle where the exact cover needs two", () => {
  const sauce = { sku: "s150", name: "Pad thai wok sauce", price: 19, pack: { qty: 150, unit: "g" } };
  const exact = choosePack({ qty: 200, unit: "g" }, [sauce], { name: "Pad thai wok sauce" });
  assert.equal(exact.packs, 2, "without the band two 150 g bottles cover 200 g");
  const band = choosePack({ qty: 200, unit: "g" }, [sauce],
    { name: "Pad thai wok sauce", packWindow: { min: 140, max: 0 } });
  assert.equal(band.packs, 1, "150 g is 25 % under 200 g, inside the 30 % condiment band");
});
