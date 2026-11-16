#!/usr/bin/env node
// mine-menu.mjs — learn the menu from a corrected basket. The dinners whose products are
// still in the basket are liked; the cards in the basket are added to the recipe pool if
// they are new. Read-only for the basket; it writes profiles/recipe-pool.json and
// profiles/taste.json.
//
//   node tools/mine-menu.mjs --snapshot data/plans/basket-before-order-....json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connectGated } from "../lib.mjs";
import { HOME as BASE } from "../paths.mjs";
import { recipeIngredients } from "../recipes.mjs";
import { mainProtein, dishFormat } from "../similarity.mjs";

const POOL = `${BASE}/profiles/recipe-pool.json`;
const TASTE = `${BASE}/profiles/taste.json`;
const CALL_TIMEOUT = 60000;

const fold = (s) => String(s || "").toLowerCase().replace(/[^a-zæøå0-9]+/g, " ").trim();

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

function basketProducts(basket) {
  const set = new Set();
  for (const l of basket.Lines || []) set.add(String(l.Id ?? l.ProductNumber ?? l.ProductId ?? ""));
  for (const r of basket.Recipes || []) {
    for (const l of r.RecipeLineItems || []) set.add(String(l.ProductId ?? l.Id ?? ""));
  }
  set.delete("");
  return set;
}

/** Plan dinners that still have at least one product in the basket. */
export function keptDinners(plan, basket) {
  const have = basketProducts(basket);
  return (plan.dinnerMenu || []).filter((dish) => {
    const items = (plan.items || []).filter((item) =>
      (item.sources || []).some((s) => String(s) === `dinner:${dish.url || dish.id}`));
    if (items.length === 0) return false;
    const present = items.filter((item) => have.has(String(item.sku))).length;
    // A shared sauce or vegetable must not keep a dinner the family removed. More than
    // half of the dinner's own plan lines is the bar; a one-line dinner needs that line.
    return present * 2 > items.length;
  });
}

function pageOf(r) {
  return ((r.content && r.content[0]) || {});
}

function minutesOf(c) {
  const m = /(\d+)\s*min/i.exec(String(c.TotalTime || c.WorkTime || ""));
  return m ? Number(m[1]) : null;
}

function poolEntry(url, found, page) {
  const c = pageOf(page);
  const ing = recipeIngredients(page);
  return {
    url,
    name: found.name || ing.name || url,
    minutes: minutesOf(c),
    totalTime: String(c.TotalTime || "").trim(),
    tags: (c.RecipeTags || []).map((t) => String(t.Name || t)).filter(Boolean),
    servings: ing.servings,
    historyOrders: 0,
    coverageBuyablePct: 100,
    herbsLeftOut: [],
    oddAsks: [],
    score: 20,
    reasons: ["from your corrected basket"],
    ingredients: ing.ingredients.map((i) => ({ ...i, pieces: null })),
    fromHistory: false,
    protein: mainProtein({ name: ing.name, ingredients: ing.ingredients }),
    format: dishFormat({ name: ing.name, ingredients: ing.ingredients }),
  };
}

async function main() {
  const planFile = arg("plan", `${BASE}/data/plans/plan-latest.json`);
  const snapFile = arg("snapshot", "");
  if (!snapFile) throw new Error("--snapshot <basket json> is required");
  const plan = JSON.parse(readFileSync(planFile, "utf8"));
  const basket = JSON.parse(readFileSync(snapFile, "utf8"));
  const pool = JSON.parse(readFileSync(POOL, "utf8"));
  const taste = existsSync(TASTE) ? JSON.parse(readFileSync(TASTE, "utf8")) : { liked: [], refused: [] };
  const liked = new Set(taste.liked || []);
  const byName = new Map((pool.pool || []).map((r) => [fold(r.name), r]));
  const { mcp } = await connectGated({ concurrency: 1, minIntervalMs: 350, attempts: 1 });

  const kept = keptDinners(plan, basket);
  for (const dish of kept) liked.add(dish.url || dish.id);
  console.log(`kept dinners: ${kept.map((d) => d.name).join(", ") || "none"}`);

  for (const card of basket.Recipes || []) {
    const title = String(card.Title || "").trim();
    if (!title) continue;
    const existing = byName.get(fold(title));
    if (existing) { liked.add(existing.url); console.log(`liked: ${existing.name}`); continue; }
    const search = await mcp.call("search_products", { query: title, recipeCount: 5 }, { timeoutMs: CALL_TIMEOUT });
    const recipes = (search.json?.Recipes || []).filter((r) => r && r.Id && r.Url);
    const hit = recipes.find((r) => fold(r.Name) === fold(title)) || recipes[0];
    if (!hit) { console.log(`  miss  recipe "${title}"`); continue; }
    const page = await mcp.call("get_product_details", { productUrl: hit.Url }, { timeoutMs: CALL_TIMEOUT });
    if (page.isError || !page.json) { console.log(`  miss  recipe page "${title}"`); continue; }
    const entry = poolEntry(hit.Url, { name: hit.Name || title }, page.json);
    pool.pool.push(entry);
    byName.set(fold(entry.name), entry);
    liked.add(entry.url);
    console.log(`added to pool: ${entry.name} (${entry.protein}, ${entry.format})`);
  }

  pool.at = new Date().toISOString();
  pool.poolSize = pool.pool.length;
  taste.liked = [...liked];
  taste.refused = taste.refused || [];
  taste.updated = new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false });
  writeFileSync(POOL, JSON.stringify(pool, null, 1) + "\n");
  writeFileSync(TASTE, JSON.stringify(taste, null, 1) + "\n");
  console.log(`pool ${pool.poolSize}, liked ${taste.liked.length}`);
  console.log("The basket was only read. Nothing was added, removed or reserved.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
