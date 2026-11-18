// learn.mjs — what the family did, compared with what the planner proposed.
//
// The loop: plan.mjs proposes ~55 products, apply.mjs writes them, the family then
// fixes the basket in the app (removes two, changes a quantity, adds yoghurt), and
// checks out. That edit is the clearest signal there is about this family, and it
// is already stored - in the order history. This file reads the last plans and the
// orders that followed them and writes profiles/learned.json: products that keep
// being taken out, products that keep being added, the amount of a product this
// family really buys (lower median of what they bought, so the odd big basket
// never ratchets the weekly baseline up), and which recipe cards they kept.
//
// What it does NOT do: it never edits profiles/family-*.json (the human file) and
// never decides anything alone. plan.mjs reads learned.json UNDER the profile, so a
// family can pin anything back, and every learned line is printed in the plan with
// the orders behind it.
//
// Pure functions are exported and tested in test/match.test.mjs.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { DATA, PROFILES } from "./paths.mjs";
import { norm } from "./match.mjs";

const WORD_STOP = new Set(["okse", "koeb", "oeko", "økologisk", "stor", "store", "lille", "ny", "klar"]);

/** First meaningful word of a product name: the level a family thinks in. */
export function productWord(name) {
  const parts = norm(name).split(/[^a-z0-9æøå]+/).filter((w) => w.length >= 4 && !WORD_STOP.has(w));
  return parts.length > 0 ? parts[0] : "";
}

/** One order, thinned to what the comparison needs. */
function thinOrder(raw) {
  // Two shapes: the API/order-lines file (ProductNumber, ProductName) and the
  // history-raw file mine-history.mjs writes (sku, name, qty). Both are read here.
  const lines = (raw.lines || raw.Lines || []).filter((l) =>
    l.IsProductLine !== false && (l.ProductNumber || l.sku));
  return {
    at: String(raw.iso || raw.at || "").slice(0, 10),
    orderId: String(raw.orderId || raw.orderNumber || raw.Id || ""),
    lines: lines.map((l) => ({
      sku: String(l.ProductNumber ?? l.sku), name: l.ProductName || l.name || "", qty: Number(l.Quantity ?? l.qty) || 0,
      recipeUrl: l.RecipeUrl || l.MealBoxRecipePdfUrl || l.recipeUrl || null,
    })),
  };
}

/** The order history the miner wrote, or the older JSONL file when that is all there is. */
export function readOrders() {
  const rawFile = `${DATA}/history-raw.json`;
  if (existsSync(rawFile)) {
    const raw = JSON.parse(readFileSync(rawFile, "utf8"));
    if (!Array.isArray(raw)) throw new Error(`${rawFile} must hold an array of orders`);
    return raw.map(thinOrder).filter((o) => o.lines.length > 0);
  }
  return readJsonl(`${DATA}/order-lines-raw.jsonl`, 400).map(thinOrder).filter((o) => o.lines.length > 0);
}

/**
 * The plan's day, as YYYY-MM-DD.
 * New plans store atIso; older ones are read from the file name
 * ("plan-2026-11-12084205.json"), which is a UTC stamp and always present.
 */
function planDate(path, plan) {
  const iso = String((plan && plan.atIso) || "");
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
  const m = String(path).match(/plan-(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const t = Date.parse((plan && plan.createdAt) || "");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/** Plans, oldest first, thinned to items and menu. Missing or broken files are skipped. */
function thinPlan(path) {
  try {
    const p = JSON.parse(readFileSync(path, "utf8"));
    const menu = p.dinnerMenu || p.menu || {};
    return {
      file: path,
      at: planDate(path, p),
      items: (p.items || []).map((i) => ({ sku: String(i.sku), name: i.name, qty: Number(i.packs) || 0 })),
      menu: (Array.isArray(menu) ? menu : (menu.menu || [])).map((m) => m.url || m.id).filter(Boolean),
    };
  } catch {
    return null;
  }
}

function readJsonl(path, limit = 500) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function readPlans(dir = DATA + "/plans", limit = 24) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^plan-\d+.*\.json$/.test(f)).sort().slice(-limit);
  return files.map((f) => thinPlan(`${dir}/${f}`)).filter(Boolean);
}

/**
 * Group the orders that belong to each plan: the ones that landed after it and before
 * the next plan, capped at maxGapDays. A plan covers a period and a family shops in
 * several baskets over that period, so "did they buy it" must be asked of all of them -
 * asking only the first one calls a late purchase a rejection.
 */
export function pairPlanToOrder(plans, orders, opts = {}) {
  const maxGap = Number(opts.maxGapDays) || 21;
  const sorted = [...plans].sort((a, b) => a.at.localeCompare(b.at));
  const used = new Set();
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const from = Date.parse(p.at);
    if (!Number.isFinite(from)) continue;
    const next = sorted[i + 1] ? Date.parse(sorted[i + 1].at) : from + maxGap * 86400000;
    const to = Math.min(next, from + maxGap * 86400000);
    const window = orders.filter((o) => !used.has(o.orderId) && Date.parse(o.at) >= from && Date.parse(o.at) <= to);
    if (window.length === 0) continue;
    for (const o of window) used.add(o.orderId);
    out.push({ plan: p, orders: window.sort((a, b) => a.at.localeCompare(b.at)) });
  }
  return out;
}

/** What the family changed between one plan and the baskets that followed it. */
export function observedDelta(plan, orders) {
  const list = Array.isArray(orders) ? orders : [orders];
  const planBySku = new Map(plan.items.map((i) => [i.sku, i]));
  const bought = new Map();
  for (const o of list) {
    for (const l of o.lines) {
      const e = bought.get(l.sku) || { sku: l.sku, name: l.name, qty: 0 };
      e.qty += l.qty;
      bought.set(l.sku, e);
    }
  }
  const removed = plan.items.filter((i) => !bought.has(i.sku));
  const added = [...bought.values()].filter((b) => !planBySku.has(b.sku));
  // "observed" counts every planned product the family bought in the period,
  // also the ones at exactly the planned quantity: agreement is a vote too.
  const quantityChanges = [];
  const observed = [];
  for (const b of bought.values()) {
    const p = planBySku.get(b.sku);
    if (!p || !(p.qty > 0) || !(b.qty > 0)) continue;
    observed.push({ sku: b.sku, name: b.name, planned: p.qty, bought: b.qty });
    if (p.qty !== b.qty) quantityChanges.push({ sku: b.sku, name: b.name, planned: p.qty, bought: b.qty });
  }
  const recipes = list.flatMap((o) => o.lines.filter((l) => l.recipeUrl).map((l) => l.recipeUrl));
  return { kept: plan.items.length - removed.length, removed, added, quantityChanges, observed, recipes };
}

function bump(map, key, value, name) {
  if (!key) return;
  const e = map.get(key) || { key, name, count: 0, values: [], dates: [] };
  // Count baskets, not lines: three yoghurt flavours added in one order are one
  // observation, not three. Otherwise one basket can teach a habit.
  if (value.at && e.dates.includes(value.at)) return;
  e.count += 1; e.values.push(value); e.dates.push(value.at || "");
  e.name = e.name || name;
  map.set(key, e);
}

const median = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return v.length === 0 ? null : v[Math.floor(v.length / 2)];
};

/**
 * Median that rounds to the smaller side. Used for quantities: a line only
 * moves up when more than half the baskets pushed it up, and only moves
 * down when more than half pushed it down. Two baskets of extra milk can
 * then never ratchet the weekly plan to three forever - the agreed baskets
 * outvote them.
 */
const lowerMedian = (a) => {
  const v = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  return v.length === 0 ? null : v[Math.floor((v.length - 1) / 2)];
};

/**
 * Turn paired plan/order deltas into the learned file.
 * `minObservations` keeps single disagreements out: a product must keep being taken
 * out (or added) across that many separate baskets before the planner reacts.
 * Quantity factors are a lowerMedian over every observed basket, agreed ones
 * included: a line moves only when more than half the baskets pushed that way,
 * so a weekly baseline emerges from the family's own buying instead of ratcheting
 * upward on the odd big basket.
 */
export function learnedFrom(pairs, opts = {}) {
  const min = Number(opts.minObservations) || 2;
  const cap = Number(opts.maxQuantityFactor) || 2;
  const removedMap = new Map(), addedMap = new Map(), qtyMap = new Map();
  const recipeCounts = new Map();
  // The gap between baskets decides how often a learned add-on is needed: a family
  // that shops every 9 days and adds yoghurt every time wants it weekly, not daily.
  const days = [...new Set(pairs.flatMap((x) => x.orders.map((o) => o.at)))].sort();
  const gaps = days.slice(1).map((d, i) => (Date.parse(d) - Date.parse(days[i])) / 86400000).filter((n) => n > 0);
  const orderGapDays = gaps.length > 0 ? Math.max(1, Math.round(median(gaps))) : 10;
  for (const { plan, orders } of pairs) {
    const d = observedDelta(plan, orders);
    for (const r of d.removed) bump(removedMap, productWord(r.name), { at: plan.at, name: r.name }, r.name);
    for (const a of d.added) bump(addedMap, productWord(a.name), { at: plan.at, name: a.name, qty: a.qty }, a.name);
    // One vote per word per basket: sum what was planned and what was bought
    // for that word, so a basket that kept the plan votes 1.0 and the
    // disagreements cannot drown it. Two skus of the same word vote once.
    const byWord = new Map();
    for (const o of d.observed) {
      const w = productWord(o.name);
      if (!w) continue;
      const e = byWord.get(w) || { word: w, name: o.name, planned: 0, bought: 0 };
      e.planned += o.planned; e.bought += o.bought;
      byWord.set(w, e);
    }
    for (const e of byWord.values()) {
      if (e.planned > 0) bump(qtyMap, e.word, { at: plan.at, factor: e.bought / e.planned, name: e.name }, e.name);
    }
    for (const url of d.recipes) recipeCounts.set(url, (recipeCounts.get(url) || 0) + 1);
  }
  const avoid = [...removedMap.values()].filter((e) => e.count >= min)
    .map((e) => ({ word: e.key, name: e.name, times: e.count, evidence: `not bought in ${e.count} of ${pairs.length} followed baskets` }))
    .sort((a, b) => b.times - a.times).slice(0, 20);
  const add = [...addedMap.values()].filter((e) => e.count >= min)
    .map((e) => ({ query: e.name, word: e.key, times: e.count, medianQty: median(e.values.map((v) => v.qty)) || 1,
      evidence: `you added it in ${e.count} of ${pairs.length} baskets` }))
    .sort((a, b) => b.times - a.times).slice(0, 15);
  const quantityBias = [...qtyMap.values()]
    .filter((e) => e.count >= min)
    .map((e) => {
      const f = lowerMedian(e.values.map((v) => v.factor));
      const differed = e.values.filter((v) => Math.abs(v.factor - 1) >= 0.2).length;
      return {
        word: e.key, name: e.name,
        factor: Number(Math.min(cap, Math.max(1 / cap, f ?? 1)).toFixed(2)),
        seen: e.count,
        evidence: `lower median bought/planned ${(f ?? 1).toFixed(2)} over ${e.count} baskets, ${differed} of them differed`,
      };
    })
    .filter((e) => Math.abs(e.factor - 1) >= 0.2)
    .sort((a, b) => Math.abs(b.factor - 1) - Math.abs(a.factor - 1)).slice(0, 20);
  const recipes = [...recipeCounts.entries()].map(([url, times]) => ({ url, times }))
    .sort((a, b) => b.times - a.times).slice(0, 30);
  return { pairs: pairs.length, avoid, add, quantityBias, recipes, orderGapDays };
}

/** The learned multiplier for a query: "madmel" matches the learned word "madmel". */
function biasFor(query, list, opts = {}) {
  const cap = Number(opts.maxQuantityFactor) || 2;
  const w = productWord(query);
  if (!w) return 1;
  const hit = (list || []).find((e) => e.word === w || productWord(e.name) === w);
  if (!hit) return 1;
  const f = Number(hit.factor);
  return Number.isFinite(f) && f >= 1 / cap && f <= cap ? f : 1;
}

/** Scale one intent's need by the family's learned habit. Returns the intent changed. */
export function biasIntent(intent, list, opts = {}) {
  const factor = biasFor(intent.query, list, opts);
  if (factor === 1 || !intent.need) return { intent, changed: false };
  const m = String(intent.need).match(/^(\d+(?:[.,]\d+)?)\s*(\S+)$/);
  if (!m) return { intent, changed: false };
  const qty = Number(m[1].replace(",", "."));
  if (!(qty > 0)) return { intent, changed: false };
  const scaled = Number((qty * factor).toFixed(2));
  return {
    intent: {
      ...intent,
      need: `${scaled} ${m[2]}`,
      rationale: [intent.rationale, `learned: this family buys ${factor}x that, seen in their own baskets`].filter(Boolean).join(" | "),
    },
    changed: true,
  };
}

/** Intents for the things this family keeps adding to the basket themselves. */
export function addIntentsOf(add, opts = {}) {
  const gap = Number(opts.gapDays) || 10;
  const days = Number(opts.days) || 8;
  const rules = opts.rules || {};
  return (add || []).map((a) => {
    const perCycle = Math.max(1, Number(a.medianQty) || 1);
    const packs = Math.max(1, Math.ceil((perCycle * days) / gap));
    return {
      source: "learned:add", sourceLabel: `learned (${a.times}x)`, query: a.query, need: `${packs} stk`,
      mode: "cheapest", note: a.evidence || "you added it to the basket yourself",
      preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct,
    };
  });
}

/** Human taste recorded with "node learn.mjs --rate <recipe-url> good|bad". */
export function tasteFile(file = `${PROFILES}/taste.json`) {
  if (!existsSync(file)) return { liked: [], refused: [] };
  try {
    const t = JSON.parse(readFileSync(file, "utf8"));
    return {
      liked: Array.isArray(t.liked) ? t.liked.filter((u) => typeof u === "string") : [],
      refused: Array.isArray(t.refused) ? t.refused.filter((u) => typeof u === "string") : [],
    };
  } catch {
    return { liked: [], refused: [] };
  }
}

function rate(url, verdict, file) {
  const t = tasteFile(file);
  const key = verdict === "good" ? "liked" : "refused";
  const other = verdict === "good" ? "refused" : "liked";
  t[key] = [...new Set([...t[key], url])];
  t[other] = t[other].filter((u) => u !== url);
  t.updated = new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false });
  writeFileSync(file, JSON.stringify(t, null, 1));
  console.log(`Recorded: ${url} is ${verdict}. profiles/taste.json is yours, the planners only read it.`);
}

const pairsTotal = (pairs) => pairs.reduce((n, p) => n + p.orders.length, 0);

function main() {
  const dry = process.argv.includes("--dry");
  const limit = Number((process.argv.find((a, i) => process.argv[i - 1] === "--limit") || "24"));
  const rateAt = process.argv.indexOf("--rate");
  if (rateAt > -1) {
    const [, url, verdict] = process.argv.slice(rateAt);
    if (!url || !/^(good|bad)$/.test(verdict || "")) throw new Error('use --rate "<recipe url>" good|bad');
    rate(url, verdict);
    return;
  }
  const orders = readOrders();
  const plans = readPlans(DATA + "/plans", Number.isFinite(limit) ? limit : 24);
  const pairs = pairPlanToOrder(plans, orders, { maxGapDays: 21 });
  const taste = tasteFile();
  const learned = learnedFrom(pairs, { minObservations: 2, maxQuantityFactor: 2 });
  const out = {
    _readme: "Generated by learn.mjs. Do not edit by hand: your file is profiles/family-*.json, and it wins over everything here. Delete this file to forget the loop.",
    schemaVersion: 1,
    at: new Date().toLocaleString("da-DK", { timeZone: "Europe/Copenhagen", hour12: false }),
    compared: { plans: learned.pairs, ordersSeen: orders.length, windowDays: 21 },
    ...learned,
    taste,
  };
  console.log(`Compared ${out.compared.plans} plan(s) with the ${pairsTotal(pairs)} basket(s) that followed them (of ${orders.length} orders in the history).`);
  console.log(`  taken out again        : ${out.avoid.length} word(s): ${out.avoid.slice(0, 6).map((a) => `${a.word} x${a.times}`).join(", ") || "none"}`);
  console.log(`  added by the family    : ${out.add.length} item(s): ${out.add.slice(0, 6).map((a) => `${a.query} x${a.times}`).join(", ") || "none"}`);
  console.log(`  quantity corrections   : ${out.quantityBias.length} word(s): ${out.quantityBias.slice(0, 6).map((a) => `${a.word} x${a.factor}`).join(", ") || "none"}`);
  console.log(`  recipe cards kept      : ${out.recipes.length}, taste file: ${taste.liked.length} liked / ${taste.refused.length} refused`);
  if (dry) { console.log("Nothing written (--dry)."); return; }
  writeFileSync(`${PROFILES}/learned.json`, JSON.stringify(out, null, 1));
  console.log(`Wrote ${PROFILES}/learned.json. plan.mjs reads it under your profile and prints what it used.`);
}

// Run only as a command, so the pure functions can be tested by import.
if (process.argv[1] && process.argv[1].endsWith("learn.mjs")) {
  try { main(); } catch (e) { console.error("FAILED:", e.stack || e.message); process.exitCode = 1; }
}
