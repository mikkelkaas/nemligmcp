// family.mjs — reads the one profile a family edits: profiles/family-*.json.
//
// It returns the shapes the rest of the planner already speaks (household, meat,
// exclusions), built from the family profile, so nothing else has to know that the
// knobs moved into one file. Generated data (amounts.json, recipe-pool.json,
// pantry.json, dinners.json and the evidence in meat.json) is read as before and
// merged UNDER the profile, so the profile always wins.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { tasteFile } from "./learn.mjs";

import { HOME as BASE, PROFILES } from "./paths.mjs";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

/** The active profile: --name or NEMLIG_FAMILY_PROFILE, else the only family-*.json. */
export function findProfileFile(dir = PROFILES, name = process.env.NEMLIG_FAMILY_PROFILE || null) {
  // family-EXAMPLE.json is the shipped template, not a family.
  const files = readdirSync(dir).filter((f) => /^family-.*\.json$/.test(f) && !/^family-example/i.test(f)).sort();
  if (files.length === 0) throw new Error(`no profiles/family-*.json in ${dir} - run node init-family.mjs`);
  if (name) {
    // Accept "of-4", "family-of-4" or "family-of-4.json" - people type all three.
    const bare = String(name).replace(/^family-/, "").replace(/\.json$/, "");
    const want = files.find((f) => f === `family-${bare}.json`);
    if (!want) throw new Error(`profile "${name}" not found. Available: ${files.map((f) => f.replace(/^family-|\.json$/g, "")).join(", ")}`);
    return `${dir}/${want}`;
  }
  if (files.length > 1) throw new Error(`several family profiles, say which: ${files.join(", ")} (or set NEMLIG_FAMILY_PROFILE)`);
  return `${dir}/${files[0]}`;
}

/** Household in the shape plan.mjs, apply.mjs and slots.mjs already read. */
function householdOf(p) {
  const h = p.household || {};
  return {
    schemaVersion: p.schemaVersion || 1,
    people: Number(h.peopleToShopFor || ((h.adults || 2) + (h.children || 0) + 2)),
    adults: Number(h.adults || 2),
    kids: (h.childAges || []).map((ageYears) => ({ ageYears })),
    dinnersForPeople: Number((p.dinners || {}).servingsPerDinner || 5),
    portionsPerNight: ((p.dinners || {}).members || []).reduce((n, m) => n + (Number(m.count) || 0) * (Number(m.appetite) || 1), 0)
      || Number((p.dinners || {}).servingsPerDinner || 5) / Math.max(1, Number((p.dinners || {}).daysPerDinner || 2)),
    daysCoveredByOneDinner: Number((p.dinners || {}).daysPerDinner || 2),
    currency: (p.budget || {}).currency || "DKK",
    softCapKr: Number((p.budget || {}).softCapKr || 1500),
    timezone: h.timezone || "Europe/Copenhagen",
    neverBuy: p.neverBuy || [],
    recipeRule: {
      maxRecipeMinutes: Number((p.dinners || {}).maxRecipeMinutes || 30),
      peoplePerRecipe: Number((p.dinners || {}).servingsPerDinner || 5),
      source: (p.dinners || {}).recipeSource || "nemlig 30-minute recipes (their app)",
      cheapestOption: true,
    },
    basketPolicy: {
      mode: (p.basket || {}).mode || "keep-and-top-up",
      neverClearBasket: (p.basket || {}).neverClearBasket !== false,
      checkout: (p.basket || {}).checkout || "basket-and-slot-only",
    },
    purchaseRules: {
      preferSale: (p.basket || {}).preferSale !== false,
      saleTolerancePct: Number((p.basket || {}).saleTolerancePct ?? 10),
    },
    deliveryPreference: p.delivery || {},
    purchasing: purchasingOf(p),
    rotation: p.rotation || {},
    members: (p.dinners || {}).members || [],
    preferLeftovers: (p.dinners || {}).preferLeftovers !== false,
    maxNightsPerDinner: Number((p.dinners || {}).maxNightsPerDinner || 2),
    reheatByFormat: (p.dinners || {}).reheatByFormat || null,
    nightsOverride: (p.dinners || {}).nightsOverride || {},
    planMaxAgeHours: Number((p.budget || {}).planMaxAgeHours || 12),
  };
}

/** The meat rules from the generated evidence file, with the family's knobs on top. */
function meatOf(profile, generated) {
  const knobs = (profile.meat || {}).perProtein || {};
  const rules = (generated.rules || []).map((rule) => {
    const k = knobs[rule.id] || {};
    return {
      ...rule,
      query: k.buy || rule.query,
      fatBands: k.fatBands || rule.fatBands,
      maxKrPerKg: k.maxKrPerKg === undefined ? rule.maxKrPerKg : k.maxKrPerKg,
      avoid: k.never || rule.avoid,
      // Extra queries worth trying when Namlig is out of the preferred one: the profile
      // lists them per protein, so an out-of-stock item becomes a swap, not a miss.
      alt: [...(rule.alt || []), ...(k.alt || [])],
    };
  });
  return {
    schemaVersion: generated.schemaVersion || 1,
    policy: (profile.meat || {}).rule || generated.policy || {},
    priceRule: (profile.meat || {}).priceRule || "always compare price per kg, never the pack price",
    rules,
    leftoversFromHistory: generated.leftoversFromHistory || [],
  };
}

/** The recipe filters and the query rewrite, in the shape dinners.mjs already reads. */
function exclusionsOf(profile, generated) {
  const e = profile.exclusions || {};
  const words = (section, key) => (Array.isArray(section) ? section : (generated[key] || {}).words || []);
  return {
    schemaVersion: generated.schemaVersion || 1,
    freshHerbs: { words: e.freshHerbs === false ? [] : words(e.herbWords, "freshHerbs"), action: "leave out and name in the plan file" },
    pantryWords: { words: words(e.pantryWords, "pantryWords"), action: "never added, not even named" },
    neverBought: { words: words(e.neverBought, "neverBought"), action: "leave out and name in the plan file" },
    keepEvenThoughCommon: { words: words(e.keepEvenThoughCommon, "keepEvenThoughCommon") },
    queryAliases: { words: e.queryAliases || (generated.queryAliases || {}).words || {} },
    // A recipe line sometimes names a second choice ("Spinat alternativt grønkål"). The
    // words that open such an aside are cut from the query, the fallback with them;
    // dinners.mjs knows the ordinary Danish ones, a family adds its own wording here.
    queryAsides: { words: words(e.queryAsides, "queryAsides"), action: "cut from the query, and the second choice after it" },
    _open: e._open || generated.openQuestion || null,
  };
}

/**
 * How a pack is chosen, from the profile, with the limits a shopper would use.
 * Defaults keep the planner conservative: fresh food may overrun the need by a
 * quarter, food that keeps by as much again, and a tie of a few kroner goes to the
 * smaller pack. `stableWords` is what this family considers no loss to buy extra of
 * - eggs keep for weeks, so 15 of them for a need of 12 is a saving, not waste.
 */
function purchasingOf(p) {
  const raw = p.purchasing || {};
  const num = (v, dflt, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const stable = Array.isArray(raw.stableWords) && raw.stableWords.length > 0
    ? raw.stableWords.map((w) => String(w)) : null;
  return {
    // How sure the planner must be that a shelf name is the product asked for: the share
    // of the query's words the name must contain. 0,7 is what works on Namlig's names;
    // lower accepts more, higher blocks more lines into the "not found" list.
    minNameScore: num(raw.minNameScore, 0.7, 0.5, 0.95),
    // Words that may sit in front of a product name without making it another product FOR
    // THIS FAMILY ("parboiled", "basmati" over rice they both buy). Kept short: 40 words is
    // more than any family needs, and an unbounded list slows every name check on the shelf.
    qualifierWords: Array.isArray(raw.qualifierWords)
      ? raw.qualifierWords.slice(0, 40).map((w) => String(w).toLowerCase())
      : [],
    overshootPctFresh: num(raw.overshootPctFresh, 25, 0, 500),
    // A keepsake may overrun the need a long way: the price rule already refuses to pay
    // more in total, so a bigger pack of it is only taken when it is also cheaper.
    overshootPctStable: num(raw.overshootPctStable, 400, 0, 10000),
    tieBreakKr: num(raw.tieBreakKr, 3, 0, 100),
    maxOverrunFreshMl: num(raw.maxOverrunFreshMl, 150, 0, 5000),
    stableWords: stable || ["æg", "ris", "pasta", "mel", "sukker", "kaffe", "the", "pulver",
      "konserves", "tørret", "toilet", "køkkenrulle", "serviet", "sæbe", "fryse", "bouillon", "havregryn"],
    freshWords: Array.isArray(raw.freshWords) && raw.freshWords.length > 0
      ? raw.freshWords.map((w) => String(w))
      : ["mælk", "fløde", "smør", "yoghurt", "ost", "fisk", "laks", "ørken", "rejer", "musling", "filet",
         "hakket", "kogt", "stegt", "spinat", "salat", "urter", "persille", "dild", "agurk", "tomat",
         "peberfrugt", "svamp", "avocado", "banan", "æble", "pære", "melon"],
  };
}

/**
 * The feedback loop, from the profile. A family that does not want it sets
 * `learning.enabled: false` and the planner stops reading what it learned.
 */
function learningOf(p) {
  const raw = p.learning || {};
  const num = (v, dflt, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  const ex = raw.exploration || {};
  return {
    enabled: raw.enabled !== false,
    minObservations: num(raw.minObservations, 2, 2, 20),
    maxQuantityFactor: num(raw.maxQuantityFactor, 2, 1, 4),
    autoAddMissing: raw.autoAddMissing !== false,
    exploration: { cooldownTimes: num(ex.cooldownTimes, 3, 2, 10), cooldownDays: num(ex.cooldownDays, 42, 7, 365) },
  };
}

/**
 * Load the family profile and everything derived from it.
 * `amounts` and `pool` stay generated files: they carry the evidence, not the taste.
 */
export function loadFamily({ dir = PROFILES, name = null } = {}) {
  const file = findProfileFile(dir, name);
  const profile = readJson(file, null);
  if (!profile) throw new Error(`cannot read ${file}`);
  return {
    file,
    profile,
    name: profile.name || file.split("/").pop().replace(/^family-|\.json$/g, ""),
    household: householdOf(profile),
    purchasing: purchasingOf(profile),
    learning: learningOf(profile),
    learned: existsSync(`${dir}/learned.json`) ? readJson(`${dir}/learned.json`, null) : null,
    taste: tasteFile(`${dir}/taste.json`),
    meat: meatOf(profile, readJson(`${dir}/meat.json`, { rules: [] })),
    exclusions: exclusionsOf(profile, readJson(`${dir}/exclusions.json`, {})),
    amounts: readJson(`${dir}/amounts.json`, {}),
    pool: readJson(`${dir}/recipe-pool.json`, { pool: [] }),
    dinners: readJson(`${dir}/dinners.json`, { dinners: [] }),
    pantry: readJson(`${dir}/pantry.json`, { items: [] }),
  };
}
