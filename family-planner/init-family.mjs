// init-family.mjs — build profiles/family-<name>.json from your own order history.
//
// Run the miners first, then this:
//   node mine-history.mjs && node mine-recipes.mjs && node mine-recipes-fetch.mjs
//   node mine-recipes-analyze.mjs
//   node init-family.mjs --name family-of-4 --adults 2 --children 2 --days 8
//
// Nothing here guesses a taste. Every number comes from your own orders and says how
// many times it was seen. Things a miner cannot know - whether you use fresh herbs, say
// - are written with a question in the file, so you edit one line instead of reading code.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { FOLD } from "./similarity.mjs";

import { HOME as BASE } from "./paths.mjs";
const READ = (p, f) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : f);

/** The protein knobs, in the order a shopper thinks about them. */
const PROTEIN_KEYS = [
  ["hakket-okse", "hakket okse"],
  ["hakket-kylling", "hakket kylling"],
  ["hakket-svin", "hakket gris"],
  ["kylling", "kyllingebryst"],
  ["fisk-hvid", "fiskefars"],
  ["rejer", "rejer"],
  ["polse", "polser"],
  ["bacon", "bacon"],
  ["skinke", "skinke"],
];

/** Herbs and cupboard items: the same words in any European kitchen. */
const HERB_WORDS = ["persille", "purløg", "forårsløg", "koriander", "basilikum", "mynte", "dild", "rosmarin", "timian", "salvie", "dragon", "frisk ingefær", "salatblad"];
const PANTRY_WORDS = ["salt", "peber", "salt og peber", "olie", "olivenolie", "rapsolie", "solsikkeolie", "smør til stegning", "vand", "sukker", "brun farin", "vaniljesukker", "bagepulver", "maizena", "eddike", "balsamico", "paprika", "sød paprika", "spidskommen", "gurkemeje", "kanel", "kardemomme", "krydderi", "krydderier", "bouillon", "hønsebouillon", "grøntsagsbouillon", "terning", "terninger", "kvart", "fedt", "stivelse"];
// A starting point, not an answer: the shop writes one name and your family buys another.
// Empty means the planner searches what the recipe says, which is right for most people.
const ALIASES = {};

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

/** The value at `q` (0-1) of a sorted list; the median is q 0.5. */
function quantile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const idx = Math.min(v.length - 1, Math.max(0, Math.round((v.length - 1) * q)));
  return v[idx];
}

/** The protein knobs, taken from what this family actually buys. */
function meatKnobs(meatSummary) {
  const out = {};
  for (const [id, word] of PROTEIN_KEYS) {
    const want = FOLD(word);
    const buys = (meatSummary || [])
      .filter((x) => FOLD(x.name).includes(want))
      .sort((a, b) => (b.buys || 0) - (a.buys || 0));
    const top = buys[0];
    if (!top) {
      out[id] = { buy: null, fatBands: [], maxKrPerKg: null, never: [], _note: `not seen in your orders - edit this line` };
      continue;
    }
    const ceiling = quantile(top.perKg || [], 0.75);
    out[id] = {
      buy: top.name,
      fatBands: top.fat ? [top.fat] : [],
      maxKrPerKg: ceiling === null ? null : Math.ceil(ceiling / 5) * 5,
      never: [],
      _evidence: `${top.buys} purchases, median ${top.medianPerKg} kr/kg`,
    };
  }
  return out;
}

/** Words your recipes ask for that you have never bought. */
function neverBoughtWords(wordCoverage, limit = 40) {
  const skipped = new Set(PANTRY_WORDS.map(FOLD));
  const out = [];
  for (const w of wordCoverage || []) {
    const word = FOLD(w.word);
    if (!word || skipped.has(word)) continue;
    if ((w.askedRecipes || 0) >= 2 && (w.boughtRecipes || 0) === 0) out.push(w.word);
  }
  return out.slice(0, limit);
}

/** An alias only helps if this family really buys the target product. */
function aliasesFor(staples) {
  const names = FOLD((staples || []).map((s) => s.name).join(" "));
  const out = {};
  for (const [from, to] of Object.entries(ALIASES)) {
    if (names.includes(FOLD(to))) out[from] = to;
  }
  return out;
}

/**
 * An alias is learned after init, from an ask that never answers: the recipe words a
 * topping, the shelf answers a different seed, the family buys the flake it toasts itself.
 * A re-init cannot re-derive that, so it keeps what the family already taught it.
 */
export function learnedAliases(oldProfile, generated) {
  const learned = (oldProfile && oldProfile.exclusions && oldProfile.exclusions.queryAliases) || {};
  return { ...generated, ...learned };
}

function main() {
  const name = arg("name", null);
  // Accept "jensen", "of-4" or "family-jensen": people type all three, and a family
  // called Jensen should not have to call their profile family-of-4.
  const slug = String(name || "").replace(/^family-/, "").replace(/\.json$/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`--name must be a simple name like "jensen" or "of-4", got "${name}"`);
  }
  const adults = Number(arg("adults", "2")), children = Number(arg("children", "1"));
  const days = Number(arg("days", "8"));
  // One cooking may cover more eatings than one: 2 is one pot eaten twice, 0 is cooked fresh every night.
  const extraRaw = arg("extra-portions", "2"), extra = Number(extraRaw);
  if (!(extra >= 0 && extra <= 6)) throw new Error(`--extra-portions must be 0-6, got "${extraRaw}"`);
  if (!(adults > 0 && children >= 0 && days > 0)) throw new Error("adults must be > 0, children >= 0, days > 0");
  const out = `${BASE}/profiles/family-${slug}.json`;
  if (existsSync(out) && !process.argv.includes("--force")) {
    throw new Error(`${out} already exists. Edit it, or pass --force to rewrite it.`);
  }
  // Read the profile that is about to be replaced: its learned words are kept below.
  const previous = existsSync(out) ? READ(out, null) : null;

  const patterns = READ(`${BASE}/data/patterns.json`, null);
  const analysis = READ(`${BASE}/data/recipes-analysis.json`, null);
  const staples = READ(`${BASE}/data/staples.json`, []);
  if (!patterns || !analysis) throw new Error("run node mine-history.mjs, node mine-recipes.mjs, node mine-recipes-fetch.mjs and node mine-recipes-analyze.mjs first");

  const medianTotal = Number(patterns.medianOrderTotal) || 1000;
  const gapDays = Number(patterns.medianDaysBetweenOrders) || 7;
  const softCap = Math.round((medianTotal * days) / gapDays / 50) * 50;
  const coverage = (analysis.summary || {}).wordCoverage || [];
  const neverBought = neverBoughtWords(coverage);
  // The rule is a taste, not a measurement: leave every herb out, but say which words
  // your own history contradicts, so the family can move them in one line.
  const herbWords = HERB_WORDS;
  const herbsBought = HERB_WORDS.filter((w) => ((coverage.find((c) => FOLD(c.word) === FOLD(w)) || {}).boughtRecipes || 0) > 0);

  const profile = {
    _readme: [
      `Built by init-family.mjs from ${patterns.orderCount} orders (${patterns.firstOrder} to ${patterns.lastOrder}).`,
      "This is the ONE file you edit. The generated files next to it carry the evidence.",
      "Every _evidence and _note line says how many times the planner saw the number.",
    ],
    schemaVersion: 1,
    name: `family-${slug}`,
    at: new Date().toLocaleDateString("en-CA"),
    edited: `init-family.mjs on ${new Date().toLocaleDateString("en-CA")}`,
    household: {
      adults,
      children,
      childAges: [],
      extraPortions: extra,
      peopleToShopFor: adults + children + extra,
      timezone: arg("timezone", "Europe/Copenhagen"),
      _note: extra === 0
        ? "peopleToShopFor is the family as it is: every dinner is cooked fresh, nothing is eaten twice."
        : `peopleToShopFor is adults + children + ${extra}: one pot is cooked once and eaten ${extra} times.`,
    },
    dinners: {
      servingsPerDinner: adults + children + extra,
      daysPerDinner: 2,
      cookOnceEatTwice: true,
      maxRecipeMinutes: Number(arg("max-minutes", "30")),
      recipeSource: "nemlig 30-minute recipes (their app)",
    },
    budget: {
      currency: "DKK",
      softCapKr: softCap,
      maxDaysPerPlan: days,
      planMaxAgeHours: 12,
      _evidence: `median order ${medianTotal} kr, median ${gapDays} days between orders`,
    },
    rotation: { poolSize: 21, maxPerProtein: 2, minFishDishes: 1, alternateNewAndKnown: true, neverTwoVariantsOfTheSameDinner: true },
    basket: {
      mode: "keep-and-top-up", neverClearBasket: true, checkout: "basket-and-slot-only",
      preferSale: true, saleTolerancePct: 10, recipeCards: true,
      _note: "keep-and-top-up: your basket is shared with the app, so nothing is ever deleted automatically.",
    },
    learning: {
      enabled: true, minObservations: 2, maxQuantityFactor: 2, autoAddMissing: true,
      exploration: { cooldownTimes: 3, cooldownDays: 42 },
      _note: "Run node refresh.mjs after you have shopped from a plan a couple of times. learn.mjs then compares each plan with the basket you approved and fills profiles/learned.json. That file is generated and always loses to this one. Rate dishes you loved or refused: node learn.mjs --rate \"<recipe url>\" good|bad.",
    },
    purchasing: {
      overshootPctFresh: 25, overshootPctStable: 100,
      tieBreakKr: Math.min(5, Math.max(1, Math.round((Number(medianTotal) || 1000) / 500))),
      stableWords: ["æg", "ris", "pasta", "mel", "sukker", "kaffe", "the", "pulver", "konserves", "tørret", "toilet", "køkkenrulle", "serviet", "sæbe", "fryse"],
      _note: "The planner buys the lowest TOTAL price that covers the need, never the best price per unit. Fresh items may overrun the need by overshootPctFresh, items that keep by overshootPctStable; a price difference under tieBreakKr goes to the smaller pack.",
    },
    delivery: { minWindowHours: 3, deliveryType: "attended", pricePriority: "cheap-over-time", _note: "set weekdayPrefer and windowPrefer to the hours you are home" },
    meat: {
      rule: { always: "compare price per kg, not the pack price" },
      perProtein: meatKnobs((analysis.summary || {}).meat),
      priceRule: "always compare price per kg, never the pack price",
    },
    exclusions: {
      freshHerbs: "never buy the fresh herbs a recipe asks for",
      herbWords,
      keepEvenThoughCommon: (coverage.filter((c) => FOLD(c.word).length > 3 && (c.boughtRecipes || 0) >= (c.askedRecipes || 1) && (c.askedRecipes || 0) >= 5).map((c) => c.word)).slice(0, 12),
      pantryWords: PANTRY_WORDS,
      neverBought,
      queryAliases: learnedAliases(previous, aliasesFor(staples)),
      _open: herbsBought.length
        ? `Your own history contradicts the herb rule for: ${herbsBought.join(", ")}. Move those words to keepEvenThoughCommon if you do buy them.`
        : "A miner cannot know your taste. Read exclusions and meat - those two sections are the difference between your basket and someone else's.",
    },
    neverBuy: [],
  };

  writeFileSync(out, JSON.stringify(profile, null, 1));
  console.log(`Wrote ${out}`);
  const extraNote = extra === 0 ? "every dinner cooked fresh, nothing kept over" : `cooked once eaten ${extra}`;
  console.log(`  portions per dinner : ${profile.household.peopleToShopFor} (${adults} adults + ${children} children + ${extra} extra portions, ${extraNote})`);
  console.log(`  soft cap for ${days} days  : ${softCap} kr  (median order ${medianTotal} kr every ${gapDays} days)`);
  console.log(`  meat from your cart : ${Object.values(profile.meat.perProtein).filter((k) => k.buy).length} of ${PROTEIN_KEYS.length} proteins filled in`);
  console.log(`  never bought        : ${neverBought.length} recipe words your family has never bought`);
  console.log(`  herbs left out      : ${profile.exclusions.herbWords.length} words; your keepEvenThoughCommon has ${profile.exclusions.keepEvenThoughCommon.length}`);
  const kept = previous ? Object.keys((previous.exclusions || {}).queryAliases || {}).length : 0;
  console.log(`  aliases             : ${Object.keys(profile.exclusions.queryAliases).length} that your own staples support, ${kept} kept from the profile you had`);
  console.log(`Use it: node plan.mjs --family ${slug} --days ${days}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  }
}
