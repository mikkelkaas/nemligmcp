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

/**
 * How many people a pantry block is bought for. A lunch box is a fixed kit per person, so
 * the lines that mean "one per person per day" scale with heads, not with appetite: a
 * three-year-old and a teenager both put one apple and one slice of bread in a box.
 * The paper-and-cleaning block scales with nobody. `household.blockPeople` in the profile
 * overrides any of these, because the planner cannot know who packs a lunch box in a
 * family where the grown-ups take one too.
 */
export function blockPeopleOf(profile, household) {
  const rawMembers = ((profile || {}).dinners || {}).members;
  const members = Array.isArray(rawMembers) ? rawMembers : [];
  const heads = (list) => list.reduce((n, m) => n + (Number(m.count) || 0), 0);
  const isChild = (m) => /child|teen|ung|barn|baby/i.test(String((m || {}).role || ""));
  const children = heads(members.filter(isChild));
  const total = heads(members) || Number((household || {}).people) || 1;
  const derived = { breakfast: total, kidLunchbox: children, snacks: children, household: 1 };
  const override = ((profile || {}).household || {}).blockPeople || {};
  const people = {}, fromOverride = [];
  for (const block of Object.keys(derived)) {
    const raw = Number(override[block]);
    const useOverride = Number.isFinite(raw) && raw >= 0;
    people[block] = useOverride ? raw : derived[block];
    if (useOverride) fromOverride.push(block);
  }
  return { people, fromOverride, derived };
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
/** A hand-edited or truncated data file must not crash a plan: keep the shape, drop the
 *  lines that cannot be read, and let the plan say what it has. */
function normalizePantry(pantry) {
  const base = pantry && typeof pantry === "object" ? pantry : {};
  const blocks = base.blocks && typeof base.blocks === "object" && !Array.isArray(base.blocks) ? base.blocks : {};
  return { ...base, blocks, cycleDays: Number(base.cycleDays) || 30 };
}

function normalizePool(pool) {
  const base = pool && typeof pool === "object" ? pool : {};
  return { ...base, pool: Array.isArray(base.pool) ? base.pool : [] };
}

/** Rotation numbers a hand-edited profile can get wrong. No cap is the default: only a
 *  family that asks for one gets trials. A bad number falls back, never to "all". */
function rotationOf(p) {
  const raw = p.rotation && typeof p.rotation === "object" && !Array.isArray(p.rotation) ? p.rotation : {};
  const int = (v, dflt, lo, hi) => {
    if (v === undefined || v === null || v === "") return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
  };
  const words = Array.isArray(raw.excludeWords)
    ? raw.excludeWords.slice(0, 40).map((w) => String(w).toLowerCase().trim()).filter(Boolean) : [];
  const caps = {};
  if (raw.proteinCaps && typeof raw.proteinCaps === "object" && !Array.isArray(raw.proteinCaps)) {
    for (const [k, v] of Object.entries(raw.proteinCaps)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) caps[k] = Math.round(n);
    }
  }
  return { ...raw, excludeWords: words, proteinCaps: caps,
    maxNewPerPlan: int(raw.maxNewPerPlan, undefined, 0, 14),
    newMaxMinutes: int(raw.newMaxMinutes, undefined, 5, 180) };
}

function householdOf(p) {
  const h = p.household || {};
  const members = Array.isArray((p.dinners || {}).members) ? p.dinners.members : [];
  return {
    schemaVersion: p.schemaVersion || 1,
    // extraPortions is how much more one cooking covers: 2 means the pot is eaten twice.
    people: Number(h.peopleToShopFor || ((h.adults || 2) + (h.children || 0) + (Number.isFinite(Number(h.extraPortions)) ? Number(h.extraPortions) : 2))),
    adults: Number(h.adults || 2),
    kids: Array.isArray(h.childAges) ? h.childAges.map((ageYears) => ({ ageYears })) : [],
    dinnersForPeople: Number((p.dinners || {}).servingsPerDinner || 5),
    portionsPerNight: members.reduce((n, m) => n + (Number(m.count) || 0) * (Number(m.appetite) || 1), 0)
      || Number((p.dinners || {}).servingsPerDinner || 5) / Math.max(1, Number((p.dinners || {}).daysPerDinner || 2)),
    daysCoveredByOneDinner: Number((p.dinners || {}).daysPerDinner || 2),
    currency: (p.budget || {}).currency || "DKK",
    // A budget the family never set must not become a number from another family: no
    // profile, no cap, and the planner says so instead of measuring against a guess.
    softCapKr: Number.isFinite(Number((p.budget || {}).softCapKr)) && Number((p.budget || {}).softCapKr) > 0
      ? Number(p.budget.softCapKr) : null,
    // A ceiling is not a soft cap. The soft cap only warns; this one makes the plan
    // swap brands and put lines back until it fits (trim.mjs). Unset, the plan is
    // written whole, exactly as it was before the key existed.
    maxKrPerPlan: Number.isFinite(Number((p.budget || {}).maxKrPerPlan)) && Number((p.budget || {}).maxKrPerPlan) > 0
      ? Number(p.budget.maxKrPerPlan) : null,
    // Under this, a brand swap is churn rather than a saving: the same product, less
    // money, and the family still has to like what came home.
    minSwapKr: Number.isFinite(Number((p.budget || {}).minSwapKr)) && Number((p.budget || {}).minSwapKr) >= 0
      ? Number(p.budget.minSwapKr) : 5,
    // Products a family will not have swapped, by word in their name or brand: a diaper
    // size, a medicine, the one bread a child eats. Empty means the planner may swap any.
    swapNeverWords: Array.isArray((p.budget || {}).swapNeverWords)
      ? p.budget.swapNeverWords.map((w) => String(w || "").trim()).filter(Boolean).slice(0, 30) : [],
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
    rotation: rotationOf(p),
    members,
    preferLeftovers: (p.dinners || {}).preferLeftovers !== false,
    maxNightsPerDinner: Number((p.dinners || {}).maxNightsPerDinner || 2),
    reheatByFormat: (p.dinners || {}).reheatByFormat || null,
    nightsOverride: (p.dinners || {}).nightsOverride || {},
    // A family that wants meat or fish on the table sets this. A vegetarian dish can still
    // be asked for by name; the rotation just never picks one on its own.
    noVegetarian: (p.dinners || {}).noVegetarian === true,
    planMaxAgeHours: Number((p.budget || {}).planMaxAgeHours || 12),
  };
}

/**
 * Rules a family adds for goods the generated evidence does not cover: a product sold in
 * several grades ("cooking cream is the 4 % one") or a format the family always buys
 * ("onions and garlic come in a net"). The words stay here, in the profile, never in code.
 * A family rule is matched before a generated one, and its `except` words keep a rule off a
 * line where its own word means something else - "fløde" in "piskefløde" is not cooking cream.
 */
function familyRulesOf(profile) {
  const list = (profile.purchasing || {}).rules;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 40) {
    throw new Error("purchasing.rules must be an array of at most 40 rules");
  }
  const check = (v, at, max, min, len, lower) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max
      || !v.every((w) => typeof w === "string" && w.trim().length >= min && w.length <= len)) {
      throw new Error(`${at} must be at most ${max} entries of ${min}-${len} characters`);
    }
    return v.map((w) => (lower ? w.trim().toLowerCase() : w.trim()));
  };
  // Words are matched against a lower-cased product name; a text is a search query, so it
  // keeps the case the family typed.
  const words = (v, at, max, min) => check(v, at, max, min, 40, true);
  const texts = (v, at, max) => check(v, at, max, 3, 80, false);
  return list.map((r, i) => {
    const at = `purchasing.rules[${i}]`;
    if (!r || typeof r !== "object") throw new Error(`${at} must be an object`);
    if (typeof r.id !== "string" || !r.id.trim() || r.id.length > 40) throw new Error(`${at}.id is required, up to 40 characters`);
    const match = words(r.match, `${at}.match`, 12, 3);
    if (match.length === 0) throw new Error(`${at}.match needs at least one word to look for in the ingredient line`);
    // `query` is optional: leave it out to search the recipe's own word, and let the rule
    // carry only the size or the refusals. A dead query costs one search every plan.
    if (r.query !== undefined && (typeof r.query !== "string" || r.query.trim().length < 3 || r.query.length > 80)) {
      throw new Error(`${at}.query must be the text to search for, 3-80 characters`);
    }
    if (r.maxKrPerKg !== undefined && !(Number.isFinite(r.maxKrPerKg) && r.maxKrPerKg > 0)) {
      throw new Error(`${at}.maxKrPerKg must be a number of kroner above 0`);
    }
    if (r.minPackGrams !== undefined && !(Number.isFinite(r.minPackGrams) && r.minPackGrams >= 1 && r.minPackGrams <= 5000)) {
      throw new Error(`${at}.minPackGrams must be between 1 and 5000 grams - a pack nobody sells is a mistake, not a taste`);
    }
    if (r.maxFatPct !== undefined && !(Number.isFinite(r.maxFatPct) && r.maxFatPct >= 1 && r.maxFatPct <= 50)) {
      throw new Error(`${at}.maxFatPct must be between 1 and 50 percent`);
    }
    // `alt` is a search text, so it keeps the family's case; the word lists do not.
    const alt = texts(r.alt, `${at}.alt`, 5);
    return {
      id: r.id.trim(), family: true, match,
      except: words(r.except, `${at}.except`, 20, 2),
      query: r.query === undefined ? null : r.query.trim(), alt,
      avoid: words(r.avoid, `${at}.avoid`, 20, 2),
      maxKrPerKg: r.maxKrPerKg === undefined ? null : r.maxKrPerKg,
      maxFatPct: r.maxFatPct === undefined ? null : r.maxFatPct,
      minPackGrams: r.minPackGrams === undefined ? null : r.minPackGrams,
    };
  });
}

/** The meat rules from the generated evidence file, with the family's knobs on top. */
function meatOf(profile, generated) {
  const knobs = (profile.meat || {}).perProtein || {};
  const rules = [...familyRulesOf(profile), ...(generated.rules || []).map((rule) => {
    const k = knobs[rule.id] || {};
    return {
      ...rule,
      query: k.buy || rule.query,
      fatBands: k.fatBands || rule.fatBands,
      maxKrPerKg: k.maxKrPerKg === undefined ? rule.maxKrPerKg : k.maxKrPerKg,
      maxFatPct: k.maxFatPct === undefined ? rule.maxFatPct : k.maxFatPct,
      avoid: k.never || rule.avoid,
      // Extra queries worth trying when Namlig is out of the preferred one: the profile
      // lists them per protein, so an out-of-stock item becomes a swap, not a miss.
      alt: [...(rule.alt || []), ...(k.alt || [])],
    };
  })];
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
    // The ceiling on packs of one product in one basket. Ten 5 g packs of a spice is not
    // a shop, it is a parsing mistake; the line is left out instead of multiplied.
    maxPacksPerLine: num(raw.maxPacksPerLine, 4, 1, 20),
    stableWords: stable || ["æg", "ris", "pasta", "mel", "sukker", "kaffe", "the", "pulver",
      "konserves", "tørret", "toilet", "køkkenrulle", "serviet", "sæbe", "fryse", "bouillon", "havregryn"],
    freshWords: Array.isArray(raw.freshWords) && raw.freshWords.length > 0
      ? raw.freshWords.map((w) => String(w))
      : ["mælk", "fløde", "smør", "yoghurt", "ost", "fisk", "laks", "ørken", "rejer", "musling", "filet",
         "hakket", "kogt", "stegt", "spinat", "salat", "urter", "persille", "dild", "agurk", "tomat",
         "peberfrugt", "svamp", "avocado", "banan", "æble", "pære", "melon"],
    // How much one PART of a recipe's unit weighs, for a family who reads it differently:
    // "fed" (a garlic clove) is 5 g in the code default. Only a lower-case word of 2-14
    // letters and a weight between 1 g and 2 kg are accepted, so a typo in a profile
    // cannot make the planner weigh a clove at 500 g.
    pieceWeights: Object.fromEntries(
      Object.entries(raw.pieceWeights || {})
        .filter(([w, g]) => /^[\p{L}]{2,14}$/u.test(String(w).trim()) && Number(g) > 0 && Number(g) <= 2000)
        .map(([w, g]) => [String(w).trim().toLowerCase(), Number(g)])),
    // Cooking protein by the pack: some families scale a main protein to more than the
    // recipe gram (one 500 g pack a night). 1 keeps the recipe amount, so a family that
    // says nothing is sized exactly as before. Only a word on this list scales: a
    // topping nobody named (bacon, kebab, sausage) never grows.
    proteinNightFactor: num(raw.proteinNightFactor, 1, 1, 3),
    proteinScaleWords: Array.isArray(raw.proteinScaleWords)
      ? raw.proteinScaleWords.slice(0, 30).map((w) => String(w).toLowerCase())
      : [],
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
    pool: normalizePool(readJson(`${dir}/recipe-pool.json`, { pool: [] })),
    dinners: readJson(`${dir}/dinners.json`, { dinners: [] }),
    // A missing pantry.json means no breakfast and no lunch-box lines, not a crash:
    // nothing in this repository writes that file, so a fresh clone has none.
    pantry: normalizePantry(readJson(`${dir}/pantry.json`, { blocks: {}, cycleDays: 30 })),
    pantryExists: existsSync(`${dir}/pantry.json`),
    blockPeople: blockPeopleOf(profile, householdOf(profile)),
  };
}
