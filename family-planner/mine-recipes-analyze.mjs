#!/usr/bin/env node
// mine-recipes-analyze.mjs — compare Namlig's recipe with what this family bought.
//
// Inputs (produced by mine-history.mjs, mine-recipes.mjs, mine-recipes-fetch.mjs):
//   data/order-lines-raw.jsonl   raw order lines; a recipe line carries RecipeUrl
//   data/recipes-raw.jsonl       the recipe page: ingredients, servings, times
//   data/staples.json            how often each sku is bought and in which amount
//
// Output:
//   data/recipes-analysis.json   machine-readable findings (the planner reads this)
//   data/recipes-analysis.md     the same findings as a readable report
//
// Four questions, answered with the order history:
//   1. Which ingredients of a recipe do we buy, and which do we leave out?
//   2. What do we buy instead of the meat or cheese the recipe asks for?
//   3. What do we add that is in no recipe at all?
//   4. How much do we buy, for 2 adults and 1 child, when the recipe says 4 persons?
//
// Ingredient matching is looser than product matching in match.mjs: a recipe writes
// "Spaghetti" and we buy "Fuldkornsspaghetti øko.", and Danish writes both as one word.

import { readFileSync, writeFileSync } from "node:fs";
import { norm } from "./match.mjs";
import { parsePack } from "./units.mjs";

import { HOME as BASE } from "./paths.mjs";
const LINES = BASE + "/data/order-lines-raw.jsonl";
const RECIPES = BASE + "/data/recipes-raw.jsonl";
const STAPLES = BASE + "/data/staples.json";
const OUT_JSON = BASE + "/data/recipes-analysis.json";
const OUT_MD = BASE + "/data/recipes-analysis.md";

const FAT_RE = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*%/;
const MIN_CONTAIN = 5;
const READ_JSONL = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);

// Recipe wording to product family, so a named cheese or a cut of meat still matches.
const SYNONYMS = [
  ["parmesan", "grana", "pecorino", "ost"],
  ["piskefløde", "fløde", "madlavningsfløde"],
  ["æggeblommer", "æg", "skrabeæg"],
  ["oksekød", "hakket oksekød", "oksekød", "forloin", "entrecote", "hakket"],
  ["kylling", "kyllingebryst", "kyllingelår", "kyllingekød", "kalkun"],
  ["svinekød", "flæsk", "marineret", "svinekammek", "nokler", "bacon"],
  ["fisk", "fiskefars", "hvidfisk", "laks", "torsk", "sej", "mørksej", "kummel"],
  ["pølse", "medisterpølse", "pølser"],
  ["tortilla", "tortilladeller", "wraps"],
];

/** Fold Danish letters so compound words can be compared as plain substrings. */
function fold(s) {
  return norm(s).replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a").replace(/kh/g, "k");
}

/** One meaningful word list, lower case, with the recipe's filler words removed. */
function words(s) {
  const filler = new Set(["kogte", "rÅ", "rå", "snittede", "frosne", "friske", "hakket", "revet", "tern", "skiver", "stk", "ca", "drys", "til", "kogevandet", "rigeligt", "salt", "peber", "olie", "smør", "buljong", "terning", "terninger", "the", "tsk", "spsk", "dl", "ml", "g", "kg", "l", "stk."]);
  return fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !filler.has(w));
}

/** True when the recipe word and the product name describe the same thing. */
function wordAccepts(recipeWord, nameWord) {
  if (recipeWord === nameWord) return true;
  const short = recipeWord.length <= nameWord.length ? recipeWord : nameWord;
  const long = recipeWord.length <= nameWord.length ? nameWord : recipeWord;
  // Danish writes compounds as one word: "spaghetti" is inside "fuldkornsspaghetti".
  if (short.length >= MIN_CONTAIN && long.includes(short)) return true;
  // Short staples (aeg, ost, ris, loeg, fisk) only count at the start or the end of a
  // compound, so "aeg" matches "skrabeaeg" but never "laegkage".
  if (short.length >= 3 && (long.endsWith(short) || long.startsWith(short))) return true;
  if (short.length >= 4 && long.startsWith(short.slice(0, Math.max(4, Math.floor(short.length * 0.7))))) return true;
  return false;
}

/** True when any synonym family covers both sides. */
function synonymAccepts(recipeText, nameText) {
  const a = fold(recipeText), b = fold(nameText);
  for (const family of SYNONYMS) {
    if (family.some((w) => a.includes(fold(w))) && family.some((w) => b.includes(fold(w)))) return true;
  }
  return false;
}

/** Confidence 0..1 that a recipe ingredient is this purchased line. */
function matchScore(ingredient, line) {
  const iw = words(ingredient.text), lw = words(line.name);
  if (iw.length === 0 || lw.length === 0) return 0;
  const hits = iw.filter((w) => lw.some((n) => wordAccepts(w, n))).length;
  const coverage = hits / iw.length;
  const synonym = synonymAccepts(ingredient.text, line.name);
  // The recipe's head word (first word) is the product; the rest is a description.
  const headOk = lw.some((n) => wordAccepts(iw[0], n));
  if (hits === 0 && !synonym) return 0;
  let s = Math.max(coverage, headOk ? 0.8 : 0, synonym ? 0.8 : 0);
  if (coverage > 0) s = Math.min(1, s + 0.2 * coverage);
  return Number(s.toFixed(2));
}

/** Best purchased line for an ingredient, or null when nothing fits. */
function bestLineFor(ingredient, lines) {
  let best = null;
  for (const l of lines) {
    const s = matchScore(ingredient, l);
    if (s > 0 && (!best || s > best.score)) best = { line: l, score: s };
  }
  return best && best.score >= 0.75 ? best : null;
}

/** Fat band, organic flag and price per kg for a purchased meat or fish line. */
function meatInfo(line) {
  const fat = FAT_RE.exec(line.name);
  const pack = parsePack(line.desc || "");
  const kg = pack.qty !== null && pack.unit === "g" ? pack.qty / 1000
    : pack.qty !== null && pack.unit === "kg" ? pack.qty : null;
  return {
    sku: line.sku, name: line.name, group: line.group, qty: line.qty,
    fat: fat ? `${fat[1]}-${fat[2]}%` : null,
    organic: /øko|økolog|okolog/i.test(line.name),
    brand: String(line.name).split(/[\s(]/)[0],
    packKg: kg === null ? null : Number(kg.toFixed(3)),
    perKg: kg && line.price > 0 ? Number((line.price / kg).toFixed(2)) : null,
  };
}

const isMeat = (line) => /kød|fjerkræ|fisk|pålæg|skald|rejer|flæsk|skinke|bacon|pølse/i.test(String(line.group || "") + " " + String(line.name || ""));

/** Join one order: its recipes' ingredients against its purchased products. */
function joinOrder(order, recipesByUrl) {
  const urls = [...new Set((order.lines || []).filter((l) => l.IsRecipeLine && l.RecipeUrl).map((l) => l.RecipeUrl))];
  const bought = (order.lines || []).filter((l) => l.IsProductLine && !l.IsRecipeLine)
    .map((l) => ({
      sku: String(l.ProductNumber), name: l.ProductName, qty: Number(l.Quantity) || 0,
      group: l.GroupName || "", desc: l.Description || "", price: Number(l.AverageItemPrice) || 0,
    }));
  const used = new Set();
  const recipes = [];
  for (const url of urls) {
    const r = recipesByUrl.get(url);
    if (!r) continue;
    const covered = [], missing = [];
    for (const ing of r.ingredients) {
      const hit = bestLineFor(ing, bought);
      if (hit) {
        used.add(hit.line.sku);
        covered.push({ text: ing.text, amount: ing.amount, unit: ing.unit, grams: ing.grams, litres: ing.litres, sku: hit.line.sku, name: hit.line.name, qty: hit.line.qty, price: hit.line.price, desc: hit.line.desc, confidence: hit.score });
      } else missing.push({ text: ing.text, amount: ing.amount, unit: ing.unit, grams: ing.grams, litres: ing.litres });
    }
    recipes.push({ url, header: r.header, servings: r.servings, totalTime: r.totalTime, covered, missing });
  }
  return {
    orderId: order.orderId, iso: order.iso,
    recipes,
    extras: bought.filter((l) => !used.has(l.sku)).map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, group: l.group })),
    meats: bought.filter(isMeat).map(meatInfo),
  };
}

/** Per recipe and per ingredient: how many of its orders actually bought it. */
function accumulate(joined) {
  const by = new Map();
  for (const o of joined) {
    for (const r of o.recipes) {
      const e = by.get(r.url) || { url: r.url, header: r.header, servings: r.servings, totalTime: r.totalTime, orders: 0, ingredients: new Map(), extras: new Map(), meatPicks: [] };
      e.orders++;
      for (const c of r.covered) {
        const i = e.ingredients.get(c.text) || { text: c.text, amount: c.amount, unit: c.unit, grams: c.grams, litres: c.litres, bought: 0, qtys: [], prices: [], skus: new Map() };
        i.bought++;
        i.qtys.push(c.qty);
        if (c.price > 0) i.prices.push(c.price);
        const s = i.skus.get(c.sku) || { name: c.name, desc: c.desc, n: 0 };
        s.n++;
        i.skus.set(c.sku, s);
        e.ingredients.set(c.text, i);
      }
      for (const m of r.missing) {
        if (!e.ingredients.has(m.text)) e.ingredients.set(m.text, { text: m.text, amount: m.amount, unit: m.unit, grams: m.grams, litres: m.litres, bought: 0, qtys: [], prices: [], skus: new Map() });
      }
      for (const x of o.extras) {
        const k = norm(x.name);
        const p = e.extras.get(k) || { name: x.name, group: x.group, n: 0 };
        p.n++;
        e.extras.set(k, p);
      }
      for (const m of o.meats) e.meatPicks.push({ iso: o.iso, ...m });
      by.set(r.url, e);
    }
  }
  return by;
}

/** Ingredient rows sorted by how often we buy them. */
function ingredientsOf(e) {
  return [...e.ingredients.values()].map((i) => ({
    text: i.text, amount: i.amount, unit: i.unit, grams: i.grams, litres: i.litres,
    boughtOrders: i.bought, boughtPct: Math.round((i.bought / e.orders) * 100),
    medianPacks: median(i.qtys), medianPrice: median(i.prices),
    skus: [...i.skus.values()].sort((a, b) => b.n - a.n).slice(0, 3),
  })).sort((a, b) => b.boughtOrders - a.boughtOrders || a.text.localeCompare(b.text, "da"));
}

function writeMd(recipes, joined, agg) {
  const L = [];
  const at = new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false });
  L.push(`# Recipe analysis — ${at} (Europe/Copenhagen)`, "");
  L.push(`Orders with a recipe: ${joined.filter((o) => o.recipes.length).length} of ${joined.length}. Recipes: ${recipes.length}. Ingredient match threshold: 0.75 confidence, Danish compounds folded, synonym families applied.`);
  L.push("", "## Recipe usage", "", "| recipe | orders | Namlig servings | time | ingredients bought | left out |", "|---|---|---|---|---|---|");
  for (const r of recipes) {
    const yes = r.ingredients.filter((i) => i.boughtOrders > 0).length;
    L.push(`| ${r.header} | ${r.orders} | ${r.servings} | ${r.totalTime} | ${yes}/${r.ingredients.length} | ${r.neverBought.length} |`);
  }
  L.push("", "## Ingredients left out in 2 or more recipes", "");
  for (const x of agg.leftOut.filter((x) => x.n >= 2).slice(0, 45)) L.push(`- ${x.name} — left out in ${x.n} recipe(s)`);
  L.push("", "## Added outside any recipe (top 25)", "");
  for (const x of agg.extras.slice(0, 25)) L.push(`- ${x.name} (${x.group}) — ${x.n} order(s)`);
  L.push("", "## Meat, poultry and fish we buy in recipe orders", "", "| product | group | fat | øko | buys | median kr/kg | median packs |", "|---|---|---|---|---|---|---|");
  for (const m of agg.meat.slice(0, 40)) L.push(`| ${m.name} | ${m.group} | ${m.fat || "-"} | ${m.organic ? "yes" : "no"} | ${m.buys} | ${m.medianPerKg === null ? "-" : m.medianPerKg.toFixed(1)} | ${m.medianPacks} |`);
  L.push("", "## What a recipe asks for a protein, and what we put in the basket", "", "| recipe | asks for | we buy | orders |", "|---|---|---|---|");
  for (const row of agg.proteinPairs.slice(0, 40)) L.push(`| ${row.recipe} | ${row.ask} | ${row.buy} | ${row.n} |`);
  writeFileSync(OUT_MD, L.join("\n") + "\n");
}

/** Aggregate the cross-recipe views the report and the planner profiles need. */
function summarise(joined, shaped) {
  const leftOut = new Map(), extras = new Map(), meats = new Map(), proteinPairs = new Map();
  for (const o of joined) {
    for (const x of o.extras) {
      const k = norm(x.name);
      const e = extras.get(k) || { name: x.name, group: x.group, n: 0 };
      e.n++;
      extras.set(k, e);
    }
    for (const m of o.meats) {
      const k = norm(m.name);
      const e = meats.get(k) || { name: m.name, group: m.group, fat: m.fat, organic: m.organic, buys: 0, perKg: [], packs: [] };
      e.buys++;
      if (m.perKg !== null) e.perKg.push(m.perKg);
      e.packs.push(m.qty);
      meats.set(k, e);
    }
    for (const r of o.recipes) {
      for (const c of r.covered) {
        if (!isMeat({ group: "", name: c.text })) continue;
        const k = `${r.url}|${norm(c.text)}|${c.sku}`;
        const e = proteinPairs.get(k) || { recipe: r.header, ask: c.text, buy: c.name, n: 0 };
        e.n++;
        proteinPairs.set(k, e);
      }
    }
  }
  for (const r of shaped) for (const t of r.neverBought) {
    const k = norm(t);
    const e = leftOut.get(k) || { name: t, n: 0 };
    e.n++;
    leftOut.set(k, e);
  }
  const meat = [...meats.values()].map((m) => ({ ...m, medianPerKg: median(m.perKg), medianPacks: median(m.packs) })).sort((a, b) => b.buys - a.buys);
  // Per ingredient word: how many of our recipes ask for it, and how many of those we
  // actually put in the basket. A word with 0 bought is a word we do not use.
  const wordCoverage = new Map();
  for (const r of shaped) {
    for (const i of r.ingredients) {
      const w = norm(i.text).split(" ")[0];
      if (!w || w.length < 3) continue;
      const e = wordCoverage.get(w) || { word: w, askedRecipes: 0, boughtRecipes: 0, gramsSum: 0 };
      e.askedRecipes++;
      if (i.boughtOrders > 0) e.boughtRecipes++;
      e.gramsSum += Number(i.grams) || 0;
      wordCoverage.set(w, e);
    }
  }
  return {
    wordCoverage: [...wordCoverage.values()].sort((a, b) => b.askedRecipes - a.askedRecipes),
    leftOut: [...leftOut.values()].sort((a, b) => b.n - a.n),
    extras: [...extras.values()].sort((a, b) => b.n - a.n),
    meat,
    proteinPairs: [...proteinPairs.values()].sort((a, b) => b.n - a.n),
  };
}

function main() {
  const orders = READ_JSONL(LINES);
  const recipesByUrl = new Map(READ_JSONL(RECIPES).map((r) => [r.url, r]));
  const joined = orders.map((o) => joinOrder(o, recipesByUrl));
  const acc = accumulate(joined);
  const shaped = [...acc.values()].map((e) => {
    const ingredients = ingredientsOf(e);
    return {
      url: e.url, header: e.header, servings: e.servings, totalTime: e.totalTime, orders: e.orders,
      ingredients,
      neverBought: ingredients.filter((i) => i.boughtOrders === 0).map((i) => i.text),
      sometimesBought: ingredients.filter((i) => i.boughtOrders > 0 && i.boughtPct < 60).map((i) => i.text),
      extras: [...e.extras.values()].sort((a, b) => b.n - a.n).slice(0, 12),
      meatPicks: e.meatPicks,
    };
  }).sort((a, b) => b.orders - a.orders || a.header.localeCompare(b.header, "da"));
  const agg = summarise(joined, shaped);
  writeMd(shaped, joined, agg);
  const staples = JSON.parse(readFileSync(STAPLES, "utf8"));
  writeFileSync(OUT_JSON, JSON.stringify({
    schemaVersion: 2,
    at: new Date().toISOString(),
    orders: orders.length,
    ordersWithRecipe: joined.filter((o) => o.recipes.length).length,
    recipes: shaped,
    summary: agg,
    staples: (Array.isArray(staples) ? staples : []).filter((s) => s.orders >= 8)
      .map((s) => ({ sku: s.sku, name: s.name, orders: s.orders, medianQty: s.medianQty, meanQty: s.meanQty, medianUnitPrice: s.medianUnitPrice, packSize: s.packSize, lastOrder: s.lastOrder }))
      .sort((a, b) => b.orders - a.orders),
  }, null, 1));
  console.log(`Wrote ${OUT_JSON} and ${OUT_MD}`);
  console.log(`Orders with recipe: ${joined.filter((o) => o.recipes.length).length}/${orders.length} | recipes: ${shaped.length} | meat rows: ${agg.meat.length} | protein pairs: ${agg.proteinPairs.length}`);
}

main();
