// recipes.mjs — put the dinner recipe card itself into the basket.
//
//   POST https://www.nemlig.com/webapi/basket/AddRecipeToBasket
//        { RecipeId: "<guid>", NumberOfPeople: 5 }
//
// Verified on this account on 2026-11-11: the response is the full basket, and
// GetBasket then carries `Recipes[]` with `RecipeLineItems` (Namlig's own product
// pick for that recipe, scaled to NumberOfPeople). The recipe GUID is not in the
// recipe page — only its Umbraco number is. It comes from the search API, which the
// MCP wraps: search_products returns a `Recipes` array whose entries carry `Id`.
//
// A recipe card adds products. Our plan already adds better ones, and AddToBasket
// sets an ABSOLUTE quantity, so the order matters: add the card first, then let
// plan items overwrite the quantity, then zero out the lines the family profile
// rejects. That is what `--write` does.
//
//   node recipes.mjs                    dry run: cards, GUIDs and what they would add
//   node recipes.mjs --write --approve I-APPROVE-THIS-BASKET
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { connectGated } from "./lib.mjs";
import { login } from "./auth.mjs";

import { HOME as BASE } from "./paths.mjs";
const PLAN = `${BASE}/data/plans/plan-latest.json`;
const ID_CACHE = `${BASE}/data/recipe-ids.json`;
const APPROVE = "I-APPROVE-THIS-BASKET";
const MAX_SEARCH = 8;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** The Umbraco number at the end of a recipe URL, e.g. ".../kaalruller-saeson-98002578". */
export function recipeNumber(urlName) {
  const m = /-(\d{6,9})$/.exec(String(urlName || "").split("?")[0]);
  return m ? m[1] : null;
}

/** Ask the search API for a recipe by name and take the GUID of the matching URL. */
export async function findRecipeId(mcp, name, urlName) {
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

async function main() {
  const write = process.argv.includes("--write");
  const approved = process.argv.includes("--approve")
    && process.argv[process.argv.indexOf("--approve") + 1] === APPROVE;
  const plan = readJson(PLAN, null);
  if (!plan?.dinnerMenu?.length) throw new Error(`no dinnerMenu in ${PLAN} - run plan.mjs first`);

  // A card write is never retried: the same card twice in a basket is worse than a retry.
  const { mcp } = await connectGated({ concurrency: 1, minIntervalMs: 350, attempts: 1 });
  const dishes = await resolvePlanRecipes(mcp, plan);
  console.log(`Recipes in the plan (${plan.dinnerMenu.length}):`);
  for (const d of dishes) {
    console.log(`  dag ${d.days}: ${d.name} -> ${d.guid ? d.guid : `MISS ${d.why}`}`);
  }
  const missing = dishes.filter((d) => !d.guid).length;
  if (missing) console.log(`WARNING: ${missing} recipe GUID(s) unresolved.`);
  if (!write) {
    console.log("Dry run: nothing was added. Add --write --approve " + APPROVE + " to write.");
    return;
  }
  if (!approved) throw new Error(`refusing to write without --approve ${APPROVE}`);

  const people = Number(plan.options?.people || 5);
  const session = await login();
  for (const d of dishes.filter((x) => x.guid)) {
    const res = await session.post("/webapi/basket/AddRecipeToBasket", {
      RecipeId: d.guid,
      NumberOfPeople: people,
    });
    console.log(`add "${d.name}" for ${people}: HTTP ${res.status}`);
    if (res.status < 200 || res.status >= 300) console.log(`  ${res.text.slice(0, 200)}`);
  }
  const basket = await session.get("/webapi/basket/GetBasket");
  const lines = recipeLines(basket.body);
  console.log(`Basket now holds ${lines.length} recipe line items across ${(basket.body?.Recipes || []).length} card(s).`);
  console.log("Next: run apply.mjs so plan quantities and the family profile overwrite them.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
