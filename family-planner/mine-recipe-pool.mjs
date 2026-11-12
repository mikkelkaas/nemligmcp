#!/usr/bin/env node
// mine-recipe-pool.mjs — collect Namlig recipes that fit how this family cooks.
//
// Sources:
//   - the search gateway returns a Recipes block (name, url, TotalTime, Tags, servings)
//     for any query, with recipeCount up to 50;
//   - the order history says which recipes we have actually ordered (order-lines-raw.jsonl);
//   - the recipe page (get_product_details on a /opskrifter/ path) gives the ingredients.
//
// Filters for this family: Tags contains Hovedret, TotalTime at or under MAX_MINUTES,
// and the recipe must be scalable (AllowedForNumberOfPersons covers 5).
//
// Output: data/recipe-candidates.json — candidates with history counts and ingredients.
// Safety: read-only MCP calls.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connectGated } from "./lib.mjs";

import { HOME as BASE } from "./paths.mjs";
const OUT = BASE + "/data/recipe-candidates.json";
const LINES = BASE + "/data/order-lines-raw.jsonl";
const RECIPE_PAGE = BASE + "/data/recipes-raw.jsonl";
const CALL_TIMEOUT = 60000;
const DELAY_MS = 300;
const MAX_MINUTES = 35;
const RECIPE_COUNT = 20; // the MCP schema caps recipeCount at 20
const TAKE = 3;

// Queries that cover the proteins and dishes this family buys, from the order history.
const QUERIES = [
  "pasta", "kylling", "oksekød", "hakket oksekød", "fisk", "hvidfisk", "svinekød", "ris", "nudler",
  "suppe", "gryderet", "pizza", "lasagne", "wok", "taco", "karry", "kødsovs", "kartofler", "grøntsager",
  "vegetar", "rejer", "skinke", "ost", "æg", "pandekager", "frikadeller", "pølse", "bacon", "curry", "salat",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "45 min" -> 45, "1 time" -> 60, "1 t 15 min" -> 75, "20-30 min" -> 30. null if unknown. */
function minutesOf(text) {
  const s = String(text || "").toLowerCase();
  const range = s.match(/(\d+)\s*-\s*(\d+)/);
  if (range) return Number(range[2]);
  const mins = s.match(/(\d+)\s*min/);
  const hours = s.match(/(\d+)\s*(time|timer|t)\b/);
  const h = hours ? Number(hours[1]) * 60 : 0;
  if (mins) return h + Number(mins[1]);
  if (h) return h;
  return null;
}

/** How many times each recipe url appears in the order history. */
function historyCounts() {
  const map = new Map();
  if (!existsSync(LINES)) return map;
  for (const line of readFileSync(LINES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    for (const l of row.lines || []) {
      if (l.IsRecipeLine && l.RecipeUrl) map.set(l.RecipeUrl, (map.get(l.RecipeUrl) || 0) + 1);
    }
  }
  return map;
}

/** Ingredients already fetched for the recipes we order, keyed by url. */
function knownPages() {
  const map = new Map();
  if (!existsSync(RECIPE_PAGE)) return map;
  for (const line of readFileSync(RECIPE_PAGE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    if (j.url) map.set(j.url, j);
  }
  return map;
}

async function main() {
  const { mcp } = await connectGated({ minIntervalMs: 0 });
  const orders = historyCounts();
  const pages = knownPages();
  const by = new Map();
  let searches = 0;
  for (const q of QUERIES) {
    let r;
    try {
      r = await mcp.call("search_products", { query: q, take: TAKE, recipeCount: RECIPE_COUNT }, { timeoutMs: CALL_TIMEOUT });
    } catch (e) {
      console.log(`  search "${q}" failed: ${String(e.message).slice(0, 70)}`);
      await sleep(DELAY_MS);
      continue;
    }
    searches++;
    const list = (r.json && r.json.Recipes) || [];
    let kept = 0;
    for (const rec of list) {
      const url = String(rec.Url || "");
      const tags = Array.isArray(rec.Tags) ? rec.Tags : [];
      const minutes = minutesOf(rec.TotalTime);
      if (!url.startsWith("/opskrifter/")) continue;
      if (!tags.includes("Hovedret")) continue;
      if (minutes === null || minutes > MAX_MINUTES) continue;
      const allowed = Array.isArray(rec.AllowedForNumberOfPersons) ? rec.AllowedForNumberOfPersons : [];
      if (allowed.length && !allowed.includes(5)) continue;
      kept++;
      const e = by.get(url) || {
        url, name: String(rec.Name || "").trim(), author: rec.Author || "", totalTime: String(rec.TotalTime || "").trim(),
        minutes, tags, servings: Number(rec.NumberOfPersons) || null, scalable: allowed.includes(5),
        queries: new Set(), orders: orders.get(url) || 0,
      };
      e.queries.add(q);
      by.set(url, e);
    }
    console.log(`  "${q}": ${list.length} recipes, ${kept} fit`);
    await sleep(DELAY_MS);
  }

  // Ingredients for every candidate we do not already have stored.
  const need = [...by.values()].filter((c) => !pages.has(c.url));
  console.log(`Candidates: ${by.size} from ${searches} searches. Pages to fetch: ${need.length}.`);
  let fetched = 0;
  for (const c of need) {
    let r = null;
    try {
      r = await mcp.call("get_product_details", { productUrl: c.url }, { timeoutMs: CALL_TIMEOUT });
      const j = JSON.parse(r.text);
      const content = (j.content && j.content[0]) || {};
      c.ingredients = [];
      for (const g of content.IngredientGroups || []) {
        for (const ing of g.Ingredients || []) {
          c.ingredients.push({
            text: String(ing.Text || "").trim(), amount: String(ing.Amount || "").trim(), unit: String(ing.Unit || "").trim(),
            grams: ing.MesaureWeightInGram == null ? null : Number(ing.MesaureWeightInGram),
            litres: ing.MeasureMassInLiter == null ? null : Number(ing.MeasureMassInLiter),
          });
        }
      }
      c.workTime = String(content.WorkTime || "").trim();
      c.instructions = String(content.Instructions || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      fetched++;
      if (fetched % 10 === 0) console.log(`  pages ${fetched}/${need.length}`);
    } catch (e) {
      c.ingredientError = String(e.message).slice(0, 90);
    }
    await sleep(DELAY_MS);
  }

  // Reuse the stored pages for the recipes we already order.
  for (const c of by.values()) {
    const p = pages.get(c.url);
    if (p && !c.ingredients) {
      c.ingredients = p.ingredients;
      c.workTime = p.workTime;
      c.instructions = p.instructions;
      c.fromHistoryStore = true;
    }
  }

  const out = [...by.values()]
    .map((c) => ({ ...c, queries: [...c.queries], ingredientCount: (c.ingredients || []).length }))
    .sort((a, b) => b.orders - a.orders || a.minutes - b.minutes || a.name.localeCompare(b.name, "da"));
  writeFileSync(OUT, JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), maxMinutes: MAX_MINUTES, queries: QUERIES, recipes: out }, null, 1));
  console.log(`Wrote ${OUT}: ${out.length} candidates (${out.filter((c) => c.orders > 0).length} ordered before, ${fetched} pages fetched now).`);
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
