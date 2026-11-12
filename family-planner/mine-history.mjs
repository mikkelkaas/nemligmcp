#!/usr/bin/env node
// mine-history.mjs — pull the whole Nemlig order history and build the knowledge base.
//
// Usage:  node mine-history.mjs [--max N] [--out DIR] [--quiet]
//         --max 0 (default) mines every order the account returns, capped at 1000.
//
// Writes into --out (default this folder/data):
//   history-raw.json  every order: totals, fee breakdown, delivery window, line items
//   staples.json      per-product rebuy statistics (count, qty, price, category)
//   recipes.json      per-recipe usage, from the RecipeId/RecipeUrl on order lines
//   patterns.json     cadence, category shares, basket size, delivery-window stats
//   mine.log          one line per order + per page, for auditing
//
// Safety: read-only MCP calls (get_order_history, get_order_details). Nothing here
// touches the basket. Calls are paced, every loop is bounded, every result is checked.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { connectGated, sleep } from "./lib.mjs";

const PAGE = 10;          // get_order_history page size
const MAX_PAGES = 100;    // 1000 orders ceiling, hard stop
const DELAY_MS = 400;     // pacing between calls, protects the account from rate limits
const CALL_TIMEOUT = 45000;
const DATE_RE = /^(\d{2})\/(\d{2})-(\d{4})/;
const WINDOW_RE = /kl\.\s*(\d{2})-(\d{2})/;
const DOW = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}
const maxOrders = Math.max(0, parseInt(arg("max", "0"), 10) || 0);
import { DATA } from "./paths.mjs";
  const outDir = arg("out", DATA);
const quiet = process.argv.includes("--quiet");
mkdirSync(outDir, { recursive: true });

function log(msg) {
  if (!quiet) console.log(msg);
  appendFileSync(outDir + "/mine.log", new Date().toISOString().slice(0, 19) + " " + msg + "\n");
}

/** "29/12-2024 kl. 14-17" -> { iso: "2024-12-29", window: "14-17", hour: 14, dow: 0 } */
function parseOrderDate(raw) {
  const s = String(raw || "");
  const m = DATE_RE.exec(s);
  const w = WINDOW_RE.exec(s);
  const window = w ? w[1] + "-" + w[2] : null;
  if (!m) return { iso: null, window, hour: w ? Number(w[1]) : null, dow: null };
  const iso = m[3] + "-" + m[2] + "-" + m[1];
  const dow = new Date(iso + "T12:00:00Z").getUTCDay();
  return { iso, window, hour: w ? Number(w[1]) : null, dow };
}

/** Page backwards through the order list. Bounded by MAX_PAGES and maxOrders. */
async function listOrders(mcp) {
  const seen = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await mcp.call("get_order_history", { skip: page * PAGE, take: PAGE }, { timeoutMs: CALL_TIMEOUT });
    if (r.isError) throw new Error("get_order_history failed: " + r.text.slice(0, 200));
    const orders = (r.json && (r.json.Orders || r.json.orders)) || [];
    if (!Array.isArray(orders) || orders.length === 0) break;
    for (const o of orders) if (o.Id !== undefined && !seen.has(o.Id)) seen.set(o.Id, o);
    log(`page ${page}: ${orders.length} rows, ${seen.size} unique`);
    if (orders.length < PAGE) break;
    if (maxOrders > 0 && seen.size >= maxOrders) break;
    await sleep(DELAY_MS);
  }
  return [...seen.values()];
}

/** Fetch one order's detail, one retry. Returns null on failure. */
async function fetchDetail(mcp, orderId) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await mcp.call("get_order_details", { orderId }, { timeoutMs: CALL_TIMEOUT });
      if (r.isError) throw new Error(r.text.slice(0, 160));
      if (!r.json || !Array.isArray(r.json.Lines)) throw new Error("detail has no Lines array");
      return r.json;
    } catch (e) {
      if (attempt === 2) { log(`order ${orderId}: FAILED ${e.message}`); return null; }
      await sleep(1500);
    }
  }
  return null;
}

/** Keep only the fields the planner needs from one order line. */
function lineOf(l) {
  const qty = Number(l.Quantity ?? 0);
  const unit = Number(l.AverageItemPrice ?? 0);
  return {
    sku: l.ProductNumber ?? null,
    name: String(l.ProductName ?? "").trim(),
    qty,
    unitPrice: unit,
    amount: Number(l.Amount ?? unit * qty),
    packSize: String(l.Description ?? "").trim(),
    group: l.GroupName ?? "",
    mainGroup: l.MainGroupName ?? "",
    isRecipeLine: !!l.IsRecipeLine,
    recipeId: l.RecipeId ?? null,
    recipeUrl: l.RecipeUrl ?? null,
    isMealBox: !!(l.IsMealBoxLine || l.IsMealBoxRecipeLine),
    soldOut: !!l.SoldOut,
  };
}

function median(a) {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function mean(a) {
  return a.length === 0 ? 0 : Number((a.reduce((x, y) => x + y, 0) / a.length).toFixed(2));
}

/** Per-product rebuy statistics. */
function buildStaples(orders) {
  const byKey = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      const key = l.sku ? "sku:" + l.sku : "name:" + l.name.toLowerCase();
      const e = byKey.get(key) || {
        sku: l.sku, name: l.name, group: l.group, mainGroup: l.mainGroup, packSize: l.packSize,
        orders: 0, totalQty: 0, qtys: [], unitPrices: [], recipeLines: 0,
        firstDate: o.iso, lastDate: o.iso, lastOrder: o.orderNumber,
      };
      e.orders += 1;
      e.totalQty += l.qty;
      e.qtys.push(l.qty);
      if (l.unitPrice > 0) e.unitPrices.push(l.unitPrice);
      if (l.isRecipeLine) e.recipeLines += 1;
      if (o.iso) {
        if (o.iso < e.firstDate) e.firstDate = o.iso;
        if (o.iso > e.lastDate) { e.lastDate = o.iso; e.lastOrder = o.orderNumber; }
      }
      byKey.set(key, e);
    }
  }
  const n = Math.max(1, orders.length);
  return [...byKey.values()].map((e) => ({
    sku: e.sku, name: e.name, group: e.group, mainGroup: e.mainGroup, packSize: e.packSize,
    orders: e.orders, ordersPct: Number((e.orders / n * 100).toFixed(0)),
    totalQty: Number(e.totalQty.toFixed(2)),
    medianQty: median(e.qtys), meanQty: mean(e.qtys),
    medianUnitPrice: Number(median(e.unitPrices).toFixed(2)),
    recipeLinePct: Number((e.recipeLines / e.orders * 100).toFixed(0)),
    firstDate: e.firstDate, lastDate: e.lastDate, lastOrder: e.lastOrder,
  })).sort((a, b) => b.orders - a.orders || a.name.localeCompare(b.name));
}

/** Per-recipe usage, keyed on the recipe URL. One recipe spans many order lines. */
function buildRecipes(orders) {
  const byKey = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      if (!l.recipeUrl && !l.recipeId) continue;
      const key = l.recipeUrl || "id:" + l.recipeId;
      const e = byKey.get(key) || {
        url: l.recipeUrl, recipeId: l.recipeId, orders: new Set(), lines: 0, cost: 0,
        products: new Set(), dates: [],
      };
      e.orders.add(o.orderNumber);
      e.lines += 1;
      e.cost += l.amount;
      e.products.add(l.name);
      if (o.iso) e.dates.push(o.iso);
      byKey.set(key, e);
    }
  }
  return [...byKey.values()].map((e) => {
    const dates = e.dates.sort();
    return {
      url: e.url, recipeId: e.recipeId,
      orders: e.orders.size, lines: e.lines,
      linesPerOrder: Number((e.lines / e.orders.size).toFixed(1)),
      costPerOrder: Number((e.cost / e.orders.size).toFixed(2)),
      first: dates[0], last: dates.at(-1),
      sampleProducts: [...e.products].slice(0, 14),
    };
  }).sort((a, b) => b.orders - a.orders);
}

/** Cadence, category shares, basket size, delivery-window preference. */
function buildPatterns(orders, staples) {
  const dated = orders.filter((o) => o.iso).sort((a, b) => a.iso.localeCompare(b.iso));
  const gaps = [];
  for (let i = 1; i < dated.length; i++) {
    const days = (Date.parse(dated[i].iso) - Date.parse(dated[i - 1].iso)) / 86400000;
    if (days > 0) gaps.push(days);
  }
  const cats = new Map();
  for (const o of orders) {
    for (const l of o.lines) {
      const g = l.mainGroup || l.group || "(ukendt)";
      const e = cats.get(g) || { group: g, lines: 0, amount: 0, orders: new Set() };
      e.lines += 1; e.amount += l.amount; e.orders.add(o.orderNumber);
      cats.set(g, e);
    }
  }
  const windows = new Map();
  const dows = new Map();
  for (const o of orders) {
    if (o.window) windows.set(o.window, (windows.get(o.window) || 0) + 1);
    if (o.dow !== null && o.dow !== undefined) {
      const k = DOW[o.dow];
      dows.set(k, (dows.get(k) || 0) + 1);
    }
  }
  return {
    orderCount: orders.length,
    firstOrder: dated.length ? dated[0].iso : null,
    lastOrder: dated.length ? dated.at(-1).iso : null,
    meanDaysBetweenOrders: mean(gaps),
    medianDaysBetweenOrders: median(gaps),
    meanLinesPerOrder: mean(orders.map((o) => o.lineCount)),
    meanProductsPerOrder: mean(orders.map((o) => o.numberOfProducts || o.lineCount)),
    meanOrderTotal: mean(orders.map((o) => o.total || 0)),
    medianOrderTotal: median(orders.map((o) => o.total || 0)),
    meanShippingFee: mean(orders.map((o) => o.shippingPrice || 0)),
    ordersPayingShipping: orders.filter((o) => (o.shippingPrice || 0) > 0).length,
    meanDeposit: mean(orders.map((o) => o.depositPrice || 0)),
    categories: [...cats.values()].map((e) => ({
      group: e.group, lines: e.lines, amount: Number(e.amount.toFixed(0)),
      orderSharePct: Number((e.orders.size / Math.max(1, orders.length) * 100).toFixed(0)),
    })).sort((a, b) => b.amount - a.amount),
    deliveryWindows: [...windows.entries()].map(([w, n]) => ({ window: w, orders: n })).sort((a, b) => b.orders - a.orders),
    weekdays: [...dows.entries()].map(([d, n]) => ({ weekday: d, orders: n })).sort((a, b) => b.orders - a.orders),
    top40Products: staples.slice(0, 40).map((s) => ({ name: s.name, orders: s.orders, medianQty: s.medianQty })),
  };
}

async function main() {
  const { mcp, info } = await connectGated({ minIntervalMs: 200 });
  log(`connected to ${info.name} ${info.version}`);
  const listed = await listOrders(mcp);
  log(`${listed.length} orders listed`);
  const orders = [];
  for (const meta of listed) {
    const detail = await fetchDetail(mcp, meta.Id);
    if (!detail) continue;
    const d = parseOrderDate(detail.OrderDate ?? meta.OrderDate);
    const lines = (detail.Lines || []).filter((l) => l.IsProductLine !== false).map(lineOf);
    orders.push({
      id: detail.Id, orderNumber: detail.OrderNumber, iso: d.iso, window: d.window,
      hour: d.hour, dow: d.dow, rawDate: detail.OrderDate, deliveryDate: detail.DeliveryDate,
      deliveryTime: detail.DeliveryTime, timeslotDuration: detail.TimeslotDuration, status: detail.Status,
      subTotal: detail.SubTotal, shippingPrice: detail.ShippingPrice, depositPrice: detail.DepositPrice,
      packagingPrice: detail.PackagingPrice, transactionFee: detail.TransactionFee, total: detail.Total,
      numberOfProducts: detail.NumberOfProducts, numberOfPacks: detail.NumberOfPacks,
      lineCount: lines.length, lines,
    });
    log(`order ${detail.OrderNumber} ${d.iso} ${d.window || ""}: ${lines.length} lines, ${detail.Total} kr`);
    await sleep(DELAY_MS);
    if (maxOrders > 0 && orders.length >= maxOrders) break;
  }
  orders.sort((a, b) => String(b.iso).localeCompare(String(a.iso)));
  const staples = buildStaples(orders);
  const recipes = buildRecipes(orders);
  writeFileSync(outDir + "/history-raw.json", JSON.stringify(orders, null, 1));
  writeFileSync(outDir + "/staples.json", JSON.stringify(staples, null, 1));
  writeFileSync(outDir + "/recipes.json", JSON.stringify(recipes, null, 1));
  writeFileSync(outDir + "/patterns.json", JSON.stringify(buildPatterns(orders, staples), null, 1));
  log(`wrote 4 data files to ${outDir}`);
  console.log(`\nOrders: ${orders.length} | distinct products: ${staples.length} | distinct recipes: ${recipes.length}`);
  console.log(`Window: ${orders.length ? orders.at(-1).iso : "-"} to ${orders.length ? orders[0].iso : "-"}`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
