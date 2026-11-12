#!/usr/bin/env node
// pick-recipe-pool.mjs — turn the mined recipes into the dinner rotation this family uses.
//
// Inputs:
//   data/recipe-candidates.json  Namlig recipes of MAX 35 min with Hovedret tag (mine-recipe-pool.mjs)
//   data/recipes-raw.jsonl       the recipes we have actually ordered (mine-recipes-fetch.mjs)
//   data/recipes-analysis.json   what we buy from each of those, and what we leave out
//   data/staples.json            the 842 products this family buys
//
// Output: profiles/recipe-pool.json — 21 dinners, spread over the proteins, each one with
// its ingredients and the reason it was picked. The planner rotates over this file.
//
// The score answers one question: will we actually cook this with the products we buy?
//   + a history order is proof, so it weighs most
//   + a high share of ingredients we really buy
//   - fresh herbs and ingredients we never buy, because they are thrown away

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mainProtein, dishFormat, clashWith } from "./similarity.mjs";

import { HOME as BASE } from "./paths.mjs";
const CANDIDATES = BASE + "/data/recipe-candidates.json";
const HISTORY_RECIPES = BASE + "/data/recipes-raw.jsonl";
const ANALYSIS = BASE + "/data/recipes-analysis.json";
const STAPLES = BASE + "/data/staples.json";
const OUT = BASE + "/profiles/recipe-pool.json";

const POOL_SIZE = 21;
const MAX_HISTORY_MINUTES = 45;
const PROTEIN_CAPS = { oksekod: 6, kylling: 5, svinepolse: 4, fisk: 4, vegetar: 3, ostaeq: 2 };
// The point of the pool is rotation, so proven dishes cannot fill it on their own.
const MAX_PROVEN = 13;
const MIN_FRESH = 8;
const FRESH_MIN_BUYABLE = 70;
const FRESH_MAX_MINUTES = 30;

// Pantry things every recipe asks for and nobody buys for a single dinner.
const PANTRY_WORDS = ["salt", "peber", "olie", "vand", "sukker", "bouillon", "mel", "smor", "eddik", "sennep", "majones", "ketchup", "hvidlog", "ingefar", "hvidlog"];
// Fresh herbs this family does not use; they wilt in the fridge and go in the bin.
// Bought for other meals, never for a recipe: the planner leaves them out of a recipe.
const HERB_WORDS = ["persille", "purløg", "forårsløg", "koriander", "basilikum", "mynte", "dild", "rosmarin", "timian", "salvie", "dragon"];
// Products absent from the family's own order history. Folded form, because fold() rewrites
// Danish letters before the comparison. A recipe that asks for one of these is odd for
// the household that reads this file, and the odd item is not put in the basket.
const ODD_WORDS = ["capers", "kapers", "bla ost", "gorgonzola", "roquefort", "stilton", "prosciutto", "nduja", "ymer", "kvaerk", "quinoa", "kamut", "kikaerter", "linser", "granataeble", "feta", "lyonnais", "chioggia", "røget ost", "vindruer", "truffel", "trøffel", "vafrer", "røgede oste"];

const fold = (s) => String(s || "").toLowerCase().replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const READ_JSONL = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);

/** Protein family: similarity.mjs is the only place that knows how a dish is judged. */
const proteinOf = mainProtein;

/** Ingredients we buy, as a folded vocabulary from the history and the staple list. */
function boughtVocabulary(analysis, staples) {
  const words = new Set();
  const add = (s) => { for (const w of fold(s).split(" ")) if (w.length > 3) words.add(w); };
  for (const r of (analysis && analysis.recipes) || []) for (const i of r.ingredients || []) {
    if ((i.boughtOrders || 0) > 0) { add(i.text); for (const s of i.skus || []) add(s.name); }
  }
  for (const x of ((analysis && analysis.summary) || {}).extras || []) add(x.name);
  for (const s of (Array.isArray(staples) ? staples : []).slice(0, 400)) add(s.name);
  return words;
}

const wordInVocabulary = (text, vocab) => {
  const ws = fold(text).split(" ").filter((w) => w.length > 3);
  if (ws.length === 0) return true;
  return ws.some((w) => [...vocab].some((v) => v.startsWith(w) || w.startsWith(v)));
};

const countsOf = (text, list) => list.filter((w) => fold(text).includes(fold(w))).length;
const isPantry = (text) => countsOf(text, PANTRY_WORDS) > 0;
const isHerb = (text) => countsOf(text, HERB_WORDS) > 0;
const isOdd = (text) => countsOf(text, ODD_WORDS) > 0;

/** Score one recipe and keep the reasons, so the choice is explainable. */
function scoreRecipe(r, analysisBy, vocab) {
  const hist = analysisBy.get(r.url);
  const ingredients = (r.ingredients || []).filter((i) => i.text);
  const useful = ingredients.filter((i) => !isPantry(i.text));
  const herbs = useful.filter((i) => isHerb(i.text)).map((i) => i.text);
  const odd = useful.filter((i) => isOdd(i.text)).map((i) => i.text);
  const reasons = [];
  let score = 0;
  const historyOrders = r.orders || (hist ? hist.orders : 0);
  if (historyOrders > 0) {
    score += Math.min(30, historyOrders * 6);
    reasons.push(`ordered ${historyOrders} time(s) by this family`);
    if (hist) {
      const bought = hist.ingredients.filter((i) => i.boughtOrders > 0 && !isPantry(i.text)).length;
      const total = hist.ingredients.filter((i) => !isPantry(i.text)).length || 1;
      const pct = Math.round((bought / total) * 100);
      score += pct / 10;
      reasons.push(`${pct}% of its ingredients are products we actually buy`);
    }
  }
  const buyable = useful.length ? useful.filter((i) => wordInVocabulary(i.text, vocab)).length / useful.length : 0;
  score += buyable * 8;
  if (historyOrders === 0) reasons.push(`new to this family; ${Math.round(buyable * 100)}% of its ingredients are products this family already buys`);
  if ((r.minutes || 99) <= 25) { score += 3; reasons.push(`${r.minutes} min, a weeknight dish`); }
  if (herbs.length) { score -= 2 * herbs.length; reasons.push(`uses fresh herbs (${herbs.join(", ")}), which we leave out`); }
  if (odd.length) { score -= 1.5 * odd.length; reasons.push(`asks for ${odd.join(", ")}, an odd buy for two adults and a child`); }
  return {
    score: Number(score.toFixed(2)), reasons, herbs, odd,
    buyablePct: Math.round(buyable * 100),
    historyOrders,
    ingredientCount: ingredients.length,
  };
}

/** Take the best dishes under the protein caps, at most `provenLimit` of them proven. */
function takeUnderCaps(list, pool, used, provenLimit, provenInPool, roundLimit = POOL_SIZE) {
  const skipped = [];
  for (const s of list) {
    if (pool.length >= Math.min(POOL_SIZE, roundLimit)) break;
    const p = s.protein || (s.protein = proteinOf(s));
    if ((used[p] || 0) >= (PROTEIN_CAPS[p] ?? 3)) { skipped.push(s); continue; }
    // Same format and same protein is the same dinner in another wrapper: keep one.
    const clash = clashWith(pool, s);
    if (clash) { skipped.push(s); console.log(`  same dinner  drop "${String(s.name).trim()}" - "${String(clash.name).trim()}" is the same dish`); continue; }
    const proven = (s.historyOrders || 0) > 0;
    if (proven && provenInPool.count >= provenLimit) { skipped.push(s); continue; }
    used[p] = (used[p] || 0) + 1;
    if (proven) provenInPool.count++;
    pool.push(s);
  }
  return skipped;
}

/** Build the pool: fresh dishes first up to MIN_FRESH, then the proven favourites. */
function selectPool(scored) {
  for (const s of scored) { s.protein = proteinOf(s); s.format = dishFormat(s); }
  const fresh = scored.filter((s) => !s.historyOrders && s.coverageBuyablePct >= FRESH_MIN_BUYABLE && (s.minutes || 99) <= FRESH_MAX_MINUTES && s.oddAsks.length === 0);
  const proven = scored.filter((s) => s.historyOrders > 0);
  const rest = scored.filter((s) => !fresh.includes(s) && !proven.includes(s));
  const pool = [], used = {};
  const provenInPool = { count: 0 };
  const freshQuota = Math.max(MIN_FRESH, POOL_SIZE - MAX_PROVEN);
  takeUnderCaps(fresh, pool, used, MAX_PROVEN, provenInPool, freshQuota);
  const freshCount = pool.length;
  takeUnderCaps(proven, pool, used, MAX_PROVEN, provenInPool);
  takeUnderCaps(fresh, pool, used, MAX_PROVEN, provenInPool);
  takeUnderCaps(rest, pool, used, POOL_SIZE, provenInPool);
  takeUnderCaps([...proven, ...fresh, ...rest].sort((a, b) => b.score - a.score), pool, used, POOL_SIZE, provenInPool);
  console.log(`Fresh dishes in the pool: ${freshCount} of ${fresh.length} accepted candidates (min ${MIN_FRESH}).`);
  return pool;
}

function main() {
  const cand = JSON.parse(readFileSync(CANDIDATES, "utf8"));
  const history = READ_JSONL(HISTORY_RECIPES);
  const analysis = JSON.parse(readFileSync(ANALYSIS, "utf8"));
  const staples = JSON.parse(readFileSync(STAPLES, "utf8"));
  const analysisBy = new Map((analysis.recipes || []).map((r) => [r.url, r]));
  const vocab = boughtVocabulary(analysis, staples);

  // History recipes that are quick enough join the search candidates.
  const by = new Map();
  for (const r of cand.recipes) by.set(r.url, { ...r, header: r.name, fromHistory: (r.orders || 0) > 0 });
  for (const h of history) {
    if (by.has(h.url)) continue;
    const minutes = parseInt(String(h.totalTime || "").match(/\d+/g)?.slice(-1)[0] || "0", 10);
    const mins = /time|timer/i.test(h.totalTime || "") ? Math.max(minutes, 60) : minutes;
    if (!mins || mins > MAX_HISTORY_MINUTES) continue;
    by.set(h.url, { url: h.url, name: h.header, minutes: mins, totalTime: h.totalTime, tags: [], servings: h.servings, orders: h.orders || 0, ingredients: h.ingredients || [], fromHistory: true, historyOnly: true });
  }

  const bakes = [], scored = [];
  for (const r of by.values()) {
    const tags = (r.tags || []).map(fold);
    const isBake = tags.some((t) => t.includes("bagvaerk") || /pølsehorn|pizzasnegle|snegle|kage|bolle/.test(fold(r.name)));
    const s = scoreRecipe(r, analysisBy, vocab);
    const row = { url: r.url, name: r.name, minutes: r.minutes || null, totalTime: r.totalTime || "", tags: r.tags || [], servings: r.servings || 4, historyOrders: s.historyOrders, coverageBuyablePct: s.buyablePct, herbsLeftOut: s.herbs, oddAsks: s.odd, score: s.score, reasons: s.reasons, ingredients: (r.ingredients || []).map((i) => ({ text: i.text, amount: i.amount, unit: i.unit, grams: i.grams, litres: i.litres })), fromHistory: !!r.fromHistory };
    if (isBake && row.historyOrders > 0) bakes.push(row);
    else scored.push(row);
  }
  scored.sort((a, b) => b.score - a.score || a.minutes - b.minutes || a.name.localeCompare(b.name, "da"));
  const pool = selectPool(scored);
  const mix = pool.reduce((m, p) => (m[p.protein] = (m[p.protein] || 0) + 1, m), {});
  writeFileSync(OUT, JSON.stringify({
    schemaVersion: 1,
    at: new Date().toISOString(),
    note: "Dinner rotation. One recipe is cooked once and eaten twice, so quantities are scaled to the servings a night this household eats, not to the recipe's own pot.",
    poolSize: pool.length,
    mix,
    proteinCaps: PROTEIN_CAPS,
    freshHerbsLeftOut: HERB_WORDS,
    oddAsksLeftOut: ODD_WORDS,
    pool,
    lunchboxBakes: bakes,
    rejectedSample: scored.slice(POOL_SIZE, POOL_SIZE + 10).map((s) => ({ name: s.name, score: s.score, reasons: s.reasons.slice(-2) })),
  }, null, 1));
  console.log(`Wrote ${OUT}: ${pool.length} dinners, mix ${JSON.stringify(mix)}, lunchbox bakes ${bakes.length}.`);
  for (const p of pool) console.log(`  ${String(p.protein).padEnd(10)} ${String(p.minutes).padStart(3)} min  ${p.name.slice(0, 44).padEnd(46)} hist=${p.historyOrders} buyable=${p.coverageBuyablePct}% score=${p.score}`);
}

main();
