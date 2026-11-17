// units.mjs — pack-size parsing and unit-price comparison for the Nemlig planner.
//
// Why this exists: "always take the cheapest option" must be a comparison of
// price per base unit (kr/kg, kr/l, kr/stk), not price per pack. Namlig already
// publishes that number on every product (UnitPriceCalc + UnitPriceLabel), so we
// compare those, and only across candidates that share the same label.
// Pack size parsing is a separate job: turn "how much do we need" into "how many
// packs to add". Parsing is best-effort: an unparsed pack means quantity 1.
//
// Pure functions, no network, no side effects. Tested by test/match.test.mjs.

const NUM = "(\\d+(?:[.,]\\d+)?)";

/** Danish comma decimal -> number. Returns null when the token is not a number. */
export function num(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Words that look like a unit after a number but describe something else: a
// measurement of the produce (Dild 7cm), a shelf-life, a year. Never a pack size.
const NOT_A_SIZE = new Set(["cm", "mm", "m", "cm3", "år", "aar", "dag", "dage", "måned", "md"]);

/** Map a Danish package unit to a comparable base unit. */
export function baseUnit(unit) {
  const u = String(unit || "").trim().toLowerCase().replace(/\.$/, "");
  if (NOT_A_SIZE.has(u)) return null;
  const map = {
    g: "g", gram: "g", grammer: "g", kg: "kg",
    ml: "ml", milliliter: "ml", cl: "cl", l: "l", liter: "l",
    stk: "stk", styk: "stk", st: "stk",
    rl: "stk", ruller: "stk", rulle: "stk",
    bdt: "bundt", bundt: "bundt",
    dåse: "dåse", ds: "dåse", flaske: "flaske", fl: "flaske",
    pose: "pose", pos: "pose", bakke: "bakke", bk: "bakke",
    karton: "karton", kt: "karton", skive: "skive", skiver: "skive",
    glas: "glas", dåser: "dåse", flasker: "flaske", poser: "pose",
  };
  return map[u] || u || null;
}

/** Scale a base unit up to grams or ml so kg/l are comparable. Returns null if countable. */
export function toBaseMeasure(qty, unit) {
  const b = baseUnit(unit);
  if (qty === null || b === null) return null;
  if (b === "g") return { measure: "g", value: qty };
  if (b === "kg") return { measure: "g", value: qty * 1000 };
  if (b === "ml") return { measure: "ml", value: qty };
  if (b === "cl") return { measure: "ml", value: qty * 10 };
  if (b === "l") return { measure: "ml", value: qty * 1000 };
  return { measure: b, value: qty };
}

/**
 * Parse a Namlig "Description"/packSize string such as:
 *   "1 kg / Naturmælk"          -> { qty: 1000, unit: "g" }
 *   "0,25 l / Oma"              -> { qty: 250, unit: "ml" }
 *   "24 x 0,33 l / ex. pant"    -> { qty: 7920, unit: "ml" }
 *   "15 stk. / Danæg"           -> { qty: 15, unit: "stk" }
 *   "8 rl. / nemlig plus"       -> { qty: 8, unit: "stk" }
 * Returns { qty, unit, raw } with qty null when the string cannot be parsed.
 */
export function parsePack(text) {
  const raw = String(text || "").trim();
  if (!raw) return { qty: null, unit: null, raw };
  const head = raw.split("/")[0].trim();
  // Multi-pack: "24 x 0,33 l" or "2 x 125 g".
  const multi = new RegExp("^" + NUM + "\\s*x\\s*" + NUM + "\\s*([a-zæøå.]+)", "i").exec(head);
  if (multi) {
    const packs = num(multi[1]);
    const each = num(multi[2]);
    const m = toBaseMeasure(each, multi[3]);
    if (packs && each && m) {
      const scaled = m.measure === "g" || m.measure === "ml"
        ? { measure: m.measure, value: m.value * packs }
        : { measure: m.measure, value: packs };
      return { qty: round2(scaled.value), unit: unitName(scaled), raw };
    }
  }
  // Single amount: "1 kg", "0,25 l", "15 stk.", "8 rl."
  const single = new RegExp("^" + NUM + "\\s*([a-zæøå.]+)", "i").exec(head);
  if (single) {
    const q = num(single[1]);
    const m = toBaseMeasure(q, single[2]);
    if (q && m) {
      return { qty: round2(m.value), unit: unitName(m), raw };
    }
  }
  // Count-only fallback: "Bland selv"-type lines with no leading number.
  const count = new RegExp(NUM + "\\s*([a-zæøå]+)\\.", "i").exec(head);
  if (count) {
    const q = num(count[1]);
    const m = toBaseMeasure(q, count[2]);
    if (q && m) return { qty: round2(m.value), unit: unitName(m), raw };
  }
  return { qty: null, unit: null, raw };
}

// A need given in pieces always means that many PACKS, whatever the pack is
// measured in: "2 stk kokosmælk" is 2 cans, not 2 grams and not 1 can.
/** Units that measure a quantity (g, kg, ml, l) - as opposed to counting pieces. */
export const MEASURE_UNITS = new Set(["g", "kg", "ml", "l"]);
const COUNT_UNITS = new Set(["stk", "dåse", "flaske", "pose", "karton", "skive", "glas", "bakke", "bundt"]);

/**
 * Typical gram weight of one piece of the produce we buy loose. Used when a need counts
 * pieces and the shelf sells weight: "8 pærer" has to meet a 1 kg bag, not buy 3 of them.
 * Weights are the middle of what Namlig sells loose, so a plan is never off by a factor.
 */
export const PIECE_GRAMS = {
  pære: 190, æble: 170, citron: 100, lime: 70, appelsin: 150, mandarin: 90, banana: 120, banan: 120,
  avocado: 200, agurk: 600, peberfrugt: 150, gulerod: 90, løg: 110, kartoffel: 90,
  chili: 15, broccoli: 400, blomkål: 900, majs: 220, melon: 1200, fennikel: 150, radise: 10,
  // A loose piece of garlic is a whole head, which is what the shop sells it as. One of
  // its cloves is `fed` in SUBUNIT_GRAMS - the two numbers are not interchangeable, and
  // 8 g here once made 6 cloves of garlic read as 6 of whatever a 200 g net bag is.
  spinat: 30, purløg: 5, persille: 15, ingefær: 40, svamp: 20, æg: 65, tomat: 120, agurkesalat: 600,
  hvidløg: 50,
};

/**
 * A recipe counts PARTS of the unit the shop sells: "6 fed hvidløg" is six cloves off
 * one head, "3 skiver brød" is three slices off one loaf. A part is not a pack, so it
 * must never be answered with that many packs - which is what "1 stk" silently allowed.
 * Weighed into grams where the need is made, so the shelf is met with a measure like
 * any other. A family that reads a number differently sets it in their profile under
 * `purchasing.pieceWeights`; a word that is not listed stays a piece, never a guess.
 */
export const SUBUNIT_GRAMS = { fed: 5, skive: 25, skiver: 25, bådkartoffel: 120 };

/** A spoon is a measure, not a pack. The recipe page's own gram figure for a spoon is
 *  unreliable: 2 tsk of chili flakes arrived as 50 g and became ten 5 g packs. These
 *  defaults are the ones a kitchen uses; a family can override them in pieceWeights. */
export const SMALL_UNIT_GRAMS = { tsk: 5, spsk: 15, knivspids: 1 };

export function smallUnitGrams(unit, extra = {}) {
  const w = String(unit || "").toLowerCase().replace(/\.$/, "").trim();
  if (!w) return null;
  const mine = Number((extra || {})[w]);
  if (Number.isFinite(mine) && mine > 0) return mine;
  return Number(SMALL_UNIT_GRAMS[w]) || null;
}

/** Grams for one part of this recipe's unit word, or null when the word is not a part. */
export function subunitGrams(word, extra = {}) {
  const w = String(word || "").toLowerCase().replace(/\s+/g, "").replace(/er$/, "");
  if (!w) return null;
  const mine = Number((extra || {})[w] !== undefined ? (extra || {})[w] : (extra || {})[w + "e"]);
  if (Number.isFinite(mine) && mine > 0) return mine;
  return Number(SUBUNIT_GRAMS[w]) || Number(SUBUNIT_GRAMS[w + "er"]) || null;
}

/** The typical weight of one piece of this product, or null when it is not loose produce. */
export function pieceGrams(name) {
  const t = String(name || "").toLowerCase();
  for (const [word, grams] of Object.entries(PIECE_GRAMS)) if (t.includes(word)) return grams;
  return null;
}

/**
 * One piece of this pack, in the pack's own scale (g or ml), from what the shop declared
 * about it. "4 x 125 g" states the piece. "2 stk. / 260 g" states the pack and how many
 * are in it, so a naan is 130 g and a baguette 175 g. "15 stk." states no weight at all,
 * and then the word table in pieceGrams() is still the last resort: the planner guesses,
 * and the two cases are not the same claim.
 */
export function pieceWeightOf(product) {
  const pack = (product && product.pack) || {};
  const text = String((product && product.description) || pack.raw || "").trim();
  const D = "\\d+(?:[.,]\\d+)?";
  // The multi-pack first: in "24 x 0,33 l" the first number is the count, not a weight.
  const each = new RegExp("(" + D + ")\\s*x\\s*(" + D + ")\\s*(g|kg|ml|cl|l)(?![a-zæøå])", "i").exec(text);
  if (each) {
    const m = toBaseMeasure(num(each[2]), each[3]);
    if (m && (m.measure === "g" || m.measure === "ml") && m.value >= 1 && m.value <= 5000) return round2(m.value);
  }
  // Then the pair the shop prints as two segments: "2 stk. / 260 g", "350 g / 2 stk.".
  const weight = new RegExp("(" + D + ")\\s*(g|kg|ml|cl|l)(?![a-zæøå])", "i").exec(text);
  let total = null;
  if (weight) {
    const m = toBaseMeasure(num(weight[1]), weight[2]);
    if (m && (m.measure === "g" || m.measure === "ml")) total = m.value;
  }
  if (total === null) total = packMeasure(pack);
  const count = new RegExp("(" + D + ")\\s*(stk|styk|stykker|skiver|skive|dåser|dåse|flasker|flaske|poser|pose|pakker|pakke|håndsker|håndskuer|brikker|brik|æg|fed|ruller|rulle)(?![a-zæøå])", "i").exec(text);
  if (total && count) {
    const n = num(count[1]);
    if (n >= 1) {
      const per = round2(total / n);
      if (per >= 1 && per <= 5000) return per;
    }
  }
  return pieceGrams(product && product.name);
}

/** Grams or millilitres in one pack, or null when the pack is not a measured pack. */
function packMeasure(pack) {
  if (!pack || !(pack.qty > 0)) return null;
  if (pack.unit === "g" || pack.unit === "kg") return pack.unit === "kg" ? pack.qty * 1000 : pack.qty;
  if (pack.unit === "l" || pack.unit === "ml") return pack.unit === "l" ? pack.qty * 1000 : pack.qty;
  return null;
}

/**
 * How many packs satisfy a need. Never returns 0.
 *
 * Three cases, in this order:
 *   1. same unit - divide, so 8 eggs out of a 10-pack is 1 pack;
 *   2. the need counts pieces and the pack weighs - convert with the piece weight, so
 *      8 pærer (about 1,5 kg) is 2 bags of 1 kg and not 3;
 *   3. the units genuinely differ (a count vs an unreadable pack) - one pack per piece,
 *      which is the old safe fallback.
 */
export function packsFor(need, pack, opts = {}) {
  if (!need || !pack) return 1;
  if (pack.qty > 0 && pack.unit === need.unit) return Math.max(1, Math.ceil(need.qty / pack.qty));
  const grams = packMeasure(pack);
  if (grams && COUNT_UNITS.has(need.unit)) {
    // opts.pieceWeight is what the shop declared for this pack; opts.pieceGrams is a
    // caller that already knew a number; the word table by name is the last resort.
    const per = Number(opts.pieceWeight || opts.pieceGrams || pieceGrams(opts.name)) || 0;
    if (per > 0) return Math.max(1, Math.ceil((need.qty * per) / grams));
  }
  if (grams && MEASURE_UNITS.has(need.unit) && MEASURE_UNITS.has(pack.unit)) {
    const needGrams = need.unit === "kg" || need.unit === "l" ? need.qty * 1000 : need.qty;
    return Math.max(1, Math.ceil(needGrams / grams));
  }
  if (COUNT_UNITS.has(need.unit)) return Math.max(1, Math.ceil(need.qty));
  if (pack.qty === null || !need.unit || pack.unit !== need.unit) return 1;
  if (pack.qty <= 0) return 1;
  const packs = Math.ceil((need.qty / pack.qty) * 1000) / 1000;
  return Math.max(1, Math.ceil(packs));
}

/**
 * Cheapest-per-unit pick among candidates.
 * candidates: [{ id, name, price, unitPrice, unitLabel, availability, onSale, campaign }]
 * Only availability.IsDeliveryAvailable && IsAvailableInStock are eligible.
 * Returns { pick, considered, poolSize, rejected, mode, saleNote, campaignTip,
 * alternatives } — never throws on an empty list.
 */
export function cheapest(candidates, opts = {}) {
  const { eligible, rejected } = eligibleOf(candidates, opts);
  if (eligible.length === 0) return { pick: null, considered: 0, rejected };
  const { pool, mode } = comparablePool(eligible);
  pool.sort(byCost);
  let pick = pool[0];
  let saleNote = null;
  const swapped = saleSwap(pool, opts);
  if (swapped) {
    saleNote = swapped.note;
    pick = swapped.pick;
  }
  if (pick.onSale && !saleNote) saleNote = "on sale";
  // `shelf` is every candidate that survived the filters, whatever it is priced in. The
  // axis pool decides a price PER UNIT and a tie; what to buy is decided on the TOTAL
  // over the whole shelf, so a 4 kr head priced per piece can beat a 13,33 kr net bag
  // priced per kilo. Both views are returned because they answer different questions.
  return { pick, considered: eligible.length, poolSize: pool.length, pool: pool.slice(0, 8), shelf: eligible.slice(),
    rejected, mode, saleNote,
    campaignTip: campaignOf(pick, pool), alternatives: pool.filter((c) => c.id !== pick.id).slice(0, 3) };
}

/** The highest fat percentage a product name states, or null when it states none.
 *  "8-12%" is 12, "12-19%" is 19, "4%" is 4. The upper end is what the family eats. */
export function fatPercentOf(name) {
  const text = String(name || "");
  const range = /(\d{1,2})\s*-\s*(\d{1,2})\s*%/.exec(text);
  if (range) return Math.max(Number(range[1]), Number(range[2]));
  const one = /(\d{1,2})\s*%/.exec(text);
  return one ? Number(one[1]) : null;
}

/** True when the folded name carries the folded word. A word of three letters or
 *  fewer must start a token, so "and" finds Andebryst and not Sandwich, and "lam"
 *  finds Lammekød and not slam. Longer words may sit inside a compound. */
const SUFFIX_WORDS = new Set(["lar", "ben"]);   // lår and ben: body parts that end a compound

function hitWord(text, word) {
  if (!word) return false;
  if (word.includes(" ") || word.length > 3) return text.includes(word);
  return text.split(" ").some((t) => t === word || t.startsWith(word) || (SUFFIX_WORDS.has(word) && t.endsWith(word)));
}

/** The same test on raw text, for the exclusion editor and its tests. */
export function nameHasWord(name, word) {
  return hitWord(foldWords(String(name || "")), foldWords(String(word || "")));
}

/** Drop unavailable products and avoided brands; boost the preferred sku to the front.
 *  Exported: a trim decision runs the same filter over the rivals of the sku it is
 *  looking at, so a saving is never taken on a product the shop cannot deliver. */
export function eligibleOf(candidates, opts) {
  const prefer = String(opts.preferSku || "");
  const avoid = (opts.avoidBrands || []).map((b) => String(b).toLowerCase());
  // avoidWords rejects a product by its NAME, not its brand: "19-23%" mince, "ben" in
  // a chicken cut for a small child. maxUnitPrice is Namlig's own price per unit
  // (kr/kg, kr/l), so a fat-priced cut can be refused while the pack price is cheap.
  const avoidWords = (opts.avoidWords || []).map((w) => foldWords(String(w))).filter(Boolean);
  const maxUnit = Number(opts.maxUnitPrice) > 0 ? Number(opts.maxUnitPrice) : null;
  const maxFat = Number(opts.maxFatPct) > 0 ? Number(opts.maxFatPct) : null;
  const eligible = [];
  const rejected = [];
  for (const c of candidates || []) {
    const av = c.availability || {};
    if (av.IsDeliveryAvailable === false || av.IsAvailableInStock === false) {
      rejected.push({ id: c.id, name: c.name, why: "not available" });
      continue;
    }
    if (!c.id) { rejected.push({ id: c.id, name: c.name, why: "no id" }); continue; }
    const brand = String(c.brand || "").toLowerCase();
    if (avoid.some((b) => brand.includes(b))) { rejected.push({ id: c.id, name: c.name, why: "brand " + c.brand }); continue; }
    const name = foldWords(String(c.name || ""));
    const hit = avoidWords.find((w) => hitWord(name, w));
    if (hit) { rejected.push({ id: c.id, name: c.name, why: 'name says "' + hit + '"' }); continue; }
    if (maxUnit !== null && Number(c.unitPrice) > maxUnit) {
      rejected.push({ id: c.id, name: c.name, why: `${Number(c.unitPrice).toFixed(1)} ${c.unitLabel || "per unit"} is above the ${maxUnit} limit` });
      continue;
    }
    if (maxFat !== null) {
      const fat = fatPercentOf(c.name);
      if (fat !== null && fat > maxFat) {
        rejected.push({ id: c.id, name: c.name, why: `${fat}% fat is above the ${maxFat}% limit` });
        continue;
      }
    }
    if (prefer && String(c.id) === prefer) eligible.unshift({ ...c, _preferBoost: true });
    else eligible.push(c);
  }
  return { eligible, rejected };
}

/** Lower case and Danish letters folded, so an avoid word matches the product name. */
function foldWords(s) {
  return s.toLowerCase().replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a").replace(/[^a-z0-9% ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Compare inside one price axis: the label most candidates share (kr/kg, kr/l,
 * kr/stk). Never compare kr/kg with kr/stk: a 12 kr slice-pack would win against a
 * 17,50 kr/kg block for the wrong reason.
 */
function comparablePool(eligible) {
  const withUnit = eligible.filter((c) => Number.isFinite(Number(c.unitPrice)) && Number(c.unitPrice) > 0 && c.unitLabel);
  if (withUnit.length === 0) return { pool: eligible, mode: "pack-price" };
  const labels = new Map();
  for (const c of withUnit) {
    const arr = labels.get(String(c.unitLabel)) || [];
    arr.push(c);
    labels.set(String(c.unitLabel), arr);
  }
  let best = null;
  for (const [label, arr] of labels) {
    const cand = { label, arr, count: arr.length, med: median(arr.map((c) => Number(c.unitPrice))) };
    if (!best || cand.count > best.count || (cand.count === best.count && cand.med < best.med)) best = cand;
  }
  return { pool: best.arr, mode: "unit:" + best.label };
}

function byCost(a, b) {
  if (a._preferBoost !== b._preferBoost) return a._preferBoost ? -1 : 1;
  const au = costPerUnit(a);
  const bu = costPerUnit(b);
  if (au !== bu) return au - bu;
  return Number(a.price) - Number(b.price);
}

function costPerUnit(c) {
  return Number(c.unitPrice) > 0 ? Number(c.unitPrice) : Number(c.price);
}

/**
 * Namlig marks discounts with DiscountItem or a Discount/Prisfald label. If a
 * discounted rival costs at most saleTolerancePct more per unit than the cheapest,
 * take the discounted one: a sale is this family's stated preference.
 */
function saleSwap(pool, opts) {
  if (opts.preferSale === false || pool.length < 2 || pool[0].onSale) return null;
  const pct = Number(opts.saleTolerancePct);
  const tolerance = 1 + (Number.isFinite(pct) && pct >= 0 ? Math.min(pct, 50) : 10) / 100;
  const cheapestCost = costPerUnit(pool[0]);
  const rival = pool.find((c) => c.onSale && costPerUnit(c) <= cheapestCost * tolerance);
  if (!rival || cheapestCost <= 0) return null;
  const delta = Math.round((costPerUnit(rival) / cheapestCost - 1) * 100);
  return { pick: rival, note: `preferred because on sale: ${costPerUnit(rival).toFixed(2)} vs ${cheapestCost.toFixed(2)} ${pool[0].unitLabel || ""} (+${delta} %)` };
}

/**
 * A bulk campaign ("Fast mixtilbud": 5 for 39 kr) only pays at a minimum quantity.
 * The tip is emitted only when both sides are measured on the same axis
 * (kr/kg vs kr/kg), because comparing kr/pack with kr/kg is how a slice-pack wins
 * against a block for the wrong reason.
 */
function campaignOf(picked, pool) {
  const label = String(picked.unitLabel || "");
  const list = [picked, ...pool].filter((c) => c.campaign && c.campaign.min > 1 && String(c.unitLabel || "") === label);
  if (list.length === 0 || !label) return null;
  const scored = list.map((c) => ({ c, per: perUnitPrice(c) })).filter((x) => x.per !== null);
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.per - b.per);
  const best = scored[0];
  const now = Number(picked.unitPrice) > 0 ? Number(picked.unitPrice) : Number(picked.price);
  if (!(now > 0) || best.per >= now) return null;
  return { sku: best.c.id, name: best.c.name, min: best.c.campaign.min, totalPrice: best.c.campaign.totalPrice,
    unitLabel: label, perUnit: Number(best.per.toFixed(2)), beatsBy: Number((now - best.per).toFixed(2)) };
}

/** Campaign price per unit of the published axis (kr/kg, kr/l, kr/stk). null if unclear. */
function perUnitPrice(c) {
  const perPack = c.campaign.totalPrice / c.campaign.min;
  const label = String(c.unitLabel || "");
  const qty = c.pack && Number.isFinite(Number(c.pack.qty)) ? Number(c.pack.qty) : null;
  const unit = c.pack ? c.pack.unit : null;
  if (/kg/.test(label)) return qty && unit === "g" ? perPack / (qty / 1000) : null;
  if (/^kr\/l|kr\/l$/.test(label) || /\bl\b/.test(label)) return qty && unit === "ml" ? perPack / (qty / 1000) : null;
  if (/stk/.test(label)) return qty && unit === "stk" ? perPack / qty : perPack;
  return null;
}

/** Base-measure name used in the returned pack object. */
function unitName(m) {
  if (m.measure === "g") return "g";
  if (m.measure === "ml") return "ml";
  return m.measure;
}

function median(a) {
  if (a.length === 0) return Infinity;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Grams, millilitres or pieces one pack of this product holds, in the need's scale. */
function packScale(pack, kind, per) {
  if (!pack || !(pack.qty > 0)) return null;
  const size = packMeasure(pack);
  if (size !== null) {
    const b = baseUnit(pack.unit);
    const isG = b === "g" || b === "kg";
    return (isG ? "g" : "ml") === kind ? { size } : null;
  }
  const bu = baseUnit(pack.unit);
  if (!(COUNT_UNITS.has(bu) || bu === "stk")) return null;
  if (kind === "count") return { size: pack.qty, pieces: pack.qty };
  if (kind === "g" && per > 0) return { size: pack.qty * per, pieces: pack.qty };
  return null;
}

/** The need in one comparable scale: grams, millilitres or plain pieces. */
function needScale(need, per) {
  if (!need || !(need.qty > 0)) return null;
  const nb = toBaseMeasure(need.qty, need.unit);
  if (!nb) return null;
  if (nb.measure === "g" || nb.measure === "ml") return { kind: nb.measure, amount: nb.value, countQty: null };
  return per > 0
    ? { kind: "g", amount: nb.value * per, countQty: nb.value }
    : { kind: "count", amount: nb.value, countQty: nb.value };
}

/**
 * Whether extra of this product is a saving rather than waste.
 *
 * A short word can sit inside a longer one: "salt" is inside "saltet", so salted
 * butter would read as something that keeps. `freshWords` are therefore checked
 * first and always win; only after that does `stableWords` get a say. Anything the
 * lists do not mention is treated as fresh, which is the cautious reading.
 */
function isStable(name, opts) {
  const t = String(name || "").toLowerCase();
  for (const w of (opts && opts.freshWords) || []) if (w && t.includes(String(w).toLowerCase())) return false;
  for (const w of (opts && opts.stableWords) || []) if (w && t.includes(String(w).toLowerCase())) return true;
  return false;
}

/**
 * Buy the way a person does: cover the need for the lowest TOTAL price.
 *
 * A bigger pack is never taken because its price per unit is better - that only
 * saves money on paper. It is taken when the whole purchase costs less: 12 eggs
 * out of a 10-pack is 2 packs and 83,90 kr, one 15-pack is 54,95 kr, so the
 * 15-pack wins even though it is not the cheaper per egg... and it is, here.
 *
 * Slack is bounded: a fresh product may not overrun the need by more than
 * overshootPctFresh, one that keeps by overshootPctStable. When two options cost
 * within tieBreakKr of each other the one that wastes least is taken.
 *
 * @returns {{candidate, packs, total, supply, wastePct, why}|null} null when the
 *          need cannot be compared with any pack, so the caller falls back.
 */
/**
 * Every way one product can cover the need: the covering number of packs, and one
 * pack more, so a bigger quantity that happens to cost less is always in the list.
 *
 * A pack that cannot be compared with the need (counted in pieces while the need
 * weighs, or the other way) keeps the old rule: as many packs as the pieces say,
 * priced as the whole packs they are. "1 stk smor" then costs one normal pack and
 * never a 100 x 8 g catering tub.
 */
function packOptions(need, n, list, per, opts) {
  const options = [];
  for (const c of list) {
    // A candidate is measured in its own numbers, on both sides of the comparison: "3
    // pærer" against "4 stk. / 500 g" is 375 g wanted of 500 g sold, not 570 g of 500 g.
    // What it does not declare is not borrowed from the product the need was written for:
    // 65 g per egg would turn a "2 stk" pizza base into a 130 g pack and make it look
    // like five of them are worth buying.
    const own = Number(pieceWeightOf(c) || opts.pieceGrams) || 0;
    const scale = needScale(need, own) || n;
    const one = packScale(c.pack, scale.kind, own);
    if (!one || !(one.size > 0)) {
      const packs = Math.max(1, packsFor(need, c.pack, { pieceWeight: pieceWeightOf(c), name: c.name }));
      options.push({ candidate: c, scale, packs, total: round2(Number(c.price) * packs), supply: null,
        pieces: null, over: null, wastePct: null, smaller: null });
      continue;
    }
    const kMin = Math.max(1, Math.ceil(scale.amount / one.size - 1e-9));
    // The covering number is always in the list; one more only while it stays sane.
    for (const k of [kMin, kMin + 1]) {
      if (k !== kMin && k > 6) continue;
      options.push({ candidate: c, scale, packs: k, total: round2(Number(c.price) * k), supply: one.size * k,
        pieces: one.pieces === undefined ? null : one.pieces * k, over: one.size * k - scale.amount,
        wastePct: ((one.size * k - scale.amount) / scale.amount) * 100,
        smaller: k > kMin ? { packs: kMin, total: round2(Number(c.price) * kMin) } : null });
    }
  }
  return options;
}

/** A number from the profile, or the default when it is missing or out of range. */
function numOr(value, dflt) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Buy the way a person does: cover the need for the lowest TOTAL price.
 *
 * A bigger pack is never taken because its price per unit is better - that only
 * saves money on paper. It is taken when the whole purchase costs less: 12 eggs
 * need two 10-packs at 83,90 kr or one 15-pack at 54,95 kr, so the 15-pack wins.
 * For 4 eggs the 10-pack wins, even when the 15-pack is the cheaper per egg.
 *
 * Slack is bounded. Fresh may overrun by overshootPctFresh (25 %) or by
 * maxOverrunFreshMl (150 g or ml) - 40 g of curry powder is nothing, 400 g of
 * salmon is. Food in stableWords may overrun by overshootPctStable (400 %),
 * because the price rule already stops it from costing anything extra. A tie of
 * under tieBreakKr goes to the offer on sale, then to the one that wastes least.
 *
 * @returns {{candidate, packs, total, supply, wastePct, why}|null} null when the
 *          need cannot be compared with any pack, so the caller falls back.
 */
export function choosePack(need, candidates, opts = {}) {
  const all = (candidates || []).filter((c) => c && Number(c.price) > 0);
  const nameOf = opts.name || (all[0] && all[0].name) || "";
  const per = Number(opts.pieceWeight || opts.pieceGrams || pieceGrams(nameOf)) || 0;
  // A pack floor names the SIZE this family buys of a loose good: onions by the net bag, not
  // three single pieces at 5 kr. It bites only when such a pack is on this shelf, so it never
  // turns a buy into a miss, and a pack whose size cannot be read is not counted as meeting
  // it. It is a rule's field, so a floor set for onions does not raise the cream.
  const floor = Number(opts.minPackGrams) > 0 ? Number(opts.minPackGrams) : 0;
  const gramsOf = (c) => {
    const p = c.pack || {};
    const base = toBaseMeasure(Number(p.qty) || 0, p.unit);
    if (base && (base.measure === "g" || base.measure === "ml")) return base.value;
    return per && Number(p.qty) ? per * Number(p.qty) : null;
  };
  const big = floor > 0 ? all.filter((c) => (gramsOf(c) || 0) >= floor) : [];
  const list = (big.length > 0 ? big : all).slice(0, 8);
  const floorNote = big.length > 0 && big.length < all.length
    ? `${all.length - big.length} smaller pack(s) on this shelf were left out: ${floor} g or more is what this family buys`
    : null;
  const n = needScale(need, per);
  if (!n || list.length === 0) return null;
  const maxPacks = Math.max(1, Number(opts.maxPacksPerLine) || 6);
  const options = packOptions(need, n, list, per, opts).filter((o) => o.packs <= maxPacks);
  if (options.length === 0) return null;
  const stable = isStable(nameOf, opts);
  const limit = stable ? numOr(opts.overshootPctStable, 400) : numOr(opts.overshootPctFresh, 25);
  const maxOver = stable ? Infinity : numOr(opts.maxOverrunFreshMl, 150);
  const fits = (o) => o.wastePct === null || o.wastePct <= limit
    || ((o.scale || n).kind !== "count" && o.over !== null && o.over <= maxOver);
  const allowed = options.filter(fits);
  const pool = allowed.length > 0 ? allowed : options.filter((o) => !o.smaller);
  if (pool.length === 0) return null;
  const slack = (o) => (o.wastePct === null ? 0 : o.wastePct);
  // When nothing fits inside the limits, the smallest overrun goes first, then price.
  pool.sort(allowed.length > 0
    ? (a, b) => a.total - b.total || slack(a) - slack(b)
    : (a, b) => slack(a) - slack(b) || a.total - b.total);
  const tie = numOr(opts.tieBreakKr, 3);
  const near = pool.filter((o) => o.total <= pool[0].total + tie);
  const better = (a, b) => {
    if (!!a.candidate.onSale !== !!b.candidate.onSale) return a.candidate.onSale ? a : b;
    return slack(a) < slack(b) - 0.001 ? a : b;
  };
  const chosen = near.reduce((m, o) => better(o, m), near[0]);
  const pack = chosen.candidate.pack || {};
  const packLabel = pack.qty ? `${pack.qty} ${pack.unit || "stk"}` : "1 pack";
  const given = chosen.supply === null
    ? `${chosen.packs} pack${chosen.packs > 1 ? "s" : ""} as sold`
    : chosen.pieces !== null && (chosen.scale || n).countQty !== null
      ? `${Math.round(chosen.pieces)} stk`
      : `${Math.round(chosen.supply)} ${n.kind}`;
  const bits = [`${chosen.packs} x ${packLabel} = ${given} for ${need.qty} ${need.unit}`];
  if (chosen.smaller) bits.push(`more of the same pack costs less in total: ${chosen.total} kr for ${chosen.packs} against ${chosen.smaller.total} kr for ${chosen.smaller.packs}`);
  if (floorNote) bits.push(floorNote);
  return { candidate: chosen.candidate, packs: chosen.packs, total: chosen.total, supply: chosen.supply,
    wastePct: chosen.wastePct === null ? null : Number(chosen.wastePct.toFixed(1)), why: bits.join(" - ") };
}
