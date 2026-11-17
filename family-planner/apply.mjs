#!/usr/bin/env node
// apply.mjs — write an APPROVED plan into the real Namlig basket. This is the only
// script in this folder that changes anything, and it refuses to run without the
// approval token that plan.mjs prints.
//
// Usage:
//   node apply.mjs [--plan data/plans/plan-latest.json] [--approve I-APPROVE-THIS-BASKET]
//                  [--slot <timeslotId>] [--keep-going]
//
// Guarantees:
//   - keep-and-top-up only: it never clears the basket and never removes a line.
//   - quantities are absolute (Namlig semantics) and take the larger of what the
//     basket already holds and what the plan asked for.
//   - the basket is re-read first, so a plan built an hour ago cannot overwrite
//     something you added in the app in the meantime.
//   - every add is verified against a fresh get_basket at the end.
//
// Order of operations, because Namlig's AddToBasket sets an ABSOLUTE quantity:
//   1. the recipe cards go in first, with the plan's chosen products. A product the
//      basket already holds is left out of the card, so a card never buys twice;
//   2. a card product short of the plan's quantity is topped up. The shop writes the
//      difference as a line, so the plan's total stands;
//   3. the plan writes only products no card covers;
//   4. a card product the plan does not want (fresh herbs, pantry staples, another
//      brand) is set to 0. A line that was in the basket before the cards is never
//      touched, so what you added in the app stays.
// The shop scales a card's own pack count by people, so the card is set to the recipe's
// own servings. The household's extra portions become the difference line in step 2.
// Use --recipes no to skip the cards.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { connect, loadEnv, Limiter, sleep, reportFailure, warnUnknownFlags } from "./lib.mjs";
import { login } from "./auth.mjs";
import { resolvePlanRecipes, recipeLines, recipeForCard, readCardCache, writeCardCache, cardSelections, cardPayload } from "./recipes.mjs";
import { loadFamily } from "./family.mjs";
import { score, MIN_NAME_SCORE } from "./match.mjs";

import { HOME as BASE, writeJsonAtomic, withLock } from "./paths.mjs";
// What this script understands, so a typo in a flag is named instead of ignored.
const APPLY_FLAGS = ["plan", "approve", "slot", "family", "recipes", "keep-going", "ignore-unresolved", "allow-stale", "help", "debug"];
const TOKEN = "I-APPROVE-THIS-BASKET";
const CALL_TIMEOUT = 60000;
// A write is never retried automatically: a lost answer to add_to_basket must not become
// two of the same product. The gate only paces the writes and ends a stuck run.
// The deadline is a clock time, not a duration: the limiter compares it with Date.now().
function writeGate() {
  return { concurrency: 1, minIntervalMs: 350, attempts: 1, deadlineAtMs: Date.now() + 10 * 60 * 1000 };
}
// Recipe cards go through the shop's own web API with its own session, so the gate above
// does not reach them. They keep their own fixed spacing.
const WEB_STEP_DELAY_MS = 350;

/** Two decimals, for a kr amount the shop reported. */
function round2(n) {
  return Number(Number(n).toFixed(2));
}


/** A flag that takes a value refuses a missing one. Silently falling back to the default
 *  plan path after `--plan` with no value is how a typo writes the wrong basket. */
function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

/** One product a recipe card brought, in the shape the card path uses. The field names
 *  matter: recipeLines returns productId and quantity, and a wrong read here leaves every
 *  card line with no sku and no quantity, so no decision can be made about it. */
export function cardLineOf(line) {
  return {
    sku: String(line.productId ?? ""),
    name: String(line.name ?? ""),
    qty: Number(line.quantity ?? 0),
  };
}

/** The products that sit inside recipe cards, keyed by sku. A card product is not a basket
 *  line: it lives under Recipes[].RecipeLineItems and the same sku can arrive on two cards. */
function cardProductsOf(json) {
  const map = new Map();
  for (const line of recipeLines(json).map(cardLineOf)) {
    if (!line.sku) continue;
    const prev = map.get(line.sku);
    map.set(line.sku, prev ? { ...prev, qty: prev.qty + line.qty } : line);
  }
  return map;
}

/** Read the live basket into a map of sku -> { qty, name }, plus the card products.
 *  The map holds Lines only, because that is what a quantity write acts on. */
async function basketMap(mcp) {
  const b = await mcp.call("get_basket", {}, { timeoutMs: CALL_TIMEOUT });
  if (b.isError) throw new Error("get_basket failed: " + b.text.slice(0, 200));
  const json = b.json || {};
  const map = new Map();
  for (const l of json.Lines || []) {
    const sku = String(l.ProductNumber ?? l.ProductId ?? l.Id ?? "");
    if (sku) map.set(sku, { sku, name: l.Name || l.ProductName || "", qty: Number(l.Quantity ?? l.Amount ?? 0) });
  }
  return { map, cards: cardProductsOf(json), recipeIds: new Set((json.Recipes || []).map((r) => String(r.Id))), json };
}

/** What the basket holds for a sku: its own line plus what the recipe cards brought. */
function quantityMap(lines, cards) {
  const out = new Map(lines);
  for (const [sku, entry] of cards) {
    const prev = out.get(sku);
    out.set(sku, prev ? { ...prev, qty: prev.qty + entry.qty } : entry);
  }
  return out;
}

/** One write per product: absolute quantity. A plan line that came with a recipe card is
 *  written exactly; anything else only ever goes up. */
async function addOne(mcp, item, existingQty, fromRecipe) {
  const want = wantQtyOf(item, existingQty, fromRecipe);
  if (want === null) return { ok: false, tool: "none", want: 0, error: "planned quantity is not positive" };
  const tool = existingQty > 0 ? "set_basket_quantity" : "add_to_basket";
  const r = await mcp.call(tool, { productId: String(item.sku), quantity: want }, { timeoutMs: CALL_TIMEOUT });
  if (r.isError) return { ok: false, tool, want, error: r.text.slice(0, 200) };
  return { ok: true, tool, want, had: existingQty };
}

/** Add or top up every planned product. Stops at the first failure unless keepGoing. */
async function writeItems(mcp, items, existing, keepGoing, recipeSkus = new Set()) {
  const adds = [];
  const failed = [];
  for (const item of items) {
    const sku = String(item.sku);
    const have = existing.get(sku);
    const existingQty = have ? have.qty : 0;
    const fromRecipe = recipeSkus.has(sku);
    if (!fromRecipe && existingQty >= item.packs) {
      console.log(`  keep  ${String(item.name).slice(0, 42).padEnd(42)} already ${existingQty} >= ${item.packs}`);
      continue;
    }
    const res = await addOne(mcp, item, existingQty, fromRecipe);
    if (!res.ok) {
      failed.push({ sku: item.sku, name: item.name, error: res.error });
      console.log(`  FAIL  ${String(item.name).slice(0, 42).padEnd(42)} ${res.error}`);
      if (!keepGoing) break;
      continue;
    }
    adds.push({ sku: item.sku, name: item.name, packs: item.packs, price: item.price, total: item.total,
      tool: res.tool, had: existingQty, setTo: res.want });
    console.log(`  add   ${String(item.name).slice(0, 42).padEnd(42)} ${existingQty} -> ${res.want} (${res.tool})`);
  }
  return { adds, failed };
}

/** The quantity to write for one plan product. A recipe card's amount is a suggestion,
 *  our plan's amount is the decision: with a card it is written exactly, up or down. */
export function wantQtyOf(item, existingQty, fromRecipe) {
  const packs = Number(item.packs);
  if (!(packs > 0)) return null;
  if (fromRecipe) return packs;
  return Math.max(existingQty, packs);
}

/** The plan item whose name reads most like the card product, or null below the threshold. */
function bestPlanMatch(cardName, planItems) {
  let best = null;
  let bestScore = 0;
  for (const item of planItems) {
    const s = score(cardName, item.name);
    if (s > bestScore) {
      bestScore = s;
      best = item;
    }
  }
  return bestScore >= MIN_NAME_SCORE ? best : null;
}

/**
 * What to do with each product that came with a recipe card. One pass, one decision per
 * sku. The card brings the product when the plan wants that product, the plan's own pick
 * wins when it is another product, and nothing is bought twice.
 * `held` is what the basket already holds as its own Lines, keyed by sku.
 * Pure, so the suite can hand it fake cards, fake plan items and a fake basket.
 */
export function cardDecisions(cardLines, planItems, held = new Map()) {
  const keep = [];
  const zero = [];
  const topUp = [];
  const covered = new Set();
  const seen = new Set();
  for (const line of cardLines) {
    const sku = String(line.sku ?? "");
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    const name = String(line.name ?? "");
    const qty = Number(line.qty ?? 0);
    const exact = planItems.find((item) => String(item.sku) === sku);
    if (exact) {
      const packs = Number(exact.packs);
      const have = Number(held.get(sku) || 0);
      const wantCard = packs - have;
      if (have > 0 && qty > wantCard) {
        // A line already holds the product. Zeroing the card now would remove both, so
        // the over-buy is left alone; the line is the plan's amount.
        keep.push({ sku, name, qty, packs, held: have });
        covered.add(sku);
      } else if (wantCard <= 0 || qty > wantCard) {
        // The card brings more than the plan. Zero it before the plan line is written:
        // no line exists yet, so the zero cannot take a line with it.
        zero.push({ sku, name, why: `the card brings ${qty}, the plan wants ${Math.max(0, wantCard)}: the plan amount goes in a line` });
      } else if (qty === wantCard) {
        keep.push({ sku, name, qty, packs, held: have });
        covered.add(sku);
      } else {
        topUp.push({ sku, name, qty, setTo: wantCard, held: have });
        covered.add(sku);
      }
      continue;
    }
    const best = bestPlanMatch(name, planItems);
    zero.push({
      sku,
      name,
      why: best ? `plan buys it as ${best.name}` : "no plan line for it",
    });
  }
  return { keep, zero, topUp, covered };
}

/** One line per card decision: what happens, to which product, and why. */
function printDecisions(decisions) {
  for (const d of decisions.keep) console.log(`  keep  ${String(d.name).slice(0, 42).padEnd(42)} card ${d.qty} + basket ${d.held} covers ${d.packs}`);
  for (const d of decisions.topUp) console.log(`  topup ${String(d.name).slice(0, 42).padEnd(42)} card ${d.qty} + basket ${d.held}, card target ${d.setTo}`);
  for (const d of decisions.zero) console.log(`  zero  ${String(d.name).slice(0, 42).padEnd(42)} ${d.why}`);
  const total = decisions.keep.length + decisions.topUp.length + decisions.zero.length;
  if (total) console.log(`  card  ${total} decision(s): ${decisions.keep.length} kept, ${decisions.topUp.length} topped up, ${decisions.zero.length} zeroed.`);
}

/** Raise a card product to the plan's quantity. The shop turns the difference into a line
 *  and re-prices the card. Never add_to_basket here: that overwrites the card's own amount. */
async function topUpCardProducts(mcp, topUps, keepGoing) {
  const done = [];
  const failed = [];
  for (const up of topUps) {
    const r = await mcp.call("set_basket_quantity", { productId: up.sku, quantity: up.setTo }, { timeoutMs: CALL_TIMEOUT });
    if (r.isError) {
      failed.push({ sku: up.sku, name: up.name, error: r.text.slice(0, 160) });
      console.log(`  FAIL  ${String(up.name).slice(0, 42).padEnd(42)} could not top up: ${r.text.slice(0, 120)}`);
      if (!keepGoing) break;
      continue;
    }
    done.push(up);
  }
  if (topUps.length) console.log(`  topup ${done.length} of ${topUps.length} card product(s) raised to the plan quantity.`);
  return { done, failed };
}

/**
 * Step 1: put the plan's own products on its dinner recipe cards, then read back exactly
 * what the shop added. A product already in the basket, or on an earlier card, is skipped,
 * so a card never buys a second time.
 */
async function addRecipeCards(mcp, plan, before, aliases = {}, fallbackPeople = 5) {
  const all = await resolvePlanRecipes(mcp, plan);
  for (const miss of all.filter((d) => !d.guid)) {
    console.log(`  miss  recipe card "${miss.name}": ${miss.why}`);
  }
  const dishes = all.filter((d) => d.guid);
  if (dishes.length === 0) return { cards: [], lines: [], cardMoneyKr: 0, skipped: [] };
  const people = Number(plan.options?.people || fallbackPeople || 5);
  const held = new Map([...before.map].map(([sku, e]) => [sku, e.qty]));
  const used = new Set();
  const cache = readCardCache();
  const session = await login();
  const cards = [];
  const skipped = [];
  for (const dish of dishes) {
    if (before.recipeIds.has(String(dish.guid))) {
      const why = "already in the basket, so it was not added twice";
      console.log(`  skip  recipe card "${dish.name}": ${why}`);
      skipped.push({ name: dish.name, why });
      continue;
    }
    const added = await addOneCard({ mcp, session, dish, plan, held, used, cache, people, aliases });
    if (added.card) cards.push(added.card);
    else skipped.push(added.skipped);
    if (added.wait) await sleep(WEB_STEP_DELAY_MS); // the web session is not covered by the MCP gate
  }
  try {
    writeCardCache(cache);
  } catch (e) {
    console.log(`  warn  recipe page cache not saved: ${e.message}`);
  }
  const basket = await session.get("/webapi/basket/GetBasket");
  const body = basket.body || {};
  const lines = recipeLines(body).map(cardLineOf);
  const cardMoneyKr = cardMoneyOf(body);
  console.log(`  card  ${lines.length} product(s) came in with the recipe cards, ${cardMoneyKr} kr in card money.`);
  return { cards, lines, cardMoneyKr, skipped };
}

/** One card: read its selections, name every skip, and post only when a product is left. */
async function addOneCard({ mcp, session, dish, plan, held, used, cache, people, aliases }) {
  let page;
  try {
    page = await recipeForCard(mcp, dish, cache);
  } catch (e) {
    return { skipped: { name: dish.name, why: `recipe page failed: ${e.message}` } };
  }
  if (!page.ok) {
    console.log(`  skip  recipe card "${dish.name}": ${page.why}`);
    return { skipped: { name: dish.name, why: page.why } };
  }
  const recipe = { ...page, url: dish.url || dish.id, guid: dish.guid };
  const picks = cardSelections(recipe, plan.items, held, used, aliases);
  for (const s of picks.skipped) console.log(`  skip  ${String(s.text).slice(0, 30).padEnd(30)} ${s.why}`);
  if (picks.selected.length === 0) {
    const why = "every planned product is already in the basket or on another card";
    console.log(`  skip  recipe card "${dish.name}": ${why}`);
    return { skipped: { name: dish.name, why } };
  }
  // A card with one product out of a recipe is not the recipe. Use the plan lines
  // instead of a half card; the basket is complete either way.
  const share = picks.expected > 0 ? picks.selected.length / picks.expected : 0;
  if (picks.selected.length < 2 || share < 0.5) {
    const why = `only ${picks.selected.length} of ${picks.expected} products could be put on the card; the plan lines are used`;
    console.log(`  skip  recipe card "${dish.name}": ${why}`);
    return { skipped: { name: dish.name, why } };
  }
  // The shop ignores a selected quantity and scales the recipe's own pack count by people.
  // At the recipe's own servings that factor is 1, so the card is not over-bought. The plan's
  // extra portions are written as a difference line by topUpCardProducts.
  const cardPeople = Number(page.servings) || people;
  const payload = cardPayload(recipe, cardPeople, picks.selected);
  const res = await session.post("/webapi/basket/AddRecipeToBasket", payload);
  const ok = res.status >= 200 && res.status < 300;
  const detail = ok
    ? `${picks.selected.length} chosen product(s) at the recipe's ${cardPeople} servings`
    : `FAILED HTTP ${res.status} ${res.text.slice(0, 120)}`;
  console.log(`  card  ${String(dish.name).slice(0, 42).padEnd(42)} ${detail}`);
  if (!ok) return { skipped: { name: dish.name, why: detail } };
  return {
    card: { name: dish.name, url: dish.url || dish.id, guid: dish.guid, ok, products: picks.selected.length, servings: cardPeople, skus: picks.selected.map((s) => String(s.ProductId)), skipped: picks.skipped.length },
    wait: true,
  };
}

/** Step 5: zero the recipe products the plan does not want. Never touches an earlier line. */
async function zeroExtras(mcp, extras, keepGoing) {
  const zeroed = [];
  const failed = [];
  for (const extra of extras) {
    const r = await mcp.call("set_basket_quantity", { productId: extra.sku, quantity: 0 }, { timeoutMs: CALL_TIMEOUT });
    if (r.isError) {
      failed.push({ sku: extra.sku, name: extra.name, error: r.text.slice(0, 160) });
      console.log(`  FAIL  ${String(extra.name).slice(0, 42).padEnd(42)} could not remove: ${r.text.slice(0, 120)}`);
      if (!keepGoing) break;
      continue;
    }
    zeroed.push(extra);
    console.log(`  zero  ${String(extra.name).slice(0, 42).padEnd(42)} ${extra.why || "not in the plan"}`);
  }
  return { zeroed, failed };
}

// Exported for run.mjs, which sets process.argv and calls it in one process after
// planning. It still self-runs only when apply.mjs is the command.
export async function main() {
  // --help answers before anything is read or written: no plan file, no lock, no basket.
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node apply.mjs [--plan data/plans/plan-latest.json] --approve I-APPROVE-THIS-BASKET [--slot <timeslotId>] [--keep-going] [--family <name>] [--ignore-unresolved]");
    console.log("This is the only script that writes to the basket. Without --approve it changes nothing.");
    return;
  }
  warnUnknownFlags(process.argv, APPLY_FLAGS);
  const planPath = arg("plan", BASE + "/data/plans/plan-latest.json");
  const approve = arg("approve", "");
  const slotId = arg("slot", null);
  if (slotId !== null && (!/^\d+$/.test(String(slotId)) || Number(slotId) <= 0)) {
    console.error(`REFUSED: --slot "${slotId}" is not a numeric timeslot id. Run node slots.mjs --days 8 and use its Id.`);
    process.exitCode = 3;
    return;
  }
  const keepGoing = process.argv.includes("--keep-going");
  if (!existsSync(planPath)) throw new Error("no plan file at " + planPath + " — run plan.mjs first");
  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, "utf8"));
  } catch (e) {
    throw new Error(`plan file is not readable JSON (${planPath}): ${e.message}`);
  }
  const problems = validatePlan(plan);
  if (problems.length) {
    console.error(`REFUSED: the plan file does not hold up (${planPath}):`);
    for (const p of problems) console.error("  - " + p);
    console.error("Fix it with a fresh plan.mjs run.");
    process.exitCode = 6;
    return;
  }
  if (approve !== TOKEN) {
    console.error(`REFUSED. This writes to your real basket.`);
    console.error(`Re-run with  --approve ${TOKEN}  after you have read ${planPath}`);
    process.exitCode = 3;
    return;
  }
  const fam = loadFamily({ name: arg("family", null) });
  const household = fam.household;
  if (household.basketPolicy && household.basketPolicy.neverClearBasket !== true) {
    throw new Error(`${fam.file} no longer says basket.neverClearBasket - refusing to guess the policy`);
  }
  const refusal = refusalReason(plan, household.planMaxAgeHours);
  if (refusal) {
    console.error(refusal.text);
    process.exitCode = refusal.code;
    return;
  }

  const defaultCards = household.recipeCards === false ? "no" : "yes";
  const wantCards = arg("recipes", defaultCards) !== "no" && (plan.dinnerMenu || []).length > 0;
  await withLock("apply", () => writeBasket({ plan, planPath, slotId, keepGoing, wantCards, household, fam }));
}

/** The card money the shop reports for every card in the basket. */
function cardMoneyOf(json) {
  return round2(((json || {}).Recipes || []).reduce((sum, r) => sum + (Number(r.RecipeTotalPrice) || 0), 0));
}

/** The shop's own kr amounts beside the plan's total. A null means the shop did not report it. */
function moneyOf(plan, cards, after) {
  const planTotalKr = Number(plan.planTotal);
  const products = after.json.TotalProductsPrice;
  const basketProductsKr = products === null || products === undefined ? NaN : Number(products);
  const known = Number.isFinite(planTotalKr) && Number.isFinite(basketProductsKr);
  return {
    planTotalKr: Number.isFinite(planTotalKr) ? planTotalKr : null,
    cardMoneyKr: round2(cards.cardMoneyKr || 0),
    basketProductsKr: Number.isFinite(basketProductsKr) ? basketProductsKr : null,
    differenceKr: known ? round2(basketProductsKr - planTotalKr) : null,
    overPlan: known && basketProductsKr > planTotalKr * 1.05,
  };
}

/** Everything that touches the live basket, in one bounded sequence. */
async function writeBasket({ plan, planPath, slotId, keepGoing, wantCards, household, fam }) {
  const { mcp } = await connect(loadEnv(), { limiter: new Limiter(writeGate()) });
  const before = await basketMap(mcp);
  console.log(`Basket before: ${before.map.size} line(s), ${before.json.TotalProductsPrice ?? 0} kr products.`);

  // 1. Recipe cards first: their chosen products land in the basket, then one decision each.
  const cards = wantCards
    ? await addRecipeCards(mcp, plan, before, fam.exclusions?.queryAliases?.words || {}, household.people)
    : { cards: [], lines: [], cardMoneyKr: 0, skipped: [] };
  if (!wantCards) console.log("  skip  recipe cards (--recipes no)");

  // 2. What each card product is worth to this plan, beside what the basket already holds.
  const held = new Map([...before.map].map(([sku, e]) => [sku, e.qty]));
  const decisions = cardDecisions(cards.lines, plan.items, held);
  printDecisions(decisions);

  // 3. Top up before the plan writes: add_to_basket would overwrite the card.
  const topUps = await topUpCardProducts(mcp, decisions.topUp, keepGoing);

  // 4. A card product over the plan, or not in it, goes to zero before the plan writes.
  //    No line exists for those yet, so the zero cannot take a line with it.
  const dropped = await zeroExtras(mcp, decisions.zero, keepGoing);
  if (decisions.zero.length) console.log(`  zero  ${dropped.zeroed.length} of ${decisions.zero.length} recipe product(s) the plan does not use or over-buys.`);

  // 5. The plan writes only what a card does not already cover.
  const withCards = cards.lines.length || dropped.zeroed.length ? await basketMap(mcp) : before;
  const failedZero = new Set((dropped.failed || []).map((f) => String(f.sku)));
  const toWrite = plan.items.filter((i) => !decisions.covered.has(String(i.sku))
    && !failedZero.has(String(i.sku)));
  for (const item of plan.items.filter((i) => decisions.covered.has(String(i.sku)))) {
    console.log(`  cover ${String(item.name).slice(0, 42).padEnd(42)} already in the basket with a recipe card`);
  }
  const recipeSkus = new Set(cards.lines.map((l) => String(l.sku)));
  const { adds, failed } = await writeItems(mcp, toWrite, withCards.map, keepGoing, recipeSkus);

  await finishBasket({ mcp, plan, planPath, slotId, before, cards, topUps, dropped, adds, failed, household });
}

/** Read the basket back, verify it, record the shop's money, and print the result. */
async function finishBasket({ mcp, plan, planPath, slotId, before, cards, topUps, dropped, adds, failed, household }) {
  const slot = await pickSlot(mcp, slotId, adds);
  const after = await basketMap(mcp);
  const missing = verificationOf(adds, quantityMap(after.map, after.cards));
  const report = {
    kind: "nemlig-apply",
    at: new Date().toLocaleString("da-DK", { timeZone: household.timezone || "Europe/Copenhagen", hour12: false }) + " (Europe/Copenhagen)",
    planFile: planPath,
    planCreatedAt: plan.createdAt,
    ...moneyOf(plan, cards, after),
    added: adds,
    failed,
    cardTopUps: topUps.done,
    cardTopUpFailed: topUps.failed,
    recipeCards: cards.cards,
    recipeCardsSkipped: cards.skipped || [],
    recipeProducts: cards.lines.length,
    removedFromRecipe: dropped.zeroed,
    recipeRemovalFailed: dropped.failed,
    slot,
    basketBefore: { lines: before.map.size, productsKr: before.json.TotalProductsPrice },
    basketAfter: { lines: after.map.size, productsKr: after.json.TotalProductsPrice, totalPriceKr: after.json.TotalPrice, deliveryKr: after.json.DeliveryPrice, minOrderKr: after.json.MinimumOrderTotal, minOrderMet: after.json.IsMinTotalValid },
    verification: missing.length === 0 ? "all added products present at the planned quantity" : "MISMATCH",
    missing,
  };
  const written = saveReport(report);
  printResult({ adds, failed, after, report, missing, written, cards, dropped, topUps });
  if (failed.length || topUps.failed.length || (slot && slot.isError)) process.exitCode = 1;
}

/** Refuse to write when the plan is not applicable. Returns null when all is well.
 *  Exported for the suite: these two refusals are the last thing between a stale plan and a
 *  real basket, and they are worth testing without anybody's shop. The flags arrive as a
 *  list so a test can hand them over instead of rewriting process.argv. */
export function refusalReason(plan, planMaxAgeHours, argv = process.argv) {
  if ((plan.unresolved || []).length > 0 && !argv.includes("--ignore-unresolved")) {
    const lines = (plan.unresolved || []).map((u) => "  - " + u.query + " (" + u.source + ")").join("\n");
    return { code: 4, text: `REFUSED: ${plan.unresolved.length} intent(s) had no product. Fix them, or pass --ignore-unresolved to add only what was found.\n${lines}` };
  }
  const maxAge = Number(planMaxAgeHours || 12);
  const ageHours = planAgeHours(plan);
  if (argv.includes("--allow-stale")) return null;
  if (ageHours === null) {
    // No readable stamp is not the same as a fresh plan. A plan file is hand-editable, so a
    // stamp can be lost on the way to the shop, and an ancient basket costs real money.
    return { code: 5, text: "REFUSED: this plan carries no readable time stamp, so its age cannot be checked. Run plan.mjs again, or pass --allow-stale." };
  }
  if (ageHours > maxAge) {
    return { code: 5, text: `REFUSED: this plan is ${ageHours.toFixed(1)} h old and Namlig prices change daily. Run plan.mjs again, or pass --allow-stale.` };
  }
  return null;
}

/** Hours since the plan was made. atIso first, because it is an instant. Then the da-DK stamp
 *  the plan file prints for a person to read: that is a wall clock in Copenhagen, and its
 *  punctuation is locale data, so only the digits are trusted. Null when neither can be read:
 *  an unreadable stamp must never look like a plan made a moment ago. The group order here was
 *  wrong once - seven references into six groups - and the age gate went quiet along with it. */
export function planAgeHours(plan) {
  const stamped = Date.parse(String(plan.atIso || ""));
  if (Number.isFinite(stamped)) return (Date.now() - stamped) / 3600000;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\D+(\d{2})[.:](\d{2})[.:](\d{2})/.exec(String(plan.createdAt || ""));
  if (!m) return null;
  // The stamp carries no zone, so compare wall clock with wall clock and use only the
  // difference: "now" in Copenhagen written the same way, and neither instant is claimed.
  const created = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`);
  const now = Date.parse(copenhagenWallClock() + "Z");
  if (!Number.isFinite(created) || !Number.isFinite(now)) return null;
  return (now - created) / 3600000;
}

/** The Copenhagen wall clock as "YYYY-MM-DDTHH:MM:SS", built from parts rather than from a
 *  locale string, because the shape of a locale string is data that can rename its own fields. */
function copenhagenWallClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const of = (type) => { const hit = parts.find((x) => x.type === type); return hit ? hit.value : ""; };
  const hour = of("hour") === "24" ? "00" : of("hour");   // en-GB has been known to call midnight 24
  const stamp = `${of("year")}-${of("month")}-${of("day")}T${hour}:${of("minute")}:${of("second")}`;
  return Number.isFinite(Date.parse(stamp + "Z")) ? stamp : "";
}

/** Book the timeslot the person approved, only after something was actually added. */
/** What the shop said about a timeslot. A 200 with IsReserved false is still a refusal:
 *  the delivery time did not change, and the basket must not be reported as booked. */
export function slotOutcomeOf(response, slotId) {
  const body = response.json || {};
  const reserved = body.IsReserved;
  return {
    id: Number(slotId),
    isError: Boolean(response.isError) || reserved === false,
    reserved: reserved === true,
    text: String(response.text || "").slice(0, 300),
  };
}

async function pickSlot(mcp, slotId, adds) {
  if (!slotId) return null;
  if (adds.length === 0) {
    console.log("  slot  skipped: nothing was added, so the timeslot was not touched");
    return null;
  }
  const id = Number(slotId);
  if (!Number.isInteger(id) || id <= 0) {
    const slot = { id: null, isError: true, reserved: false, text: `not a numeric slot id: ${slotId}` };
    console.log(`  slot  FAILED ${slot.text}`);
    return slot;
  }
  const s = await mcp.call("select_timeslot", { timeslotId: id }, { timeoutMs: CALL_TIMEOUT });
  const slot = slotOutcomeOf(s, id);
  console.log(`  slot  ${slot.isError ? "FAILED (the change would alter the basket - re-plan, then retry, or pass --force in the app) " + slot.text : "selected id " + slot.id}`);
  return slot;
}

/** Re-read the basket and compare every written quantity. */
function verificationOf(adds, afterMap) {
  const missing = [];
  for (const a of adds) {
    const now = afterMap.get(String(a.sku));
    if (!now || now.qty < a.setTo) missing.push({ sku: a.sku, name: a.name, wanted: a.setTo, got: now ? now.qty : 0 });
  }
  return missing;
}

function saveReport(report) {
  mkdirSync(BASE + "/data/plans", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
  const file = BASE + "/data/plans/applied-" + stamp + ".json";
  writeJsonAtomic(file, report);
  return { file, stamp };
}

function printResult({ adds, failed, after, report, missing, written, cards, dropped, topUps }) {
  console.log("");
  console.log(`APPLIED: ${adds.length} product(s) written. Basket now ${after.map.size} lines, ${after.json.TotalProductsPrice ?? "?"} kr products, ${after.json.TotalPrice ?? "?"} kr total (delivery ${after.json.DeliveryPrice ?? "?"} kr).`);
  console.log(`Money: plan ${report.planTotalKr ?? "?"} kr, recipe cards ${report.cardMoneyKr} kr, basket products ${report.basketProductsKr ?? "?"} kr, difference ${report.differenceKr ?? "?"} kr.`);
  if (report.overPlan) {
    console.log(`NOTE: basket products ${report.basketProductsKr} kr is ${report.differenceKr} kr more than the ${report.planTotalKr} kr plan, over 5 percent. Read the card decisions before you confirm.`);
  }
  if (after.json.MinimumOrderTotal && after.json.IsMinTotalValid === false) {
    console.log(`NOTE: minimum order is ${after.json.MinimumOrderTotal} kr and it is not met yet.`);
  }
  if (cards.cards.length) {
    const okCards = cards.cards.filter((c) => c.ok).length;
    console.log(`Recipe cards: ${okCards}/${cards.cards.length} added, ${cards.lines.length} product(s) came with them, ${topUps.done.length} topped up, ${dropped.zeroed.length} removed again.`);
  }
  if ((cards.skipped || []).length) {
    const why = cards.skipped.map((s) => `${s.name}: ${s.why}`).join("; ");
    console.log(`Recipe cards skipped: ${cards.skipped.length} — ${why.slice(0, 300)}`);
  }
  console.log("Verification: " + report.verification + (missing.length ? " — " + missing.map((m) => m.name + " wanted " + m.wanted + " got " + m.got).join("; ") : ""));
  const writeFailures = failed.length + topUps.failed.length;
  if (writeFailures) console.log(`Failed writes: ${writeFailures} — see ${written.file}`);
  console.log("No order was placed. Check the basket in the app, then confirm there.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { reportFailure(e); process.exitCode = 1; });
}

/**
 * Does this plan hold up as a shopping list? Structural checks only, before anything is
 * written: a plan file is hand-editable and a wrong number here becomes a wrong basket.
 * Returns a list of problems; empty means the plan may go to the shop.
 */
export function validatePlan(plan) {
  const problems = [];
  if (!plan || typeof plan !== "object") return ["file is not an object"];
  if (plan.kind !== "nemlig-plan") problems.push(`kind is "${plan.kind}", expected "nemlig-plan"`);
  if (Number(plan.schemaVersion) !== 1) problems.push(`schemaVersion ${plan.schemaVersion} is not 1`);
  if (!Array.isArray(plan.items)) return problems.concat(["items is not a list"]);
  // A plan file is hand-editable. A list that holds null, a string where a list belongs,
  // or a dinner with no name used to crash the card path or the trim sum. Refuse it here,
  // before a single shop call.
  const listProblems = [];
  if (plan.unresolved !== undefined && !Array.isArray(plan.unresolved)) listProblems.push("unresolved is not a list");
  else if (Array.isArray(plan.unresolved) && plan.unresolved.some((u) => !u || typeof u !== "object")) {
    listProblems.push("unresolved holds a line that is not an object");
  }
  if (plan.adds !== undefined && !Array.isArray(plan.adds)) listProblems.push("adds is not a list");
  else if (Array.isArray(plan.adds) && plan.adds.some((a) => !a || typeof a !== "object")) {
    listProblems.push("adds holds a line that is not an object");
  }
  if (plan.dinnerMenu !== undefined && !Array.isArray(plan.dinnerMenu)) listProblems.push("dinnerMenu is not a list");
  else if (Array.isArray(plan.dinnerMenu)) {
    for (const [i, m] of plan.dinnerMenu.entries()) {
      if (!m || typeof m !== "object") { listProblems.push(`dinner ${i + 1} is not an object`); continue; }
      if (!String(m.name || "").trim()) listProblems.push(`dinner ${i + 1}: no name`);
      if (!String(m.url || m.id || "").trim()) listProblems.push(`dinner ${i + 1}: no url or id`);
    }
  }
  if (plan.items.some((it) => !it || typeof it !== "object")) listProblems.push("items holds a line that is not an object");
  if (plan.options !== undefined && (plan.options === null || typeof plan.options !== "object")) {
    listProblems.push("options is not an object");
  } else if (plan.options && plan.options.people !== undefined && !(Number(plan.options.people) >= 1)) {
    listProblems.push(`options.people "${plan.options.people}" is not a positive number`);
  }
  if (listProblems.length) return problems.concat(listProblems);
  if (plan.items.length === 0) problems.push("the plan has no products");
  if (plan.items.length > 400) problems.push(`${plan.items.length} products is more than one basket should hold`);
  const skus = new Map();
  for (const [i, it] of plan.items.entries()) {
    const at = `item ${i + 1} (${String(it && it.name || "?").slice(0, 40)})`;
    const sku = String((it && it.sku) || "");
    if (!/^\d{3,10}$/.test(sku)) problems.push(`${at}: sku "${sku}" is not a product number`);
    else if (skus.has(sku)) problems.push(`${at}: sku ${sku} is already planned as "${skus.get(sku)}" — two lines for one product`);
    else skus.set(sku, String(it.name || ""));
    if (!String((it && it.name) || "").trim()) problems.push(`${at}: no name`);
    const packs = Number(it && it.packs);
    if (!Number.isInteger(packs) || packs < 1 || packs > 99) problems.push(`${at}: packs "${it && it.packs}" is not a whole number between 1 and 99`);
    const price = Number(it && it.price);
    if (!Number.isFinite(price) || price < 0 || price > 5000) problems.push(`${at}: price "${it && it.price}" is not a plausible kr amount`);
    const total = Number(it && it.total);
    if (Number.isFinite(price) && Number.isInteger(packs) && Math.abs(total - price * packs) > 0.02) {
      problems.push(`${at}: total ${total} is not ${packs} x ${price}`);
    }
  }
  if (!Number.isFinite(Number(plan.planTotal)) || Number(plan.planTotal) < 0) problems.push("planTotal is missing or negative");
  if (problems.length === 0 && Number.isFinite(Number(plan.planTotal))) {
    // planTotal is what THIS run adds; items is the whole plan. When the basket already
    // holds one of the planned products the two differ by design - keep-and-top-up leaves
    // that line out of the adds - so compare against the list planTotal was made from:
    // the adds when the plan carries them (even an empty list), the items when it does not.
    const basis = Array.isArray(plan.adds) ? plan.adds : plan.items;
    const where = Array.isArray(plan.adds) ? "adds" : "items";
    const sum = Number(basis.reduce((t, it) => t + Number(it.total), 0).toFixed(2));
    if (Math.abs(sum - Number(plan.planTotal)) > 0.5) problems.push(`planTotal ${plan.planTotal} does not match the ${where}, which add up to ${sum}`);
  }
  problems.push(...trimProblems(plan, skus));
  return problems;
}

/**
 * A plan that trimmed itself has to be believed on one point only: the rivals it moved to
 * are really in the basket, the lines it put back really are not, and the money still adds
 * up against the ceiling it says it fitted.
 */
function trimProblems(plan, skus) {
  const problems = [];
  if (plan.trim === undefined || plan.trim === null) return problems;
  if (!Array.isArray(plan.trim)) return ["trim is not a list"];
  const cap = Number(plan.capKr);
  if (plan.trim.length && !(Number.isFinite(cap) && cap > 0)) {
    problems.push(`trim has ${plan.trim.length} move(s) but capKr "${plan.capKr}" is not a number of kroner`);
  }
  for (const [i, t] of plan.trim.entries()) {
    const name = String((t && t.name) || "?").slice(0, 30);
    const at = `trim ${i + 1} (${String((t && t.action) || "?")} ${name})`;
    if (t && t.action === "swap") {
      const from = Number(t.from && t.from.total), to = Number(t.to && t.to.total);
      if (!Number.isFinite(from) || !Number.isFinite(to)) { problems.push(`${at}: the two totals are not both numbers`); continue; }
      if (Math.abs((from - to) - Number(t.savedKr)) > 0.02) problems.push(`${at}: savedKr ${t.savedKr} is not ${from} - ${to}`);
      if (!skus.has(String(t.to && t.to.sku))) problems.push(`${at}: the substitute ${String((t.to && t.to.name) || (t.to && t.to.sku))} is not in the plan`);
      continue;
    }
    if (t && t.action === "defer") {
      if (skus.has(String(t.sku))) problems.push(`${at}: ${name} was put back on the shelf but is still in the plan`);
      continue;
    }
    problems.push(`${at}: not a swap and not a deferral`);
  }
  const itemsSum = Number(plan.items.reduce((sum, it) => sum + Number(it.total), 0).toFixed(2));
  const after = Number(plan.trimAfter);
  if (Number.isFinite(after) && Math.abs(itemsSum - after) > 0.5) {
    problems.push(`trimAfter ${after} is not the ${plan.items.length} planned items, which add up to ${itemsSum}`);
  }
  if (Number.isFinite(cap) && cap > 0 && Number.isFinite(after)) {
    const want = Number(Math.max(0, after - cap).toFixed(2));
    if (Math.abs(want - Number(plan.trimShortfall)) > 0.05) {
      problems.push(`trimShortfall ${plan.trimShortfall} is not ${after} kr measured against the ${cap} kr ceiling`);
    }
  }
  return problems;
}
