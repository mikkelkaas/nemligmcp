#!/usr/bin/env node
// mine-recipes-fetch.mjs — save the recipe page of every recipe that appears in the
// order history, so the planner can compare Namlig's recipe with what we bought.
//
// Channel: the Namlig MCP renders any namely.com page as JSON when it is given the
// path with get_product_details. A recipe path returns the RecipePage (ingredients,
// servings, times, instructions), a product path returns the product page.
//
// Safety: read-only MCP calls. Nothing is written to the basket.
// Input:  data/order-lines-raw.jsonl (from mine-recipes.mjs)
// Output: data/recipes-raw.jsonl, one JSON object per recipe url, appended, resumable.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "./lib.mjs";

import { HOME as BASE } from "./paths.mjs";
const LINES = BASE + "/data/order-lines-raw.jsonl";
const OUT = BASE + "/data/recipes-raw.jsonl";
const CALL_TIMEOUT = 60000;
const DELAY_MS = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Recipe urls used in the history, newest usage first. */
function wantedRecipes() {
  if (!existsSync(LINES)) throw new Error("run mine-recipes.mjs first: " + LINES + " is missing");
  const by = new Map();
  for (const line of readFileSync(LINES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    for (const l of row.lines || []) {
      if (!l.IsRecipeLine || !l.RecipeUrl) continue;
      const url = String(l.RecipeUrl);
      const e = by.get(url) || { url, recipeId: l.RecipeId, orders: new Set(), lastIso: "" };
      e.orders.add(String(row.orderId));
      if (String(row.iso) > e.lastIso) e.lastIso = String(row.iso);
      by.set(url, e);
    }
  }
  return [...by.values()]
    .map((e) => ({ url: e.url, recipeId: e.recipeId, orders: e.orders.size, lastIso: e.lastIso }))
    .sort((a, b) => b.orders - a.orders || b.lastIso.localeCompare(a.lastIso));
}

function doneUrls() {
  if (!existsSync(OUT)) return new Set();
  const set = new Set();
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.url) set.add(j.url);
    } catch { /* ignore a half-written tail line */ }
  }
  return set;
}

/** Pull the fields the planner needs out of the Sitecore recipe page. */
function recipeOf(json, meta) {
  const c = (json.content && json.content[0]) || {};
  const groups = c.IngredientGroups || [];
  const ingredients = [];
  for (const g of groups) {
    for (const ing of g.Ingredients || []) {
      ingredients.push({
        group: g.Name || String(g.GroupId || ""),
        text: String(ing.Text || "").trim(),
        amount: String(ing.Amount || "").trim(),
        unit: String(ing.Unit || "").trim(),
        grams: ing.MesaureWeightInGram == null ? null : Number(ing.MesaureWeightInGram),
        litres: ing.MeasureMassInLiter == null ? null : Number(ing.MeasureMassInLiter),
        pieces: ing.MeasurePieces == null ? null : Number(ing.MeasurePieces),
        selectionId: ing.ProductSelectionId || null,
      });
    }
  }
  return {
    url: meta.url,
    recipeId: c.RecipeId || meta.recipeId || null,
    header: c.Header || json.MetaData?.NavigationTitle || "",
    servings: Number(c.NumberOfPersons) || null,
    servingsAllowed: Array.isArray(c.AllowedForNumberOfPersons) ? c.AllowedForNumberOfPersons : null,
    scalable: c.IsLockedForNumberOfPersons !== true,
    workTime: String(c.WorkTime || "").trim(),
    totalTime: String(c.TotalTime || "").trim(),
    isBundle: !!c.IsBundle,
    bundleHeading: c.BundleHeading || "",
    instructions: String(c.Instructions || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    groups: groups.map((g) => g.Name || String(g.GroupId || "")),
    ingredients,
    orders: meta.orders,
    lastIso: meta.lastIso,
    fetchedAt: new Date().toISOString(),
  };
}

async function main() {
  const wanted = wantedRecipes();
  const have = doneUrls();
  const todo = wanted.filter((r) => !have.has(r.url));
  console.log(`Recipes in history: ${wanted.length}, stored: ${have.size}, to fetch: ${todo.length}`);
  if (todo.length === 0) return;
  const { mcp } = await connect();
  let ok = 0;
  const failed = [];
  for (const r of todo) {
    let res = null;
    try {
      res = await mcp.call("get_product_details", { productUrl: r.url }, { timeoutMs: CALL_TIMEOUT });
    } catch (e) {
      failed.push({ url: r.url, error: String(e.message).slice(0, 100) });
      console.log(`  fail ${r.url.slice(0, 50)}: ${String(e.message).slice(0, 70)}`);
      await sleep(DELAY_MS);
      continue;
    }
    let json = null;
    try { json = JSON.parse(res.text); } catch { json = null; }
    if (res.isError || !json || !json.content) {
      failed.push({ url: r.url, error: (res.text || "no json").slice(0, 100) });
      console.log(`  fail ${r.url.slice(0, 50)}: ${(res.text || "no json").slice(0, 70)}`);
      await sleep(DELAY_MS);
      continue;
    }
    appendFileSync(OUT, JSON.stringify(recipeOf(json, r)) + "\n");
    ok++;
    if (ok % 10 === 0) console.log(`  stored ${ok}/${todo.length}`);
    await sleep(DELAY_MS);
  }
  console.log(`Fetched ${ok} recipe(s), failed ${failed.length}.`);
  if (failed.length) console.log("Failed: " + failed.map((f) => f.url).join(" "));
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
