// recipes.mjs — choose what a dinner recipe card carries, and read card products back.
//
//   POST https://www.nemlig.com/webapi/basket/AddRecipeToBasket
//        { RecipeId: "<guid>", NumberOfPeople: 5, SelectedProducts: [...] }
//
// The recipe page carries one ProductSelectionId per ingredient. The card API matches on
// that id, so the planner can name the product it wants instead of taking the shop's pick.
// The chosen product is the plan's own line, which is already the cheapest that fits the
// family's rules. A product the basket already holds is left out of the card.
//
// The recipe GUID is not in the page: it comes from search_products, whose `Recipes`
// entries carry `Id`. The basket write lives in apply.mjs; this file is the reading and
// the choice.
//
//   node recipes.mjs                    dry run: cards, GUIDs and what they would carry
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connectGated } from "./lib.mjs";
import { score, tokens, norm, MIN_NAME_SCORE } from "./match.mjs";
import { cleanQuery } from "./dinners.mjs";

import { HOME as BASE, writeJsonAtomic } from "./paths.mjs";
const PLAN = `${BASE}/data/plans/plan-latest.json`;
const ID_CACHE = `${BASE}/data/recipe-ids.json`;
const CARD_CACHE = `${BASE}/data/recipe-cards.json`;
const APPROVE = "I-APPROVE-THIS-BASKET";
const MAX_SEARCH = 8;
const CARD_TIMEOUT = 60000;
const CARD_TTL_MS = 30 * 24 * 3600 * 1000;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** The Umbraco number at the end of a recipe URL, e.g. ".../kaalruller-saeson-98002578". */
function recipeNumber(urlName) {
  const m = /-(\d{6,9})$/.exec(String(urlName || "").split("?")[0]);
  return m ? m[1] : null;
}

/** Ask the search API for a recipe by name and take the GUID of the matching URL. */
async function findRecipeId(mcp, name, urlName) {
  const wanted = String(urlName).split("-").slice(0, 3).join("-").toLowerCase();
  const res = await mcp.call("search_products", { query: name, recipeCount: 5 });
  const text = String(res.text ?? "");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, why: `search for "${name}" returned no JSON` };
  }
  const recipes = (payload?.Recipes || []).filter((r) => r && r.Id && r.Url);
  const hit = recipes.find((r) => String(r.Url).toLowerCase().includes(wanted)) || recipes[0];
  if (!hit) return { ok: false, why: `no recipe in the search results for "${name}"` };
  return { ok: true, id: hit.Id, name: hit.Name, url: hit.Url, minutes: hit.TotalTime || "" };
}

/** GUID for every dinner in the plan, reusing data/recipe-ids.json across runs. */
export async function resolvePlanRecipes(mcp, plan) {
  const cache = readJson(ID_CACHE, {});
  const out = [];
  for (const dish of (plan.dinnerMenu || []).slice(0, MAX_SEARCH)) {
    const number = recipeNumber(dish.url || dish.id);
    const cached = number ? cache[number] : null;
    if (cached?.id) {
      out.push({ ...dish, guid: cached.id, cached: true });
      continue;
    }
    const found = await findRecipeId(mcp, dish.name, dish.url || dish.id);
    if (!found.ok) {
      out.push({ ...dish, guid: null, why: found.why });
      continue;
    }
    if (number) cache[number] = { id: found.id, name: found.name, at: new Date().toISOString() };
    out.push({ ...dish, guid: found.id, cached: false });
  }
  writeFileSync(ID_CACHE, JSON.stringify(cache, null, 1));
  return out;
}

/** What a recipe card would put in the basket, read back from the live basket. */
export function recipeLines(basketBody) {
  return (basketBody?.Recipes || []).flatMap((r) => (r.RecipeLineItems || []).map((l) => ({
    recipe: r.Title,
    productId: l.ProductId ?? l.Id,
    name: l.ProductName ?? l.Name,
    quantity: l.Quantity ?? l.Amount,
  })));
}

/** A numeric field from the page: a dot or a Danish comma, or null when it is not a number. */
function numOf(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** The ingredients a recipe page offers for its product picker. A recipe with no selection
 *  id cannot be filled by the API, so that ingredient is not returned. */
export function recipeIngredients(page) {
  const c = (page?.content && page.content[0]) || {};
  const ingredients = [];
  for (const group of c.IngredientGroups || []) {
    for (const ing of group.Ingredients || []) {
      const selectionId = String(ing.ProductSelectionId || "");
      if (!selectionId) continue;
      ingredients.push({
        selectionId,
        text: String(ing.Text || "").trim(),
        amount: String(ing.Amount || "").trim(),
        unit: String(ing.Unit || "").trim(),
        grams: numOf(ing.MesaureWeightInGram),
        litres: numOf(ing.MeasureMassInLiter),
      });
    }
  }
  return {
    name: String(c.Header || "").trim(),
    servings: Number(c.NumberOfPersons) || null,
    ingredients,
  };
}

/** The family's own word for this ingredient, or the ingredient text itself. */
function aliasedQuery(text, aliases = {}) {
  const cleaned = cleanQuery(String(text || "").split("/")[0].trim(), []);
  const plain = norm(cleaned);
  const hit = Object.entries(aliases || {}).find(([word]) => plain.includes(norm(word)));
  return hit ? String(hit[1]) : cleaned;
}

/**
 * The plan line that answers one recipe ingredient. The recipe often names a cut
 * ("kylling i wok strimler") and the plan names the pack ("Kyllingebrystfilet"), so a
 * plan word that starts with the ingredient's head word counts as the same product.
 * A family alias ("parmesan" is their "Ost E") is applied first.
 */
export function planItemForIngredient(text, planItems, aliases = {}) {
  const cleaned = aliasedQuery(text, aliases);
  let best = null;
  let bestScore = 0;
  for (const item of planItems) {
    const s = score(cleaned, item.name);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  if (bestScore >= MIN_NAME_SCORE) return best;
  const head = tokens(cleaned)[0] || "";
  if (head.length >= 4) {
    const loose = planItems.find((item) => tokens(item.name).some((t) => t.startsWith(head)));
    if (loose) return loose;
  }
  if (head.length >= 6) {
    const stem = head.slice(0, -1);
    return planItems.find((item) => tokens(item.name).some((t) => t.startsWith(stem)
      && Math.abs(t.length - head.length) <= 4)) || null;
  }
  return null;
}

/**
 * Choose what each ingredient selection should carry. The plan's own pick wins, because
 * the plan priced it and the family's rules already chose it. A product already in the
 * basket, or already put on an earlier card, is skipped: nothing is bought twice.
 */
export function cardSelections(recipe, planItems, held = new Map(), used = new Set(), aliases = {}) {
  const selected = [];
  const skipped = [];
  const onRecipe = planItems.filter((item) => (item.sources || [])
    .some((s) => String(s) === `dinner:${recipe.url}`));
  for (const ing of recipe.ingredients) {
    const best = planItemForIngredient(ing.text, onRecipe, aliases);
    if (!best) {
      skipped.push({ text: ing.text, why: "no plan line for it" });
      continue;
    }
    const sku = String(best.sku);
    if (used.has(sku)) {
      skipped.push({ text: ing.text, why: `already on another card as ${best.name}` });
      continue;
    }
    const have = Number(held.get(sku) || 0);
    const need = Math.ceil(Number(best.packs) - have);
    if (need <= 0) {
      skipped.push({ text: ing.text, why: `${best.name} is already in the basket` });
      continue;
    }
    selected.push({
      ProductSelectionId: ing.selectionId,
      ProductSelectionName: best.name,
      ProductId: sku,
      Quantity: need,
      name: best.name,
      ingredient: ing.text,
      why: String(best.why || ""),
    });
    used.add(sku);
  }
  return { selected, skipped, expected: onRecipe.length };
}

/** The body the shop's own recipe dialog sends for a card. IsNem3 false is this card's kind. */
export function cardPayload(recipe, people, selected) {
  return {
    RecipeId: recipe.guid,
    NumberOfPeople: Number(people),
    Sorting: "priceasc",
    SelectedProducts: selected.map((s) => ({
      ProductSelectionId: s.ProductSelectionId,
      ProductSelectionName: s.ProductSelectionName,
      ProductId: s.ProductId,
      Quantity: s.Quantity,
    })),
    SoldOutProducts: [],
    SupplementProducts: [],
    IsNem3: false,
  };
}

/** Selection ids change rarely, so a recipe page is kept for 30 days. A corrupt cache is
 *  an empty cache: the next run fetches the page again. */
export function readCardCache(path = CARD_CACHE) {
  const empty = { at: null, cards: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && parsed.cards && typeof parsed.cards === "object" && !Array.isArray(parsed.cards)
      ? parsed
      : empty;
  } catch {
    return empty;
  }
}

export function writeCardCache(cache, path = CARD_CACHE) {
  cache.at = new Date().toISOString();
  writeJsonAtomic(path, cache);
}

/** The selection ids for one dinner, from the cache or the recipe page the MCP renders. */
export async function recipeForCard(mcp, dish, cache, now = Date.now()) {
  const url = dish.url || dish.id;
  const key = recipeNumber(url) || dish.guid || String(url);
  const hit = cache.cards[key];
  const fresh = hit && Array.isArray(hit.ingredients) && hit.ingredients.length > 0
    && hit.url === url && now - Date.parse(hit.at) < CARD_TTL_MS;
  if (fresh) return { ok: true, ...hit, cached: true };
  const r = await mcp.call("get_product_details", { productUrl: url }, { timeoutMs: CARD_TIMEOUT });
  if (r.isError || !r.json) return { ok: false, why: `recipe page for "${dish.name}" could not be read` };
  const page = recipeIngredients(r.json);
  if (page.ingredients.length === 0) {
    return { ok: false, why: `recipe page for "${dish.name}" lists no selectable ingredient` };
  }
  const entry = { url, guid: dish.guid, at: new Date(now).toISOString(), ...page };
  cache.cards[key] = entry;
  return { ok: true, ...entry, cached: false };
}

async function main() {
  const plan = readJson(PLAN, null);
  if (!plan?.dinnerMenu?.length) throw new Error(`no dinnerMenu in ${PLAN} - run plan.mjs first`);

  const { mcp } = await connectGated({ concurrency: 1, minIntervalMs: 350, attempts: 1 });
  const dishes = await resolvePlanRecipes(mcp, plan);
  console.log(`Recipes in the plan (${plan.dinnerMenu.length}):`);
  for (const d of dishes) {
    console.log(`  dag ${d.days}: ${d.name} -> ${d.guid ? d.guid : `MISS ${d.why}`}`);
  }
  const missing = dishes.filter((d) => !d.guid).length;
  if (missing) console.log(`WARNING: ${missing} recipe GUID(s) unresolved.`);
  if (process.argv.includes("--write")) {
    console.log("REFUSED: apply.mjs owns the basket write, and it chooses each product from the plan.");
    console.log("Run: node apply.mjs --approve " + APPROVE);
    process.exitCode = 3;
    return;
  }
  console.log("Dry run: nothing was added.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
