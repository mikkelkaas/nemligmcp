#!/usr/bin/env node
// mine-recipes.mjs — save the raw order lines of every past order, then report what
// the order data actually says about recipes and about the swaps we made ourselves.
//
// Why this file exists: history-raw.json is already mapped, so a field that Namlig
// calls something else is invisible there. This keeps the untouched JSON so the
// recipe fields (IsRecipeLine, RecipeId, RecipeUrl, IsMealBoxLine) and the swap
// fields (OriginalProductNumber, OriginalProductName, OriginalQuantity) can be read
// as Namlig sends them.
//
// Safety: read-only MCP calls (get_order_details). Nothing is written to the basket.
// Output: data/order-lines-raw.jsonl, one JSON object per order, appended so an
// interrupted run can resume. Re-run any time; finished orders are skipped.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { connectGated } from "./lib.mjs";

import { HOME as BASE } from "./paths.mjs";
const RAW_PATH = BASE + "/data/order-lines-raw.jsonl";
const HISTORY = BASE + "/data/history-raw.json";
const CALL_TIMEOUT = 45000;
const DELAY_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Orders to fetch: every id in history-raw.json, oldest first. */
function wantedOrders() {
  const hist = JSON.parse(readFileSync(HISTORY, "utf8"));
  if (!Array.isArray(hist) || hist.length === 0) throw new Error("history-raw.json is empty");
  return hist
    .filter((o) => Number.isFinite(Number(o.id)))
    .map((o) => ({ id: Number(o.id), iso: o.iso || "", window: o.window || "", total: o.total }))
    .sort((a, b) => a.iso.localeCompare(b.iso));
}

/** Ids already stored, so an interrupted scrape resumes instead of repeating. */
function doneIds() {
  if (!existsSync(RAW_PATH)) return new Set();
  const ids = new Set();
  for (const line of readFileSync(RAW_PATH, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (Number.isFinite(Number(j.orderId))) ids.add(Number(j.orderId));
    } catch { /* a half-written last line is dropped and re-fetched */ }
  }
  return ids;
}

async function main() {
  const fresh = process.argv.includes("--fresh");
  if (fresh && existsSync(RAW_PATH)) {
    writeFileSync(RAW_PATH + ".bak", readFileSync(RAW_PATH, "utf8"));
    writeFileSync(RAW_PATH, "");
    console.log("--fresh: cleared " + RAW_PATH + " (backup at " + RAW_PATH + ".bak)");
  }
  const orders = wantedOrders();
  const have = doneIds();
  const todo = orders.filter((o) => !have.has(o.id));
  console.log(`Orders in history: ${orders.length}, already stored: ${have.size}, to fetch: ${todo.length}`);
  if (todo.length === 0) { report(); return; }

  const { mcp } = await connectGated({ minIntervalMs: 0 });
  let fetched = 0;
  const failed = [];
  for (const o of todo) {
    let r = null;
    try {
      r = await mcp.call("get_order_details", { orderId: o.id }, { timeoutMs: CALL_TIMEOUT });
    } catch (e) {
      failed.push({ id: o.id, error: String(e.message).slice(0, 120) });
      console.log(`  fail ${o.id} ${o.iso}: ${String(e.message).slice(0, 90)}`);
      await sleep(DELAY_MS);
      continue;
    }
    if (r.isError || !r.json) {
      failed.push({ id: o.id, error: (r.text || "no json").slice(0, 120) });
      console.log(`  fail ${o.id} ${o.iso}: ${(r.text || "no json").slice(0, 90)}`);
      await sleep(DELAY_MS);
      continue;
    }
    const j = r.json;
    const lines = (j.Lines && (j.Lines.Lines || j.Lines)) || [];
    appendFileSync(RAW_PATH, JSON.stringify({
      orderId: o.id, iso: o.iso, window: o.window, total: o.total,
      fetchedAt: new Date().toISOString(),
      order: {
        SubTotal: j.SubTotal, ShippingPrice: j.ShippingPrice, Total: j.Total,
        CouponDiscount: j.CouponDiscount, TotalProductDiscount: j.TotalProductDiscount,
        NumberOfProducts: j.NumberOfProducts, NumberOfPacks: j.NumberOfPacks,
        DeliveryDate: j.DeliveryDate, DeliveryTime: j.DeliveryTime, TimeslotDuration: j.TimeslotDuration,
      },
      lines,
    }) + "\n");
    fetched++;
    if (fetched % 10 === 0) console.log(`  stored ${fetched}/${todo.length}`);
    await sleep(DELAY_MS);
  }
  console.log(`Fetched ${fetched} order(s), failed ${failed.length}.`);
  if (failed.length) console.log("Failed ids: " + failed.map((f) => f.id).join(" "));
  report();
}

/** Count what the raw lines reveal, and print the interesting ones. */
function report() {
  const rows = readFileSync(RAW_PATH, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const keys = new Set();
  let recipeLines = 0, recipeIdLines = 0, recipeUrlLines = 0, mealBox = 0, mixLines = 0, swaps = 0, campaign = 0, soldOut = 0;
  let lineCount = 0;
  const recipes = new Map();
  const swapRows = [];
  for (const row of rows) {
    for (const l of row.lines) {
      lineCount++;
      for (const k of Object.keys(l)) keys.add(k);
      if (l.IsRecipeLine) recipeLines++;
      if (l.IsMealBoxLine || l.IsMealBoxRecipeLine) mealBox++;
      if (l.RecipeId != null && l.RecipeId !== "") {
        recipeIdLines++;
        const key = String(l.RecipeUrl || l.RecipeId);
        const e = recipes.get(key) || { recipeId: l.RecipeId, url: l.RecipeUrl, orders: new Set(), products: 0, cost: 0 };
        e.orders.add(row.orderId); e.products++; e.cost += Number(l.Amount || 0);
        recipes.set(key, e);
      }
      if (l.RecipeUrl) recipeUrlLines++;
      if (l.IsMixLine) mixLines++;
      if (l.OriginalProductNumber) { swaps++; swapRows.push({ iso: row.iso, from: l.OriginalProductNumber, fromName: l.OriginalProductName, to: l.ProductNumber, toName: l.ProductName, qty: l.Quantity, origQty: l.OriginalQuantity }); }
      if (l.CampaignName) campaign++;
      if (Number(l.SoldOut) > 0) soldOut++;
    }
  }
  console.log(`\nRaw lines stored: ${lineCount} from ${rows.length} order(s).`);
  console.log(`IsRecipeLine true: ${recipeLines} | RecipeId set: ${recipeIdLines} | RecipeUrl set: ${recipeUrlLines}`);
  console.log(`Meal box lines: ${mealBox} | Mix lines: ${mixLines} | CampaignName set: ${campaign} | SoldOut set: ${soldOut}`);
  console.log(`Lines carrying OriginalProductNumber (a swap we made): ${swaps}`);
  console.log(`Line fields Namlig sends: ${[...keys].sort().join(", ")}`);
  if (recipes.size) {
    console.log(`\nRecipes seen (${recipes.size}):`);
    for (const r of [...recipes.values()].sort((a, b) => b.orders.size - a.orders.size).slice(0, 25)) {
      console.log(`  ${String(r.url || r.recipeId).slice(0, 70).padEnd(70)} orders=${r.orders.size} lines=${r.products} ${r.cost.toFixed(0)} kr`);
    }
  }
  if (swapRows.length) {
    console.log(`\nFirst 15 recorded swaps:`);
    for (const s of swapRows.slice(0, 15)) console.log(`  ${s.iso} ${s.from} ${String(s.fromName).slice(0, 26)} -> ${s.to} ${String(s.toName).slice(0, 26)} qty ${s.origQty}->${s.qty}`);
  }
}

main().catch((e) => { console.error("FAILED: " + e.message); process.exitCode = 1; });
