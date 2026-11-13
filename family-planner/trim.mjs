// trim.mjs — make a plan fit a hard ceiling, in the order a person would.
//
// The soft cap (`budget.softCapKr`) only warns, because a warning is all a soft number
// can ask for. A ceiling (`budget.maxKrPerPlan`) has to decide, and deciding means doing
// something. This module does it in two moves and prints both:
//
//   1. the brand, not the product. The shelf usually carries a rival that satisfies the
//      same name guard the planner already applied; if it covers the same need for
//      clearly less money, buy that instead. Nothing leaves the basket.
//   2. a line back on the shelf. Only when the swaps were not enough, and least-hurt
//      first: a treat before the household, the household before breakfast, breakfast
//      before the child's lunch box. A dinner's own ingredient is never touched — a
//      basket without its potatoes is not cheaper, it is a second trip to the shop.
//
// Every move is returned as an action so plan.mjs can print it, the plan file can keep
// it, and apply.mjs can check it. Nothing here calls the shop: it only reads what the
// resolver already found, which is what makes a trimmed plan testable.
import { choosePack, packsFor } from "./units.mjs";

/** How much a family notices this line missing. Higher means harder to cut. */
// "lunchbox" is what plan.mjs calls the block, "kidLunchbox" is what the pantry file
// calls it. Both are the child's box, and both are the last thing a ceiling may cut.
const PROTECT = { snacks: 1, household: 2, breakfast: 3, lunchbox: 4, kidLunchbox: 4, extra: 5 };
/** A dinner's own ingredient: the evening has no meal without it. */
const NEVER = 0;
/** A block this planner does not know is treated as household: needed, but not a meal. */
const UNKNOWN_RANK = 2;
/** What the ranks are called in the report, so a deferral reads as a sentence. */
const RANK_LABEL = {
  [NEVER]: "a dinner", [PROTECT.snacks]: "a treat", [PROTECT.household]: "the household",
  [PROTECT.breakfast]: "breakfast", [PROTECT.lunchbox]: "the child's lunch box",
  [PROTECT.kidLunchbox]: "the child's lunch box", [PROTECT.extra]: "an item you asked for",
};

/**
 * The protection of one plan line: the most protected thing it feeds, because cutting it
 * hurts that one too. Any dinner source makes it untouchable.
 */
export function rankOf(item) {
  const sources = (item && item.sources) || [];
  if (sources.some((s) => String(s).startsWith("dinner:"))) return NEVER;
  let rank = -1;
  for (const s of sources) {
    const block = String(s).split(":")[0];
    rank = Math.max(rank, block in PROTECT ? PROTECT[block] : UNKNOWN_RANK);
  }
  return rank < 0 ? UNKNOWN_RANK : rank;
}

export function rankLabel(rank) {
  return RANK_LABEL[rank] || "the household";
}

/**
 * How many packs of `alt` cover the need this line was bought for.
 * A need in grams or litres is decided with the planner's own pack maths; a need counted
 * in packs ("2 stk") stays two packs, because a bigger carton of the same thing does not
 * make the family drink less milk.
 */
export function packsForAlt(item, alt, purchasing) {
  const qty = Number(item.needAmount), unit = String(item.needMeasure || "");
  const need = Number.isFinite(qty) && qty > 0 && unit ? { qty, unit } : null;
  if (!need) return { packs: Math.max(1, Number(item.packs) || 1), why: "same number of packs" };
  const cand = { sku: alt.sku, name: alt.name, price: Number(alt.price), pack: alt.pack || null, unitPrice: alt.unitPrice };
  const bought = choosePack(need, [cand], { name: cand.name, ...(purchasing || {}) });
  if (bought && bought.candidate) return { packs: Math.max(1, Number(bought.packs) || 1), why: bought.why };
  const packs = packsFor(need, cand.pack, { name: cand.name });
  const label = cand.pack && cand.pack.qty ? `${cand.pack.qty} ${cand.pack.unit || "stk"}` : "1 pack";
  return { packs: Math.max(1, Number(packs) || 1), why: `${need.qty} ${need.unit} as ${Math.max(1, Number(packs) || 1)} x ${label}` };
}

const GRAMS = { g: 1, kg: 1000 };
const LITRES = { ml: 0.001, cl: 0.01, l: 1 };
const PIECES = { stk: 1 };

/**
 * What a pack x packs really is: grams, litres or pieces - or null when the shop did not
 * say. A 180 g cup at 9,95 kr is not cheaper than a 430 g tub at 30,95 kr, and the only
 * thing that tells those apart is the pack size.
 */
export function delivered(pack, packs) {
  const qty = Number(pack && pack.qty);
  const unit = String((pack && pack.unit) || "").toLowerCase().trim().replace(/\.$/, "");
  if (!Number.isFinite(qty) || qty <= 0) return null;
  const n = Math.max(1, Number(packs) || 1);
  if (GRAMS[unit]) return { measure: "g", value: Number((qty * GRAMS[unit] * n).toFixed(2)) };
  if (LITRES[unit]) return { measure: "l", value: Number((qty * LITRES[unit] * n).toFixed(4)) };
  if (PIECES[unit]) return { measure: "stk", value: Number((qty * n).toFixed(2)) };
  return null;
}

/** "430 g", "1500 ml", "10 stk" - what the report shows beside a price. */
function packLabel(pack) {
  const qty = Number(pack && pack.qty), unit = String((pack && pack.unit) || "").trim();
  if (!Number.isFinite(qty) || qty <= 0) return null;
  return `${qty} ${unit || "pack"}`;
}

/**
 * A line the family will not have swapped, by word in its name or brand: the words in
 * `budget.swapNeverWords`. A diaper size, a medicine, the one bread a child eats - one
 * word in the profile ("Bleer") and the planner keeps its hands off that line.
 */
function swapNever(name, words) {
  const fold = String(name || "").toLowerCase();
  return words.some((w) => w && fold.includes(w));
}

/**
 * The best swap available for one line, or null.
 * An alternative must be a different product the shop can deliver (the resolver filtered
 * those already), must not be something else in this same plan (two lines on one sku would
 * need the whole pack decision again), and must save at least `minSwapKr` — a 1 kr saving
 * is brand churn, not a saving.
 */
export function bestSwap(item, opts = {}) {
  const minSwap = Number.isFinite(Number(opts.minSwapKr)) ? Math.max(0, Number(opts.minSwapKr)) : 5;
  const taken = opts.planSkus || new Set();
  const never = (Array.isArray(opts.swapNeverWords) ? opts.swapNeverWords : []).map((w) => String(w).toLowerCase());
  if (swapNever(item.name, never) || swapNever(item.brand, never)) return null;
  const mine = delivered(item.pack, item.packs);
  const base = Number(item.total);
  if (!Number.isFinite(base) || base <= 0) return null;
  let best = null;
  for (const alt of (item.alternatives || []).slice(0, 5)) {
    if (!alt || !alt.sku || String(alt.sku) === String(item.sku)) continue;
    if (taken.has(String(alt.sku))) continue;
    if (!Number.isFinite(Number(alt.price)) || Number(alt.price) <= 0) continue;
    const packs = packsForAlt(item, alt, opts.purchasing);
    const total = Number((Number(alt.price) * packs.packs).toFixed(2));
    if (total > 0 && base - total < minSwap) continue;
    const theirs = delivered(alt.pack, packs.packs);
    // A cheaper box holding under nine tenths of what the family was getting is not a
    // saving, it is a smaller shop. A tenth of slack covers the pack sizes that nearly
    // meet, because a 180 g cup and a 200 g cup are the same breakfast.
    if (mine && theirs && mine.measure === theirs.measure && theirs.value < mine.value * 0.9) continue;
    if (!best || total < best.total) best = { alt, packs: packs.packs, total, why: packs.why, mine, theirs };
  }
  if (!best || base - best.total < minSwap) return null;
  return { ...best, savedKr: Number((base - best.total).toFixed(2)) };
}

function totalOf(list) {
  return Number(list.reduce((sum, i) => sum + (Number(i.total) || 0), 0).toFixed(2));
}

function sourceLabel(item) {
  return (item.sources || []).join(",") || item.name;
}

/** One swap, the biggest saving first. Returns true when it applied something. */
function swapOnce(list, cap, opts, actions) {
  const planSkus = new Set(list.map((i) => String(i.sku)));
  const ranked = [];
  for (const item of list) {
    const swap = bestSwap(item, { ...opts, planSkus });
    if (swap) ranked.push({ item, swap });
  }
  if (ranked.length === 0) return false;
  ranked.sort((a, b) => b.swap.savedKr - a.swap.savedKr || String(a.item.name).localeCompare(String(b.item.name)));
  const { item, swap } = ranked[0];
  actions.push({
    action: "swap", source: sourceLabel(item), name: item.name,
    from: { sku: item.sku, name: item.name, brand: item.brand, price: Number(item.price), packs: item.packs, total: Number(item.total) },
    to: { sku: swap.alt.sku, name: swap.alt.name, brand: swap.alt.brand, price: Number(swap.alt.price), packs: swap.packs, total: swap.total },
    fromPack: packLabel(item.pack), toPack: packLabel(swap.alt.pack),
    savedKr: swap.savedKr, why: swap.why,
  });
  item.sku = swap.alt.sku; item.name = swap.alt.name; item.brand = swap.alt.brand;
  item.price = Number(swap.alt.price); item.packs = swap.packs; item.total = swap.total;
  item.unitPrice = swap.alt.unitPrice ?? item.unitPrice; item.unitLabel = swap.alt.unitLabel ?? item.unitLabel;
  item.pack = swap.alt.pack || item.pack; item.onSale = !!swap.alt.onSale;
  item.url = null; item.alternatives = [];
  item.trimmed = "swap";
  item.why = `${item.why}; trimmed to ${swap.alt.name} for ${swap.savedKr.toFixed(2)} kr less (${swap.why})`;
  return true;
}

/** One line put back, least-hurt block first and the dearest line in it first. */
function deferOnce(list, cap, opts, actions) {
  const cuttable = list.map((item, at) => ({ item, at, rank: rankOf(item) })).filter((x) => x.rank > NEVER);
  if (cuttable.length === 0) return false;
  cuttable.sort((a, b) => a.rank - b.rank
    || (Number(b.item.total) || 0) - (Number(a.item.total) || 0)
    || String(a.item.name).localeCompare(String(b.item.name)));
  const { item, at, rank } = cuttable[0];
  actions.push({
    action: "defer", source: sourceLabel(item), rank, protectedBy: rankLabel(rank),
    name: item.name, sku: item.sku, brand: item.brand, total: Number(item.total),
    why: `${rankLabel(rank)} line put back on the shelf${item.everyNDays ? `, due again every ${item.everyNDays} d` : ""}`,
  });
  list.splice(at, 1);
  return true;
}

/**
 * Fit a plan to `capKr`. opts: { capKr, minSwapKr, purchasing, swapNeverWords }. Returns the trimmed lines, one action per move, the two totals
 * and the shortfall when even that is not enough.
 * items: plan items ({ sku, name, price, packs, total, sources, needMeasure, needAmount,
 * alternatives }). No cap, or a plan already inside it, returns the list untouched.
 */
export function trimItems(items, opts = {}) {
  const cap = Number(opts.capKr);
  const list = (items || []).map((i) => ({ ...i }));
  const before = totalOf(list);
  const actions = [];
  if (!Number.isFinite(cap) || cap <= 0) return { items: list, actions, before, after: before, shortfall: 0 };
  if (before <= cap) return { items: list, actions, before, after: before, shortfall: 0 };
  // One pass per line, counted from the list as it started: a deferred line leaves the
  // list, and a bound that shrinks with it would stop the trimming early.
  const passes = list.length;
  for (let guard = 0; guard < passes && totalOf(list) > cap; guard += 1) {
    if (!swapOnce(list, cap, opts, actions)) break;
  }
  for (let guard = 0; guard < passes && totalOf(list) > cap; guard += 1) {
    if (!deferOnce(list, cap, opts, actions)) break;
  }
  const after = totalOf(list);
  return { items: list, actions, before, after, shortfall: Number(Math.max(0, after - cap).toFixed(2)) };
}
