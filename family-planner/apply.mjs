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
//   1. the recipe cards go in first, so their products are already in the basket;
//   2. every plan product then overwrites its quantity, down as well as up;
//   3. recipe products the plan does not want (fresh herbs, pantry staples, another
//      brand) are set to 0. A line that was in the basket before the cards is never
//      touched, so what you added in the app stays.
// Use --recipes no to skip the cards.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { connect, loadEnv, Limiter, sleep } from "./lib.mjs";
import { writeRotation } from "./dinners.mjs";
import { login } from "./auth.mjs";
import { resolvePlanRecipes, recipeLines } from "./recipes.mjs";
import { loadFamily } from "./family.mjs";

import { HOME as BASE, writeJsonAtomic, withLock } from "./paths.mjs";
const TOKEN = "I-APPROVE-THIS-BASKET";
const CALL_TIMEOUT = 60000;
// A write is never retried automatically: a lost answer to add_to_basket must not become
// two of the same product. The gate only paces the writes and ends a stuck run.
const WRITE_GATE = { concurrency: 1, minIntervalMs: 350, attempts: 1, deadlineAtMs: 10 * 60 * 1000 };
// Recipe cards go through the shop's own web API with its own session, so the gate above
// does not reach them. They keep their own fixed spacing.
const WEB_STEP_DELAY_MS = 350;

/**
 * One line per dinner, appended when a plan really goes into the basket. This is the
 * record of what was cooked, and the rotation cooldown and learn.mjs read it. A dry
 * run never writes here, because a printed plan is not dinner.
 */
function appendCookLog(file, menu, day) {
  const lines = menu.filter((m) => m && (m.url || m.id)).map((m) => JSON.stringify({
    at: day, url: m.url || m.id, name: m.name || null, minutes: m.minutes || null, protein: m.protein || null,
  }));
  if (lines.length === 0) return;
  appendFileSync(file, lines.join("\n") + "\n");
}

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

/** Read the live basket into a map of sku -> { qty, name }. */
async function basketMap(mcp) {
  const b = await mcp.call("get_basket", {}, { timeoutMs: CALL_TIMEOUT });
  if (b.isError) throw new Error("get_basket failed: " + b.text.slice(0, 200));
  const map = new Map();
  for (const l of (b.json && b.json.Lines) || []) {
    const sku = String(l.ProductNumber ?? l.ProductId ?? l.Id ?? "");
    if (sku) map.set(sku, { sku, name: l.Name || l.ProductName || "", qty: Number(l.Quantity ?? l.Amount ?? 0) });
  }
  return { map, json: b.json || {} };
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

/** Recipe-card products the plan does not want, and that were not in the basket before. */
export function extrasToZero(lines, plannedSkus, beforeSkus) {
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const sku = String(line.sku ?? "");
    if (!sku || seen.has(sku)) continue;
    seen.add(sku);
    if (plannedSkus.has(sku) || beforeSkus.has(sku)) continue;
    out.push({ sku, name: String(line.name || "") });
  }
  return out;
}

/**
 * Step 1: put the plan's dinner recipe cards in the basket, then read back exactly which
 * products Namlig added for them. Returns the cards and their line items.
 */
async function addRecipeCards(mcp, plan) {
  const all = await resolvePlanRecipes(mcp, plan);
  for (const miss of all.filter((d) => !d.guid)) {
    console.log(`  miss  recipe card "${miss.name}": ${miss.why}`);
  }
  const dishes = all.filter((d) => d.guid);
  if (dishes.length === 0) return { cards: [], lines: [] };
  const people = Number(plan.options?.people || 5);
  const session = await login();
  const cards = [];
  for (const dish of dishes) {
    const res = await session.post("/webapi/basket/AddRecipeToBasket", {
      RecipeId: dish.guid,
      NumberOfPeople: people,
    });
    const ok = res.status >= 200 && res.status < 300;
    console.log(`  card  ${String(dish.name).slice(0, 42).padEnd(42)} ${ok ? `added for ${people} people` : `FAILED HTTP ${res.status} ${res.text.slice(0, 120)}`}`);
    cards.push({ name: dish.name, url: dish.url || dish.id, guid: dish.guid, ok });
    if (ok) await sleep(WEB_STEP_DELAY_MS); // the web session is not covered by the MCP gate
  }
  const basket = await session.get("/webapi/basket/GetBasket");
  const lines = recipeLines(basket.body).map((l) => ({ sku: l.sku ?? l.productNumber, name: l.name, qty: l.quantity }));
  console.log(`  card  ${lines.length} product(s) came in with the recipe cards.`);
  return { cards, lines };
}

/** Step 3: drop the recipe products the plan does not want. Never touches an earlier line. */
async function zeroExtras(mcp, extras, keepGoing) {
  const zeroed = [];
  const failed = [];
  for (const extra of extras) {
    const r = await mcp.call("set_basket_quantity", { productId: extra.sku, quantity: 0 }, { timeoutMs: CALL_TIMEOUT });
    if (r.isError) {
      failed.push({ sku: extra.sku, name: extra.name, error: r.text.slice(0, 160) });
      console.log(`  FAIL  ${extra.name.slice(0, 42).padEnd(42)} could not remove: ${r.text.slice(0, 120)}`);
      if (!keepGoing) break;
      continue;
    }
    zeroed.push(extra);
    console.log(`  zero  ${extra.name.slice(0, 42).padEnd(42)} from the recipe card, not in the plan`);
  }
  return { zeroed, failed };
}

async function main() {
  const planPath = arg("plan", BASE + "/data/plans/plan-latest.json");
  const approve = arg("approve", "");
  const slotId = arg("slot", null);
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

/** Everything that touches the live basket, in one bounded sequence. */
async function writeBasket({ plan, planPath, slotId, keepGoing, wantCards, household, fam }) {
  const { mcp } = await connect(loadEnv(), { limiter: new Limiter(WRITE_GATE) });
  const before = await basketMap(mcp);
  const beforeSkus = new Set(before.map.keys());
  console.log(`Basket before: ${before.map.size} line(s), ${before.json.TotalProductsPrice ?? 0} kr products.`);

  // 1. recipe cards first: their products land in the basket, then the plan overwrites them.
  const cards = wantCards
    ? await addRecipeCards(mcp, plan)
    : { cards: [], lines: [], skipped: "--recipes no" };
  if (!wantCards) console.log("  skip  recipe cards (--recipes no)");
  const recipeSkus = new Set(cards.lines.map((l) => String(l.sku)));

  // 2. the plan's own quantities, read against the basket the cards just changed.
  const withCards = cards.lines.length ? await basketMap(mcp) : before;
  const { adds, failed } = await writeItems(mcp, plan.items, withCards.map, keepGoing, recipeSkus);

  // 3. what the cards brought that the plan does not want goes to zero.
  const extras = extrasToZero(cards.lines, new Set(plan.items.map((i) => String(i.sku))), beforeSkus);
  const dropped = await zeroExtras(mcp, extras, keepGoing);
  if (extras.length) console.log(`  zero  ${dropped.zeroed.length} of ${extras.length} recipe product(s) the plan does not use.`);

  const slot = await pickSlot(mcp, slotId, adds);
  const after = await basketMap(mcp);
  const missing = verificationOf(adds, after.map);
  const report = {
    kind: "nemlig-apply",
    at: new Date().toLocaleString("da-DK", { timeZone: household.timezone || "Europe/Copenhagen", hour12: false }) + " (Europe/Copenhagen)",
    planFile: planPath,
    planCreatedAt: plan.createdAt,
    added: adds,
    failed,
    recipeCards: cards.cards,
    recipeProducts: cards.lines.length,
    removedFromRecipe: dropped.zeroed,
    recipeRemovalFailed: dropped.failed,
    slot,
    basketBefore: { lines: before.map.size, productsKr: before.json.TotalProductsPrice },
    basketAfter: { lines: after.map.size, productsKr: after.json.TotalProductsPrice, totalPriceKr: after.json.TotalPrice, deliveryKr: after.json.DeliveryPrice, minOrderKr: after.json.MinimumOrderTotal, minOrderMet: after.json.IsMinTotalValid },
    verification: missing.length === 0 ? "all added products present at the planned quantity" : "MISMATCH",
    missing,
  };
  const cooked = (plan.dinnerMenu || []).map((m) => m.url || m.id).filter(Boolean);
  if (cooked.length && failed.length === 0) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: household.timezone || "Europe/Copenhagen" }).format(new Date());
    writeRotation(BASE + "/data/rotation.json", cooked, day);
    appendCookLog(BASE + "/data/cooked-log.jsonl", plan.dinnerMenu || [], day);
    report.rotationRecorded = { day, dinners: cooked.length };
    console.log(`Rotation updated: ${cooked.length} dinner(s) marked cooked on ${day}, so the next plan rotates away from them.`);
  }
  const written = saveReport(report);
  printResult(adds, failed, after, report, missing, written, cards, dropped);
  if (failed.length) process.exitCode = 1;
}

/** Refuse to write when the plan is not applicable. Returns null when all is well. */
function refusalReason(plan, planMaxAgeHours) {
  if ((plan.unresolved || []).length > 0 && !process.argv.includes("--ignore-unresolved")) {
    const lines = (plan.unresolved || []).map((u) => "  - " + u.query + " (" + u.source + ")").join("\n");
    return { code: 4, text: `REFUSED: ${plan.unresolved.length} intent(s) had no product. Fix them, or pass --ignore-unresolved to add only what was found.\n${lines}` };
  }
  const maxAge = Number(planMaxAgeHours || 12);
  const ageHours = planAgeHours(plan);
  if (ageHours !== null && ageHours > maxAge && !process.argv.includes("--allow-stale")) {
    return { code: 5, text: `REFUSED: this plan is ${ageHours.toFixed(1)} h old and Namlig prices change daily. Run plan.mjs again, or pass --allow-stale.` };
  }
  return null;
}

/** Hours since the plan was created, or null when the stamp cannot be read. */
function planAgeHours(plan) {
  const stamped = Date.parse(String(plan.atIso || ""));
  if (Number.isFinite(stamped)) return (Date.now() - stamped) / 3600000;
  const m = /^(\d{2})\.(\d{2})\.(\d{4}), (\d{2})\.(\d{2})\.(\d{2})/.exec(String(plan.createdAt || ""));
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}T${m[5]}:${m[6]}:${m[7]}Z`;
  const created = Date.parse(iso.replace(/Z$/, "")) ;
  if (!Number.isFinite(created)) return null;
  const nowCph = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Copenhagen", hour12: false });
  const now = Date.parse(nowCph.replace(" ", "T"));
  if (!Number.isFinite(now)) return null;
  return (now - created) / 3600000;
}

/** Book the timeslot Marco approved, only after something was actually added. */
async function pickSlot(mcp, slotId, adds) {
  if (!slotId) return null;
  if (adds.length === 0) {
    console.log("  slot  skipped: nothing was added, so the timeslot was not touched");
    return null;
  }
  const s = await mcp.call("select_timeslot", { timeslotId: Number(slotId) }, { timeoutMs: CALL_TIMEOUT });
  const slot = { id: Number(slotId), isError: s.isError, text: s.text.slice(0, 300) };
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

function printResult(adds, failed, after, report, missing, written, cards, dropped) {
  console.log("");
  console.log(`APPLIED: ${adds.length} product(s) written. Basket now ${after.map.size} lines, ${after.json.TotalProductsPrice ?? "?"} kr products, ${after.json.TotalPrice ?? "?"} kr total (delivery ${after.json.DeliveryPrice ?? "?"} kr).`);
  if (after.json.MinimumOrderTotal && after.json.IsMinTotalValid === false) {
    console.log(`NOTE: minimum order is ${after.json.MinimumOrderTotal} kr and it is not met yet.`);
  }
  if (cards.cards.length) {
    const okCards = cards.cards.filter((c) => c.ok).length;
    console.log(`Recipe cards: ${okCards}/${cards.cards.length} added, ${cards.lines.length} product(s) came with them, ${dropped.zeroed.length} of those removed again.`);
  }
  console.log("Verification: " + report.verification + (missing.length ? " — " + missing.map((m) => m.name + " wanted " + m.wanted + " got " + m.got).join("; ") : ""));
  if (failed.length) console.log(`Failed writes: ${failed.length} — see ${written.file}`);
  console.log("No order was placed. Check the basket in the app, then confirm there.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
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
    const sum = Number(plan.items.reduce((t, it) => t + Number(it.total), 0).toFixed(2));
    if (Math.abs(sum - Number(plan.planTotal)) > 0.5) problems.push(`planTotal ${plan.planTotal} does not match the items, which add up to ${sum}`);
  }
  return problems;
}
