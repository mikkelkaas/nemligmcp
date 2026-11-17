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
import { parsePack, packsFor, cheapest, choosePack, pieceWeightOf, eligibleOf } from "./units.mjs";
import { nameMatches, shelfContext, norm, tokens, score as nameScore, MIN_NAME_SCORE } from "./match.mjs";

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
  let nearMiss = null;
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
    if (!nearMiss && Array.isArray(r.nearMiss) && r.nearMiss.length) nearMiss = r.nearMiss;
    candidates = Math.max(candidates, Number(r.candidates) || 0);
  }
  // The proposal survives to the plan file: the person accepts it with the printed --extra flag.
  return {
    ok: false, query: primary, why: notes.join(" | "), candidates, attempts: tries.length, substitution,
    nearMiss: nearMiss || [], nearNeed: typeof intent.need === "string" ? intent.need : null,
  };
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

/** How far below the family's own bar the shop's answer still counts as the right product
 *  with the wrong wording. Further down the answer is a different product, not a name. */
export const NEAR_MISS_BAND = 0.15;

/** The buyable products that came within NEAR_MISS_BAND of the bar, best score first, at most
 *  two. Never bought: a near miss is printed with the one flag that takes it, so an
 *  unresolved line ends as a decision to read instead of a dead end. The never-list and the
 *  price ceiling apply here too - a near miss on a refused brand helps nobody. */
function nearMissOf(query, products, threshold, intent) {
  const split = eligibleOf(products, {
    avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice, maxFatPct: intent.maxFatPct,
  });
  const words = qualifierWords(intent);
  return split.eligible
    .map((p) => ({ p, score: nameScore(query, p.name, words, shelfContext(p)) }))
    .filter((s) => s.score < threshold && s.score >= threshold - NEAR_MISS_BAND)
    .sort((a, b) => b.score - a.score
      || (Number(a.p.unitPrice) || Number.MAX_VALUE) - (Number(b.p.unitPrice) || Number.MAX_VALUE))
    .slice(0, 2)
    .map((s) => ({ ...altOf(s.p), score: Number(s.score.toFixed(2)) }));
}

/** The flag that takes this product, written so pasting it buys this product and nothing else.
 *  A name holding a double quote cannot sit between double quotes: the shell ends the word at
 *  the inner quote and joins the rest to the next argument. So such a name goes between single
 *  quotes instead - Danish shelf names use the double kind. A name holding both kinds gets no
 *  flag at all: the caller prints the sku, and `--extra-file` is the way to take it. Nothing
 *  here is ever passed to a shell by this code; the text is read by a person and typed once. */
export function extraFlag(name, need) {
  const value = `${name}${need ? ":" + need : ""}`;
  if (!String(name).includes(`"`)) return `--extra "${value}"`;
  if (!String(name).includes("'")) return `--extra '${value}'`;
  return null;
}

/** One search, one selection. Returns ok:false with a reason instead of throwing. */
async function attempt(mcp, query, intent, cache) {
  const mode = intent.mode || "cheapest";
  const { products, cached, ageMs, stale } = await search(mcp, query, { take: intent.take || DEFAULT_TAKE, cache, force: !!intent.force });
  if (products.length === 0) return { ok: false, query, why: "search returned nothing", candidates: 0, cached, ageMs };
  const matching = products.filter((p) => nameMatches(query, p.name, minNameScore(intent), qualifierWords(intent), shelfContext(p)));
  if (matching.length === 0) {
    // The three names the shop answered with, each with the score it reached, so a
    // blocked line is a decision a person can read rather than a magic number.
    const threshold = minNameScore(intent);
    const top = products.slice(0, 3).map((p) => `${p.name} (score ${nameScore(query, p.name, qualifierWords(intent), shelfContext(p))})`).join(", ");
    // A word the shop spells differently is the same dead end as a shelf that is empty: the
    // line has to carry an answer either way. Same shortlist as the out-of-stock branch.
    const sub = await proposeSubstitute(mcp, query, intent, cache);
    return {
      ok: false, query, why: `no name reached ${threshold} (best: ${top})`
        + (sub ? " - closest the shelf has, see substitution" : ""),
      candidates: products.length, cached, ageMs, substitution: sub,
      // Two names that came close, if the shelf holds any, each with what it costs. The plan
      // prints them with the flag that takes one, so the line is not a dead end.
      nearMiss: nearMissOf(query, products, threshold, intent),
    };
  }
  const need = intent.need ? (typeof intent.need === "string" ? parseNeed(intent.need) : intent.need) : null;
  const pinned = mode === "history" && intent.sku ? matching.find((p) => String(p.id) === String(intent.sku)) : null;
  // A pinned favourite is still bound by the family's never-list. "Never this brand" is the
  // stronger statement of the two, and the rivals below are filtered that way already - the
  // pin was not, so a brand the family refused came back as the favourite. maxUnitPrice is
  // deliberately NOT checked here: that is a price preference, and sale-vs-usual below
  // already trades the pin against the rivals on price.
  const pinCheck = pinned ? eligibleOf([pinned], { avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxFatPct: intent.maxFatPct }) : null;
  const pinRefused = pinCheck && pinCheck.eligible.length === 0 ? (pinCheck.rejected[0] || { why: "refused by the never-list" }) : null;
  const keep = pinned && !pinRefused ? pinned : null;
  const pinMissed = mode === "history" && intent.sku && !keep ? String(intent.sku) : null;
  if (keep) {
    const packs = need ? packsFor(need, keep.pack, { pieceWeight: pieceWeightOf(keep), name: keep.name }) : 1;
    // The rivals of the sku the family actually buys, through the same filter as any
    // other pick: deliverable, not an avoided brand, under the unit-price ceiling. A
    // trim decision reads these, so it never promises a saving the shop cannot deliver.
    const rivals = eligibleOf(matching.filter((p) => String(p.id) !== String(keep.id)), {
      avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice, maxFatPct: intent.maxFatPct,
    }).eligible.slice()
      .sort((a, b) => (Number(a.unitPrice) || Number.MAX_VALUE) - (Number(b.unitPrice) || Number.MAX_VALUE)
        || (Number(a.price) || Number.MAX_VALUE) - (Number(b.price) || Number.MAX_VALUE))
      .slice(0, 3);
    const pinTotal = Number((keep.price * packs).toFixed(2));
    const sale = saleBeatsPin(query, keep, packs, rivals.map(altOf), need, intent);
    if (sale) {
      const kept = [pickOf(keep)].concat(rivals.filter((r) => String(r.id) !== String(sale.rival.id)));
      return {
        ok: true, query, mode, pick: pickOf(sale.rival), packs: sale.packs, need, total: sale.total,
        packWindow: intent.packWindow || null,
        why: `the usual sku ${keep.id} is not today's deal: ${sale.rival.name} on sale, ${sale.packs} x `
          + `${Number(sale.rival.price).toFixed(2)} kr = ${sale.total.toFixed(2)} kr against ${pinTotal.toFixed(2)} kr `
          + `for the usual (${keep.name})`,
        compare: "sale-vs-usual", usual: keep.id, savedKr: sale.savedKr,
        candidates: matching.length, cached, ageMs, stale,
        alternatives: kept.slice(0, 3).map(altOf),
      };
    }
    return {
      ok: true, query, mode, pick: pickOf(keep), packs, need,
      packWindow: intent.packWindow || null,
      total: pinTotal,
      why: "family favourite sku, still in stock" + (keep.onSale ? "; tilbud" : ""), compare: "sku-pin",
      candidates: matching.length, cached, ageMs, stale,
      alternatives: rivals.map(altOf),
    };
  }
  const res = cheapest(matching, {
    avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice, maxFatPct: intent.maxFatPct,
    preferSale: intent.preferSale, saleTolerancePct: intent.saleTolerancePct,
  });
  if (!res.pick) {
    const sub = await proposeSubstitute(mcp, query, intent, cache);
    // "Unavailable" and "refused" are different sentences. A shelf that holds exactly the
    // product your never-list refuses is not empty, and a person reading "not available"
    // would go looking for stock instead of reading their own words.
    const split = eligibleOf(matching, { avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice, maxFatPct: intent.maxFatPct });
    const refusals = [...new Set(split.rejected.filter((r) => /brand|name says/i.test(String(r.why || ""))).map((r) => r.why))];
    const refusedText = refusals.length && split.eligible.length === 0
      ? `; your own never-list refused them (${refusals.slice(0, 2).join(", ")})` : "";
    return { ok: false, query, why: "all " + matching.length + " name matches were unavailable" + refusedText
        + (sub ? " - cheapest alternative found, see substitution" : ""),
      candidates: matching.length, substitution: sub, cached, ageMs,
      pinMissed: pinMissed || null, pinRefused: pinRefused ? String(pinRefused.why || "refused by the never-list") : null };
  }
  // One decision over the whole shelf, as a person does: cover the need for the lowest
  // total price, with bounded slack. Falls back to ceil(need/pack) when the need cannot
  // be compared with any pack on the shelf.
  const onShelf = (res.shelf && res.shelf.length ? res.shelf : res.pool) || [];
  // A rule may name the smallest pack this family buys of a loose good (onions by the net,
  // not three single pieces). It travels on the intent, never in the profile block, so a
  // floor set for one good cannot quietly raise every other pack on the basket.
  const packOpts = { name: res.pick.name, pieceWeight: pieceWeightOf(res.pick), ...(intent.purchasing || {}) };
  if (Number(intent.minPackGrams) > 0) packOpts.minPackGrams = Number(intent.minPackGrams);
  if (intent.packWindow) packOpts.packWindow = intent.packWindow;
  const bought = need && onShelf.length > 0 ? choosePack(need, onShelf, packOpts) : null;
  const chosen = bought ? bought.candidate : res.pick;
  const packs = bought ? bought.packs : (need ? packsFor(need, res.pick.pack, { pieceWeight: pieceWeightOf(res.pick), name: res.pick.name }) : 1);
  // Warn only when the need was a weight/volume and the pack is a different scale.
  // A need in pieces ("2 stk") is always satisfied as 2 packs, so it is not a mismatch.
  const SCALE = new Set(["g", "kg", "ml", "l", "cl"]);
  const mismatch = !bought && need && res.pick.pack.qty === null && SCALE.has(need.unit)
    ? `pack size unreadable, bought ${packs} pack`
    : !bought && need && SCALE.has(need.unit) && res.pick.pack.unit && SCALE.has(res.pick.pack.unit) && res.pick.pack.unit !== need.unit
      ? `need ${need.qty} ${need.unit}, pack is ${res.pick.pack.qty} ${res.pick.pack.unit} - bought ${packs} pack`
      : null;
  const bits = [];
  if (mode === "history" && intent.sku) {
    // Two different reasons, and a person reads them differently: the shelf let the
    // favourite go, or the family's own never-list outranked it.
    bits.push(pinRefused
      ? `usual sku ${intent.sku} refused: ${pinRefused.why} - your own never-list outranks the favourite`
      : `usual sku ${intent.sku} not offered today — cheapest option used`);
  } else bits.push("cheapest per unit");
  if (res.saleNote) bits.push(res.saleNote);
  if (bought) bits.push(bought.why);
  // Say it out loud when the winner is priced on a different axis than the shelf's
  // cheapest per unit: a person reading "4 kr" against "13,33 kr" should not have to
  // work out that one is per head and the other per kilo.
  if (bought && bought.candidate && String(bought.candidate.unitLabel || "") !== String(res.pick.unitLabel || "")) {
    bits.push(`priced ${bought.candidate.unitLabel || "per pack"} against ${res.pick.unitLabel || "per pack"} on this shelf - the total for what the plan asked for decided it`);
  }

  const why = bits.join("; ");
  return {
    ok: true, query, mode, pick: pickOf(chosen), packs, need,
    packWindow: intent.packWindow || null,
    total: Number((chosen.price * packs).toFixed(2)),
    why: mismatch ? why + "; " + mismatch : why,
    compare: res.mode, candidates: matching.length, cached, ageMs, stale, pinMissed,
    // The reason the favourite was not bought, when the family's own never-list is why. The
    // plan prints it, so a pin that vanished is never mistaken for a product out of stock.
    pinRefused: pinRefused ? String(pinRefused.why || "refused by the never-list") : null,
    campaignTip: res.campaignTip || null,
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
    const pool = products.filter((p) => nameMatches(q, p.name, minNameScore(intent), qualifierWords(intent), shelfContext(p)));
    const res = cheapest(pool, {
      avoidBrands: intent.avoidBrands, avoidWords: intent.avoidWords, maxUnitPrice: intent.maxUnitPrice, maxFatPct: intent.maxFatPct,
    preferSale: intent.preferSale, saleTolerancePct: intent.saleTolerancePct,
    });
    if (!res.pick) continue;
    const need = intent.need ? parseNeed(intent.need) : null;
    return {
      query: q, sku: res.pick.id, name: res.pick.name, brand: res.pick.brand, price: res.pick.price,
      unitPrice: res.pick.unitPrice, unitLabel: res.pick.unitLabel, onSale: !!res.pick.onSale,
      packs: need ? packsFor(need, res.pick.pack) : 1,
      accept: extraFlag(res.pick.name, intent.need || "1 stk") || `--extra-file (sku ${res.pick.id}: the name holds both quote kinds)`,
      // Said out loud, because the family asked for words the shelf does not answer with: they
      // read which word was dropped, and ignore the line if that word was the point.
      foundBy: q !== query ? `searched as "${q}"` : null,
    };
  }
  return null;
}

/**
 * Queries with ONE word taken out, in the order a person would shorten them: the first word
 * goes first, because in a Danish shelf line the leading word is usually how it was cooked
 * ("stegt gulerødder", "grovbrød øko skiver"), and the word that names the thing is
 * the one that stays. At most three, and never for a one-word query, so a blocked line costs
 * the shop at most three extra reads and the shelf a word it must still match whole.
 */
export function relaxedQueries(query) {
  // The raw words, not the matcher's tokens: the matcher drops the small words on purpose, and a
  // query built from what survives is not a phrase the shop's own search would answer.
  const words = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return [];
  const drops = [0, words.length - 1, ...words.slice(1, -1).map((_, i) => i + 1)];
  const out = [];
  for (const i of drops) {
    if (out.length >= 3) break;
    const cut = words.filter((_, j) => j !== i).join(" ").trim();
    if (cut && cut.split(/\s+/).length >= 1 && !out.includes(cut)) out.push(cut);
  }
  return out;
}

/** Search strings for a substitute: the profile alts, then the word-shortened queries, then the
 *  head nouns. Bounded at four, so one blocked line cannot spend the whole shop budget. */
function substitutionQueries(query, alt) {
  const out = [...(alt || []), ...relaxedQueries(query), ...tokens(query).slice(0, 2), norm(query).split(" ")[0]];
  return [...new Set(out.map((s) => String(s || "").trim()).filter(Boolean))].slice(0, 4);
}

/**
 * The sale rule, measured against the sku this family actually buys.
 *
 * Until now a pinned favourite was never weighed against a tilbud: the cheapest path
 * compared the shelf's cheapest, and the pinned path stopped at "your usual, in stock".
 * Here the pin is the baseline, and a rival takes its place only when it is on sale AND
 * cheaper for the SAME need - a 6-pack on sale can still cost more than one carton, so the
 * comparison is what the family pays, not the label price. `budget.swapNeverWords` protects
 * a line here too: nobody swaps a diaper size for a discount. And the rival must answer the
 * family's words at least as well as the usual product does - "Mayonnaise" does not say
 * "(let)", and a cheaper mayonnaise that is not the light one is not the same shop.
 * pin: the pinned product. pinPacks: the packs the pin would have been bought in.
 */
export function saleBeatsPin(query, pin, pinPacks, alternatives, need, intent = {}) {
  if (!pin || pin.onSale || !(alternatives || []).length) return null;
  const purchasing = intent.purchasing || {};
  if (intent.preferSale === false || purchasing.preferSale === false) return null;
  // The words the family typed AND its usual product carries. "Mayonnaise (let)" has
  // "let"; a plain "Mayonnaise" does not, and a cheaper mayonnaise that is not the light
  // one is a different purchase, however good the tilbud is. The scorer cannot see this:
  // it asks whether the name answers the query, and both names answer it.
  const typed = new Set(String(norm(query)).split(" ").filter((w) => w.length > 2));
  const asked = new Set(String(norm(pin && pin.name)).split(" ").filter((w) => w.length > 2 && typed.has(w)));
  const keepsTheWords = (name) => {
    const has = new Set(String(norm(name)).split(" "));
    return [...asked].every((w) => has.has(w));
  };
  const never = (purchasing.swapNeverWords || []).map((w) => String(w).toLowerCase()).filter(Boolean);
  const protectedLine = (t) => never.some((w) => String(t || "").toLowerCase().includes(w));
  if (protectedLine(pin.name) || protectedLine(pin.brand)) return null;
  const packsOfPin = Math.max(1, Number(pinPacks) || 1);
  const pinTotal = Number((Number(pin.price) * packsOfPin).toFixed(2));
  if (!(pinTotal > 0)) return null;
  let best = null;
  for (const alt of alternatives.slice(0, 3)) {
    if (!alt || !alt.sku || !alt.onSale) continue;
    if (protectedLine(alt.name) || protectedLine(alt.brand)) continue;
    if (!keepsTheWords(alt.name)) continue;
    const packs = need ? packsFor(need, alt.pack, { pieceWeight: pieceWeightOf(alt), name: alt.name }) : packsOfPin;
    const total = Number((Number(alt.price) * Math.max(1, Number(packs) || 1)).toFixed(2));
    if (!(total > 0) || total >= pinTotal) continue;
    if (!best || total < best.total) {
      best = { rival: alt, packs: Math.max(1, Number(packs) || 1), total, pinTotal, savedKr: Number((pinTotal - total).toFixed(2)) };
    }
  }
  return best;
}

function pickOf(p) {
  return {
    sku: p.id, name: p.name, brand: p.brand, price: p.price, unitPrice: p.unitPrice,
    unitLabel: p.unitLabel, pack: p.pack, url: p.url, mainGroup: p.mainGroup, favorite: p.favorite,
    onSale: !!p.onSale, saleLabels: p.saleLabels || [],
    // The declaration ("2 stk. / 260 g") travels with the pick: the merged re-decision in
    // plan.mjs and the trim both weigh a piece, and neither should have to guess from the
    // product name a second time.
    description: p.description || null,
  };
}
function altOf(a) {
  // pack travels: "cheaper" is only cheaper once the same need is covered, and that
  // needs the alternative's pack size, not just its label price.
  return {
    sku: a.id, name: a.name, brand: a.brand, price: a.price, unitPrice: a.unitPrice,
    unitLabel: a.unitLabel || null, pack: a.pack || null, onSale: !!a.onSale,
    description: a.description || null,
  };
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
