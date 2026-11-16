#!/usr/bin/env node
// mine-basket.mjs — read the live basket, compare it with the plan that produced it, and
// write the corrections the family made by hand. Read-only: it never adds, removes or
// reserves anything. Run it before an order, or point it at a saved snapshot.
//
//   node tools/mine-basket.mjs
//   node tools/mine-basket.mjs --snapshot data/plans/basket-before-order-....json
import { readFileSync, writeFileSync } from "node:fs";
import { connectGated } from "../lib.mjs";
import { HOME as BASE } from "../paths.mjs";

const PLAN = `${BASE}/data/plans/plan-latest.json`;
const CALL_TIMEOUT = 60000;

/** The basket as the miner needs it. The address and email are not evidence and must
 *  never be copied into data/plans, which every scratch home and report scans. */
function slimBasket(b) {
  return {
    Lines: Array.isArray(b.Lines) ? b.Lines : [],
    Recipes: Array.isArray(b.Recipes) ? b.Recipes : [],
    TotalProductsPrice: b.TotalProductsPrice,
    TotalPrice: b.TotalPrice,
    DeliveryPrice: b.DeliveryPrice,
    MinimumOrderTotal: b.MinimumOrderTotal,
    IsMinTotalValid: b.IsMinTotalValid,
  };
}

/** What the basket holds for a sku: its own line plus what a recipe card brought. */
function basketRows(basket) {
  const rows = new Map();
  for (const l of basket?.Lines || []) {
    const sku = String(l.Id ?? l.ProductNumber ?? l.ProductId ?? "");
    if (!sku) continue;
    rows.set(sku, { sku, name: l.Name || l.ProductName || "", qty: Number(l.Quantity ?? 0), where: "line" });
  }
  for (const r of basket?.Recipes || []) {
    for (const l of r.RecipeLineItems || []) {
      const sku = String(l.ProductId ?? l.Id ?? "");
      if (!sku) continue;
      const prev = rows.get(sku);
      rows.set(sku, prev
        ? { ...prev, qty: prev.qty + Number(l.Quantity ?? 0), where: "line+card" }
        : { sku, name: l.ProductName || l.Name || "", qty: Number(l.Quantity ?? 0), where: "card" });
    }
  }
  return rows;
}

/** The plan's items against the basket's products, grouped by what changed. Pure. */
export function basketDelta(plan, basket) {
  const rows = basketRows(basket);
  const planned = new Map((plan?.items || []).map((i) => [String(i.sku), i]));
  const removed = [];
  const reduced = [];
  const increased = [];
  const added = [];
  for (const [sku, item] of planned) {
    const got = rows.get(sku);
    if (!got) { removed.push({ sku, name: item.name, plan: item.packs }); continue; }
    if (got.qty < Number(item.packs)) reduced.push({ sku, name: item.name, plan: item.packs, got: got.qty, where: got.where });
    else if (got.qty > Number(item.packs)) increased.push({ sku, name: item.name, plan: item.packs, got: got.qty, where: got.where });
  }
  for (const [sku, got] of rows) {
    if (!planned.has(sku)) added.push({ sku, name: got.name, qty: got.qty, where: got.where });
  }
  const planCards = (plan?.dinnerMenu || []).map((m) => String(m.name));
  const gotCards = (basket?.Recipes || []).map((r) => String(r.Title || ""));
  return {
    basket: {
      lines: (basket?.Lines || []).length,
      cards: (basket?.Recipes || []).length,
      products: basket?.TotalProductsPrice,
      total: basket?.TotalPrice,
      delivery: basket?.DeliveryPrice,
    },
    cards: {
      plan: planCards,
      got: gotCards,
      removed: planCards.filter((n) => !gotCards.includes(n)),
      added: gotCards.filter((n) => !planCards.includes(n)),
    },
    removed,
    reduced,
    increased,
    added,
  };
}

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

function line(label, x) {
  console.log(`${label} ${x.name}${x.plan !== undefined ? ` plan ${x.plan} -> ${x.got ?? 0}` : ` x${x.qty}`}${x.where ? ` (${x.where})` : ""}`);
}

async function main() {
  const plan = JSON.parse(readFileSync(arg("plan", PLAN), "utf8"));
  const snapshot = arg("snapshot", "");
  let basket;
  const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
  if (snapshot) {
    basket = JSON.parse(readFileSync(snapshot, "utf8"));
    console.log(`snapshot ${snapshot}`);
  } else {
    const { mcp } = await connectGated({ concurrency: 1, minIntervalMs: 300, attempts: 1 });
    const b = await mcp.call("get_basket", {}, { timeoutMs: CALL_TIMEOUT });
    if (b.isError) throw new Error("get_basket failed: " + b.text.slice(0, 200));
    basket = b.json || {};
    const saved = `${BASE}/data/plans/basket-before-order-${stamp}.json`;
    writeFileSync(saved, JSON.stringify(slimBasket(basket), null, 1));
    console.log(`snapshot ${saved}`);
  }
  const delta = basketDelta(plan, basket);
  const report = `${BASE}/data/plans/basket-corrections-${stamp}.json`;
  writeFileSync(report, JSON.stringify({ at: new Date().toISOString(), plan: arg("plan", PLAN), ...delta }, null, 1));
  console.log("basket", JSON.stringify(delta.basket));
  console.log("cards removed:", delta.cards.removed.join(", ") || "none");
  console.log("cards added:", delta.cards.added.join(", ") || "none");
  console.log(`removed ${delta.removed.length}:`);
  for (const x of delta.removed) line("  -", x);
  console.log(`reduced ${delta.reduced.length}:`);
  for (const x of delta.reduced) line("  ~", x);
  console.log(`increased ${delta.increased.length}:`);
  for (const x of delta.increased) line("  +", x);
  console.log(`added ${delta.added.length}:`);
  for (const x of delta.added) line("  +", x);
  console.log("report", report);
  console.log("The basket was only read. Nothing was added, removed or reserved.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("FAILED:", err.message);
    process.exitCode = 1;
  });
}
