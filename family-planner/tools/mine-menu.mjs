#!/usr/bin/env node
// mine-menu.mjs — learn the menu from a corrected basket. The dinners whose products are
// still in the basket are liked; the cards in the basket are added to the recipe pool if
// they are new. Read-only for the basket; it writes profiles/recipe-pool.json and
// profiles/taste.json.
//
//   node tools/mine-menu.mjs --snapshot data/plans/basket-before-order-....json
import { readFileSync, existsSync } from "node:fs";
import { connectGated } from "../lib.mjs";
import { recipeIngredients } from "../recipes.mjs";
import { mainProtein, dishFormat } from "../similarity.mjs";
import { score } from "../match.mjs";
import { HOME as BASE, writeJsonAtomic } from "../paths.mjs";

const POOL = `${BASE}/profiles/recipe-pool.json`;
const CANDIDATES = `${BASE}/data/recipe-candidates.json`;
const TASTE = `${BASE}/profiles/taste.json`;
const CALL_TIMEOUT = 60000;

const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-zæøå0-9]+/g, " ").trim();

/** Compare recipe URLs by their /opskrifter/<slug> tail, ignoring host, query
 *  and a trailing slash. */
function urlKey(value) {
  const raw = String(value || "").split("?")[0].replace(/\/+$/, "");
  const m = /\/opskrifter\/[^/]+$/.exec(raw);
  return m ? m[0] : raw;
}

/** The pool entry that answers a planned dinner, by url or by folded name. */
function poolEntryFor(dish, pool) {
  const keys = [dish.url, dish.id].filter(Boolean).map(urlKey);
  return (pool || []).find((r) => keys.includes(urlKey(r.url)))
    || (pool || []).find((r) => fold(r.name) === fold(dish.name)) || null;
}

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
  const cards = Array.isArray(basket.Recipes) ? basket.Recipes : [];
  if (cards.length > 0) {
    // The basket names the cards it holds. A shared ingredient (bacon, eggs, cheese)
    // must not keep a dinner whose card the family removed. Id, Url and Title are all
    // matched because a card can carry a GUID where the plan carries a URL.
    const ids = new Set(cards.flatMap((c) => [c.Id, c.Url]).filter(Boolean).map(urlKey));
    const titles = new Set(cards.map((c) => fold(c.Title || c.Name || "")).filter(Boolean));
    return (plan.dinnerMenu || []).filter((dish) =>
      ids.has(urlKey(dish.url || dish.id)) || ids.has(urlKey(dish.id)) || titles.has(fold(dish.name)));
  }
  const have = basketProducts(basket);
  return (plan.dinnerMenu || []).filter((dish) => {
    const items = (plan.items || []).filter((item) =>
      (item.sources || []).some((s) => urlKey(String(s).replace(/^dinner:/, "")) === urlKey(dish.url || dish.id)));
    if (items.length === 0) return false;
    // A line no other dinner shares is the signature. Without one, the card list is the
    // only proof; shared bacon and eggs cannot tell which dinner the family kept.
    const unique = items.filter((item) => (item.sources || []).filter((s) => String(s).startsWith("dinner:")).length === 1);
    if (unique.length === 0) return false;
    const uniquePresent = unique.filter((item) => have.has(String(item.sku))).length;
    return uniquePresent * 2 > unique.length;
  });
}

function pageOf(r) {
  return ((r.content && r.content[0]) || {});
}

function minutesOf(c) {
  const m = /(\d+)\s*min/i.exec(String(c.TotalTime || c.WorkTime || ""));
  return m ? Number(m[1]) : null;
}

/** Keep the library at its stated size: liked first, then score. A new card can
 *  therefore never push out a favourite. */
export function capPool(entries, liked, cap) {
  const sorted = [...entries].sort((a, b) => (liked.has(b.url) ? 1 : 0) - (liked.has(a.url) ? 1 : 0)
    || (Number(b.score) || 0) - (Number(a.score) || 0));
  return { pool: sorted.slice(0, cap), dropped: sorted.slice(cap) };
}

export function poolEntry(url, found, page) {
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
    protein: mainProtein({ name: ing.name, url, ingredients: ing.ingredients }),
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
  const cand = existsSync(CANDIDATES) ? JSON.parse(readFileSync(CANDIDATES, "utf8")) : { schemaVersion: 1, recipes: [] };
  cand.recipes = Array.isArray(cand.recipes) ? cand.recipes : [];
  const taste = existsSync(TASTE) ? JSON.parse(readFileSync(TASTE, "utf8")) : { liked: [], refused: [] };
  const liked = new Set(taste.liked || []);
  // A corrected basket is the verdict on the plan it came from: a dinner the family
  // removed is no longer liked, even if an older basket once kept it. Remove every
  // spelling of its key, because the plan carries GUIDs and the pool carries URLs.
  for (const dish of plan.dinnerMenu || []) {
    const hit = poolEntryFor(dish, pool.pool);
    liked.delete(dish.url || dish.id);
    liked.delete(dish.id);
    if (hit) liked.delete(hit.url);
  }
  const byName = new Map((pool.pool || []).map((r) => [fold(r.name), r]));
  // Connect only when a card is not already in the library. A corrected basket of known
  // cards is a local operation and must work with the shop offline.
  let mcp = null;
  const client = async () => {
    if (!mcp) ({ mcp } = await connectGated({ concurrency: 1, minIntervalMs: 350, attempts: 1 }));
    return mcp;
  };

  const kept = keptDinners(plan, basket);
  for (const dish of kept) {
    const hit = poolEntryFor(dish, pool.pool);
    liked.add(hit ? hit.url : (dish.url || dish.id));
  }
  const keptNames = new Set(kept.map((d) => d.name));
  const dropped = (plan.dinnerMenu || []).filter((d) => !keptNames.has(d.name)).map((d) => d.name);
  console.log(`kept dinners: ${kept.map((d) => d.name).join(", ") || "none"}`);
  if (dropped.length) console.log(`dropped dinners: ${dropped.join(", ")}`);

  for (const card of basket.Recipes || []) {
    const title = String(card.Title || "").trim();
    if (!title) continue;
    const existing = (pool.pool || []).find((r) => urlKey(r.url) === urlKey(card.Url || card.Id || ""))
      || byName.get(fold(title));
    if (existing) {
      liked.add(existing.url);
      if (!cand.recipes.some((r) => String(r.url) === String(existing.url))) {
        cand.recipes.push({
          url: existing.url, name: existing.name, author: "nemlig", totalTime: existing.totalTime,
          minutes: existing.minutes, tags: existing.tags, servings: existing.servings, scalable: true,
          queries: [], orders: Number(existing.historyOrders) || 0, ingredients: existing.ingredients,
        });
        console.log(`added to candidates: ${existing.name}`);
      }
      console.log(`liked: ${existing.name}`);
      continue;
    }
    const conn = await client();
    const search = await conn.call("search_products", { query: title, recipeCount: 5 }, { timeoutMs: CALL_TIMEOUT });
    const recipes = (search.json?.Recipes || []).filter((r) => r && r.Id && r.Url);
    const cardUrl = String(card.Url || "");
    const ranked = recipes.map((r) => ({ r, s: score(title, r.Name) }))
      .sort((a, b) => b.s - a.s || (String(a.r.Url) === cardUrl ? -1 : 0));
    if (ranked.length === 0 || ranked[0].s < 0.7) {
      console.log(`  miss  no recipe name close enough to "${title}"`);
      continue;
    }
    const hit = ranked[0].r;
    const page = await conn.call("get_product_details", { productUrl: hit.Url }, { timeoutMs: CALL_TIMEOUT });
    if (page.isError || !page.json) { console.log(`  miss  recipe page "${title}"`); continue; }
    const pageIngredients = recipeIngredients(page.json);
    if (pageIngredients.ingredients.length === 0) {
      console.log(`  miss  recipe page "${title}" has no selectable ingredients`);
      continue;
    }
    const entry = poolEntry(hit.Url, { name: hit.Name || title }, page.json);
    pool.pool.push(entry);
    byName.set(fold(entry.name), entry);
    liked.add(entry.url);
    // A later pick-recipe-pool rebuilds from this file, not from the pool. A new recipe
    // that lives only in the pool is dropped by the next rebuild.
    if (!cand.recipes.some((r) => String(r.url) === String(entry.url))) {
      cand.recipes.push({
        url: entry.url, name: entry.name, author: "nemlig", totalTime: entry.totalTime,
        minutes: entry.minutes, tags: entry.tags, servings: entry.servings, scalable: true,
        queries: [], orders: 0, ingredients: entry.ingredients,
      });
      console.log(`added to candidates: ${entry.name}`);
    }
    console.log(`added to pool: ${entry.name} (${entry.protein}, ${entry.format})`);
  }

  // Keep the library at its stated size. A liked dish is kept before an unliked one; the
  // rest is the picker's score. This also means a new card cannot grow the pool to 23.
  const cap = Number(pool.limits && pool.limits.poolSize) || Number(pool.poolSize) || 21;
  if (pool.pool.length > cap) {
    const capped = capPool(pool.pool, liked, cap);
    pool.pool = capped.pool;
    console.log(`pool capped at ${cap}; dropped ${capped.dropped.map((r) => r.name).join(", ")}`);
  }
  pool.at = new Date().toISOString();
  pool.poolSize = pool.pool.length;
  cand.at = new Date().toISOString();
  cand.maxMinutes = Math.max(Number(cand.maxMinutes) || 0, 30);
  taste.liked = [...liked];
  // A card the family put in the basket is not refused, whatever an older run said.
  taste.refused = (taste.refused || []).filter((u) => !liked.has(u));
  taste.updated = new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false });
  if (process.argv.includes("--dry")) {
    console.log("Nothing written (--dry).");
    return;
  }
  writeJsonAtomic(POOL, pool);
  writeJsonAtomic(CANDIDATES, cand);
  writeJsonAtomic(TASTE, taste);
  console.log(`pool ${pool.poolSize}, liked ${taste.liked.length}`);
  console.log("The basket was only read. Nothing was added, removed or reserved.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
