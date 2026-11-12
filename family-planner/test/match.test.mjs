// Regression tests for the product matcher and the unit maths. Run:
//   node --test test/match.test.mjs
// Every case below is a real Namlig name from this household's history or search
// results. A new failure means the planner would put a different product in the
// basket than the profile asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { norm, tokens, score, nameMatches } from "../match.mjs";
import { parsePack, packsFor, cheapest, toBaseMeasure, pieceGrams } from "../units.mjs";
import { choosePack } from "../units.mjs";
import { consolidateIntents } from "../plan.mjs";
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
import { wantQtyOf, extrasToZero } from "../apply.mjs";

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

test("only recipe products the plan rejects are zeroed", () => {
  const lines = [
    { sku: "1", name: "Dild" },
    { sku: "2", name: "Kylling" },
    { sku: "3", name: "Salt" },
    { sku: "3", name: "Salt" },
  ];
  const out = extrasToZero(lines, new Set(["2"]), new Set(["3"]));
  assert.deepEqual(out.map((x) => x.sku), ["1"]);
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

test("four folded letters still find the compound: milk finds minimilk", () => {
  assert.ok(score("Mælk", "Minimælk 25%") > 0);
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

test("an out-of-stock protein can be swapped by the profile's alt queries", () => {
  const fam = loadFamily();
  const rejer = fam.meat.rules.find((r) => r.id === "rejer");
  assert.ok(rejer.alt.length >= 3);
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
