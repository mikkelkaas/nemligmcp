#!/usr/bin/env node
// catalog.mjs — turn a shopping intent into one concrete Namlig product.
//
// Two modes:
//   history (default for staples)  prefer the exact sku this family always buys;
//                                  fall back to cheapest when that sku is gone.
//   cheapest (default for recipe ingredients) lowest price per base unit.
//
// Results are cached in data/product-cache.json for CACHE_TTL hours so a repeat
// run does not re-query the same 60 searches.
//
// CLI:
//   node catalog.mjs search "<query>" [--take 12]
//   node catalog.mjs pick "<query>" [--need 300g] [--mode cheapest|history] [--sku 5053034]
// Everything prints JSON. Only read-only MCP tools are used (search_products).
import { readFileSync, mkdirSync } from "node:fs";
import { connectGated, warnUnknownFlags } from "./lib.mjs";
import { parsePack, packsFor, cheapest, choosePack, pieceGrams } from "./units.mjs";
import { nameMatches, norm, tokens, score as nameScore, MIN_NAME_SCORE } from "./match.mjs";

import { CACHE_PATH, writeJsonAtomic } from "./paths.mjs";
// What this script understands, so a typo in a flag is named instead of ignored.
const CATALOG_FLAGS = ["take", "need", "mode", "sku", "avoid", "help", "debug"];
const CACHE_TTL_H = 24;
const CACHE_KEEP_H = 24 * 7;   // an entry nobody asks for again is dropped after a week
const CALL_TIMEOUT = 45000;
const TAKE_MAX = 40;
// How many shelf names one search keeps. 12 is about what a person reads on one screen of
// the shop's own list; asking for more only costs time on the way back.
const DEFAULT_TAKE = 12;
const NEED_RE = /^(\d+(?:[.,]\d+)?)\s*(kg|g|l|ml|stk|styk|dåse|dåser|flaske|fl|pose|pos|karton|skive|skiver|glas|bakke|bundt|bdt|rl|ruller)?$/i;

/** "300g" -> { qty: 300, unit: "g" }. null when unparseable. */
export function parseNeed(text) {
  if (!text) return null;
  const m = NEED_RE.exec(String(text).trim());
  if (!m) return null;
  const qty = Number(String(m[1]).replace(",", "."));
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const unit = (m[2] || "stk").toLowerCase();
  const alias = { styk: "stk", fl: "flaske", pos: "pose", bdt: "bundt", rl: "stk", dåser: "dåse" };
  return { qty, unit: alias[unit] || unit };
}

/** Map a raw Namlig search product to the shape the planner uses. */
export function mapProduct(p) {
  return {
    id: String(p.Id ?? ""),
    name: String(p.Name ?? "").trim(),
    brand: p.Brand ?? "",
    price: Number(p.Price ?? 0),
    unitPrice: Number(p.UnitPriceCalc ?? 0),
    unitLabel: p.UnitPriceLabel ?? "",
    description: String(p.Description ?? ""),
    pack: parsePack(p.Description),
    url: p.Url ?? "",
    mainGroup: p.ProductMainGroupName ?? "",
    subGroup: p.ProductSubGroupName ?? "",
    availability: p.Availability || {},
    labels: p.Labels || [],
    favorite: !!p.Favorite,
    onSale: saleFlag(p),
    saleLabels: (p.Labels || []).filter((l) => /discount|prisfald|tilbud|kampagne/i.test(String(l))),
    campaign: campaignOf(p),
  };
}

/** Namlig marks a discounted product with DiscountItem and a Discount/Prisfald label. */
function saleFlag(p) {
  if (p.DiscountItem === true) return true;
  return (p.Labels || []).some((l) => /discount|prisfald|tilbud|kampagne/i.test(String(l)));
}

/** A campaign only bites at a minimum quantity: "5 stk for 39 kr". Keep the numbers. */
function campaignOf(p) {
  const c = p.Campaign;
  if (!c || typeof c !== "object") return null;
  const min = Number(c.MinQuantity || 0);
  const total = Number(c.TotalPrice ?? c.CampaignPrice ?? 0);
  if (!Number.isFinite(min) || min <= 0 || !Number.isFinite(total) || total <= 0) return null;
  return { min, totalPrice: total, type: String(c.Type || c.Attribute || "") };
}

export function loadCache(path = CACHE_PATH) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function saveCache(cache, path = CACHE_PATH) {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeJsonAtomic(path, pruneCache(cache));
}

/** Keep the cache file from growing forever: drop what no run has wanted for a week. */
export function pruneCache(cache, keepHours = CACHE_KEEP_H) {
  const keep = keepHours * 3600 * 1000;
  const out = {};
  for (const [key, entry] of Object.entries(cache || {})) {
    if (entry && Number.isFinite(entry.ts) && Date.now() - entry.ts < keep) out[key] = entry;
  }
  return out;
}

// One query is searched once, even when the gate has four lanes and four intents ask for
// the same milk. The first caller's promise is handed to the others.
const inFlight = new Map();

/** Run one search. Returns mapped products, from cache when fresh, once per query. */
export async function search(mcp, query, { take = DEFAULT_TAKE, cache = null, force = false } = {}) {
  const wanted = clampTake(take);
  const key = norm(query) + "|" + wanted;
  if (!force && cache) {
    const c = cache[key];
    if (c && Date.now() - c.ts < CACHE_TTL_H * 3600 * 1000) {
      return { products: c.products, cached: true, ageMs: Date.now() - c.ts };
    }
  }
  const running = inFlight.get(key);
  if (running) return running;
  const job = fetchSearch(mcp, query, wanted, key, cache);
  inFlight.set(key, job);
  try {
    return await job;
  } catch (e) {
    const fallback = staleFromCache(cache, key);
    if (!fallback) throw e;
    process.stderr.write(`warn: "${query}" is not answerable right now, using the shelf from ${Math.round(fallback.ageMs / 3600000)} h ago\n`);
    return fallback;
  } finally {
    inFlight.delete(key);
  }
}

/** Graceful degradation: the shop cannot answer, so use what was seen last time, and say
 *  so. Older than a week is not a fallback, it is a guess, so it is refused. */
function staleFromCache(cache, key) {
  const c = cache && cache[key];
  if (!c || !Number.isFinite(c.ts) || !Array.isArray(c.products)) return null;
  const ageMs = Date.now() - c.ts;
  if (ageMs > CACHE_KEEP_H * 3600 * 1000) return null;
  return { products: c.products, cached: true, ageMs, stale: true };
}

/** The number of products to ask for: 1-40, whatever the caller wrote. */
function clampTake(take) {
  const n = Math.round(Number(take));
  if (!Number.isFinite(n)) return DEFAULT_TAKE;
  return Math.max(1, Math.min(TAKE_MAX, n));
}

/** One live search, one retry, then the shelf is written to the cache. */
async function fetchSearch(mcp, query, take, key, cache) {
  let r = await mcp.call("search_products", { query, take }, { timeoutMs: CALL_TIMEOUT });
  if (r.isError) {
    // One retry: a single 500 from the search backend must not kill a 60-intent plan.
    r = await mcp.call("search_products", { query, take }, { timeoutMs: CALL_TIMEOUT });
    if (r.isError) throw new Error(`search "${query}" failed twice: ${r.text.slice(0, 160)}`);
  }
  const list = (r.json && r.json.Products && r.json.Products.Products) || [];
  const products = list.map(mapProduct);
  if (cache) cache[key] = { ts: Date.now(), products };
  return { products, cached: false, ageMs: 0 };
}

/**
 * Resolve one intent to one product.
 * intent: { query, need?, mode?, sku?, avoidBrands?, avoidWords?, maxUnitPrice? }
 * Returns { ok, pick, packs, need, why, candidates, alternatives }
 */
export async function resolveIntent(mcp, intent, { cache = null } = {}) {
  const primary = String(intent.query || intent.name || "").trim();
  if (!primary) return { ok: false, why: "empty query" };
  const tries = [primary, ...(intent.alt || [])].map((q) => String(q || "").trim()).filter(Boolean);
  const notes = [];
  let substitution = null;
  let candidates = 0;
  for (const query of tries) {
    const r = await attempt(mcp, query, intent, cache);
    if (r.ok) {
      if (query !== primary) {
        r.why = `swapped from "${primary}" to the profile alt "${query}": ` + r.why;
        r.substitutedFrom = primary;
      }
      return r;
    }
    notes.push(`${query} -> ${r.why}`);
    if (!substitution && r.substitution) substitution = r.substitution;
    candidates = Math.max(candidates, Number(r.candidates) || 0);
  }
  // The proposal survives to the plan file: the person accepts it with the printed --extra flag.
  return { ok: false, query: primary, why: notes.join(" | "), candidates, attempts: tries.length, substitution };
}

/** The name threshold for this intent: the family's own, or MIN_NAME_SCORE, kept
 *  inside the range a shopper would trust (0,5 to 0,95). */
function minNameScore(intent) {
  const v = Number(intent?.purchasing?.minNameScore);
  if (!Number.isFinite(v)) return MIN_NAME_SCORE;
  return Math.min(0.95, Math.max(0.5, v));
}

/** The family's front-of-name words that keep the product itself (rice sold parboiled or
 *  basmati is still the rice the recipe asked for). Empty for a family that wrote none. */
function qualifierWords(intent) {
  const list = intent?.purchasing?.qualifierWords;
  return Array.isArray(list) ? list.slice(0, 40) : [];
}

/** One search, one selection. Returns ok:false with a reason instead of throwing. */
async function attempt(mcp, query, intent, cache) {
  const mode = intent.mode || "cheapest";
  const { products, cached, ageMs, stale } = await search(mcp, query, { take: intent.take || DEFAULT_TAKE, cache, force: !!intent.force });
  if (products.length === 0) return { ok: false, query, why: "search returned nothing", candidates: 0, cached, ageMs };
  const matching = products.filter((p) => nameMatches(query, p.name, minNameScore(intent), qualifierWords(intent)));
  if (matching.length === 0) {
    const top = products.slice(0, 3).map((p) => `${p.name} (score ${nameScore(query, p.name, qualifierWords(intent))})`).join(", ");
    return { ok: false, query, why: `no name reached ${minNameScore(intent)} (best: ${top})`, candidates: products.length, cached, ageMs };
  }
  const need = intent.need ? (typeof intent.need === "string" ? parseNeed(intent.need) : intent.need) : null;
  const pinned = mode === "history" && intent.sku ? matching.find((p) => String(p.id) === String(intent.sku)) : null;
  const pinMissed = mode === "history" && intent.sku && !pinned ? String(intent.sku) : null;
  if (pinned) {
    const packs = need ? packsFor(need, pinned.pack, { pieceGrams: pieceGrams(pinned.name), name: pinned.name }) : 1;
    return {
      ok: true, query, mode, pick: pickOf(pinned), packs, need,
      total: Number((pinned.price * packs).toFixed(2)),
      why: "family favourite sku, still in stock" + (pinned.onSale ? "; tilbud" : ""), compare: "sku-pin",
      candidates: matching.length, cached, ageMs, stale,
      alternatives: matching.filter((p) => p.id !== pinned.id).slice(0, 3).map(altOf),
    };
  }
  const res = cheapest(matching, {
    avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice,
    preferSale: intent.preferSale, saleTolerancePct: intent.saleTolerancePct,
  });
  if (!res.pick) {
    const sub = await proposeSubstitute(mcp, query, intent, cache);
    return { ok: false, query, why: "all " + matching.length + " name matches were unavailable" + (sub ? " - cheapest alternative found, see substitution" : ""),
      candidates: matching.length, substitution: sub, cached, ageMs };
  }
  // One decision over the whole shelf, as a person does: cover the need for the lowest
  // total price, with bounded slack. Falls back to ceil(need/pack) when the need cannot
  // be compared with any pack on the shelf.
  const bought = need && (res.pool || []).length > 0
    ? choosePack(need, res.pool, { name: res.pick.name, ...(intent.purchasing || {}) })
    : null;
  const chosen = bought ? bought.candidate : res.pick;
  const packs = bought ? bought.packs : (need ? packsFor(need, res.pick.pack, { pieceGrams: pieceGrams(res.pick.name), name: res.pick.name }) : 1);
  // Warn only when the need was a weight/volume and the pack is a different scale.
  // A need in pieces ("2 stk") is always satisfied as 2 packs, so it is not a mismatch.
  const SCALE = new Set(["g", "kg", "ml", "l", "cl"]);
  const mismatch = !bought && need && res.pick.pack.qty === null && SCALE.has(need.unit)
    ? `pack size unreadable, bought ${packs} pack`
    : !bought && need && SCALE.has(need.unit) && res.pick.pack.unit && SCALE.has(res.pick.pack.unit) && res.pick.pack.unit !== need.unit
      ? `need ${need.qty} ${need.unit}, pack is ${res.pick.pack.qty} ${res.pick.pack.unit} - bought ${packs} pack`
      : null;
  const bits = [];
  bits.push(mode === "history" && intent.sku ? `usual sku ${intent.sku} not offered today — cheapest option used` : "cheapest per unit");
  if (res.saleNote) bits.push(res.saleNote);
  if (bought) bits.push(bought.why);

  const why = bits.join("; ");
  return {
    ok: true, query, mode, pick: pickOf(chosen), packs, need,
    total: Number((chosen.price * packs).toFixed(2)),
    why: mismatch ? why + "; " + mismatch : why,
    compare: res.mode, candidates: matching.length, cached, ageMs, stale, pinMissed, campaignTip: res.campaignTip || null,
    alternatives: (res.alternatives || []).map(altOf),
  };
}

/**
 * Nothing in stock under this name: find the nearest product and PROPOSE it.
 * A proposal is never added to the basket - it is accepted by re-running the
 * plan with the printed --extra flag.
 */
async function proposeSubstitute(mcp, query, intent, cache) {
  for (const q of substitutionQueries(query, intent.alt || [])) {
    let products;
    try {
      ({ products } = await search(mcp, q, { take: DEFAULT_TAKE, cache, force: false }));
    } catch {
      continue;
    }
    const pool = products.filter((p) => nameMatches(q, p.name, minNameScore(intent), qualifierWords(intent)));
    const res = cheapest(pool, {
      avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice,
    preferSale: intent.preferSale, saleTolerancePct: intent.saleTolerancePct,
    });
    if (!res.pick) continue;
    const need = intent.need ? parseNeed(intent.need) : null;
    return {
      query: q, sku: res.pick.id, name: res.pick.name, brand: res.pick.brand, price: res.pick.price,
      unitPrice: res.pick.unitPrice, unitLabel: res.pick.unitLabel, onSale: !!res.pick.onSale,
      packs: need ? packsFor(need, res.pick.pack) : 1,
      accept: `--extra "${res.pick.name}:${intent.need || "1 stk"}"`,
    };
  }
  return null;
}

/** Search strings for a substitute: the profile alts first, then the head noun. */
function substitutionQueries(query, alt) {
  const out = [...(alt || []), ...tokens(query).slice(0, 2), norm(query).split(" ")[0]];
  return [...new Set(out.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 3);
}

function pickOf(p) {
  return {
    sku: p.id, name: p.name, brand: p.brand, price: p.price, unitPrice: p.unitPrice,
    unitLabel: p.unitLabel, pack: p.pack, url: p.url, mainGroup: p.mainGroup, favorite: p.favorite,
    onSale: !!p.onSale, saleLabels: p.saleLabels || [],
  };
}
function altOf(a) {
  return { sku: a.id, name: a.name, price: a.price, unitPrice: a.unitPrice };
}
function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

const USAGE = 'usage: node catalog.mjs search "<query>" [--take N] | pick "<query>" [--need 300g] [--mode cheapest|history] [--sku S]';

async function cli() {
  const cmd = process.argv[2];
  const q = process.argv[3];
  // --help answers from here and never reaches the shop, the cache or the gate.
  if (process.argv.includes("--help") || process.argv.includes("-h")) { console.log(USAGE); return; }
  warnUnknownFlags(process.argv, CATALOG_FLAGS);
  if (!cmd || !q) {
    console.log(USAGE);
    process.exitCode = 2;
    return;
  }
  const { mcp } = await connectGated({ minIntervalMs: 120 });
  const cache = loadCache();
  if (cmd === "search") {
    const r = await search(mcp, q, { take: Number(arg("take", String(DEFAULT_TAKE))) || DEFAULT_TAKE, cache });
    saveCache(cache);
    console.log(JSON.stringify(r.products.map((p) => ({
      sku: p.id, name: p.name, brand: p.brand, price: p.price, unitPrice: p.unitPrice,
      unitLabel: p.unitLabel, pack: p.pack.raw, available: p.availability.IsDeliveryAvailable && p.availability.IsAvailableInStock,
    })), null, 1));
    return;
  }
  if (cmd === "pick") {
    const r = await resolveIntent(mcp, {
      query: q, need: arg("need", null), mode: arg("mode", "cheapest"), sku: arg("sku", null),
      avoidBrands: (arg("avoid", "") || "").split(",").filter(Boolean),
    }, { cache });
    saveCache(cache);
    console.log(JSON.stringify(r, null, 1));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  console.log("unknown command " + cmd);
  process.exitCode = 2;
}

if (import.meta.url === "file://" + process.argv[1]) cli().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
