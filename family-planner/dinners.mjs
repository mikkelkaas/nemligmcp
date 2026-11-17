// dinners.mjs — turn the recipe rotation into shopping intents with a printed reason.
//
// The rotation lives in profiles/recipe-pool.json (pick-recipe-pool.mjs builds it). The
// household cooks one recipe once and eats it twice, so the shopping amount is the
// recipe amount scaled from Namlig's servings to the household's servings, two
// evenings, nothing cooked twice (profiles/amounts.json).
//
// Three filters run before a product is put on the list (profiles/exclusions.json):
//   pantry words   salt, pepper, oil, sugar - already at home, never bought
//   fresh herbs    the family does not use the herb garnish of a recipe
//   never bought   products absent from the family's own order history, not their food
// Protein goes through profiles/meat.json: the fat band, the cheap cut per kg and the
// price-per-kg ceiling this family uses.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { subunitGrams, smallUnitGrams, amountNumber, liquidMl, normalizeAmountText, baseUnit, PACK_COUNT_UNITS } from "./units.mjs";
import { copenhagenNow } from "./slots.mjs";
import { join } from "node:path";

const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a").replace(/[^a-z0-9% ]/g, " ").replace(/\s+/g, " ").trim();

/** The family's calendar day, as the cooked log writes it. */
const copenhagenDay = (ms) => copenhagenNow(new Date(ms)).slice(0, 10);

/**
 * Whole calendar days since a cooked date, at noon on both sides and in the family's own zone,
 * which is the zone the cooked log writes its dates in. Counted from a wall instant on one side
 * and noon on the other, "cooked 40 d ago" came out as 39 until noon - the plan said a dish was
 * waiting for them a day before it was.
 */
export const daysSince = (iso, now = Date.now()) => {
  if (!iso) return 9999;
  const then = Date.parse(String(iso).slice(0, 10) + "T12:00:00Z");
  const today = Date.parse(copenhagenDay(now) + "T12:00:00Z");
  if (!Number.isFinite(then) || !Number.isFinite(today)) return 9999;
  return Math.max(0, Math.round((today - then) / 86400000));
};

/** Does the text contain the word, with word boundaries so "ost" misses "mos"? */
function hasWord(text, word) {
  const t = fold(text), w = fold(word);
  if (!w) return false;
  if (w.includes(" ")) return t.includes(w);
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^| )${esc}e?(s|n|r|t)?( |$|%)`, "i").test(t) || t.startsWith(w + " ") || t.endsWith(" " + w);
}
const hitsWord = (text, list) => (list || []).find((w) => hasWord(text, w)) || null;

/** The line in the report that says which rule chose this product, and what it insisted on. */
function ruleLabel(rule) {
  if (rule.family) {
    const bits = [`family rule "${rule.id}"`];
    if (rule.query) bits.push(`buy "${rule.query}"`);
    if (rule.avoid?.length) bits.push(`never ${rule.avoid.join(", ")}`);
    if (rule.minPackGrams) bits.push(`${rule.minPackGrams} g or more a pack`);
    if (rule.maxKrPerKg) bits.push(`ceiling ${rule.maxKrPerKg} kr per kg`);
    return bits.join(", ");
  }
  const fat = rule.maxFatPct ? `fat at most ${rule.maxFatPct}%, ` : rule.fatBands?.length ? "fat " + rule.fatBands.join("/") + ", " : "";
  return `meat rule "${rule.id}": ${fat}ceiling ${rule.maxKrPerKg || "-"} kr per kg`;
}

// Words in front of the product, or a quantity stuck to it, that Namlig search does
// not need. They made "Håndfuld bønnespirer" and "Ægnudler, ca. 200 g" unfindable.
// A category in front of a shape is not the product: "Pasta penne" is Penne. The list
// stays short on purpose; a word that is itself a product ("ris", "fisk") is not here.
const GENERIC_HEAD = new Set(["pasta"]);
const NOISE = ["håndfuld", "hndsfuld", "knivspids", "lidt", "ca", "evt", "gerne", "fx", "til", "ell", "eller", "optøede", "friske", "frisk", "frosne", "frossen",
  "finthakkede", "finthakket", "grofthakkede", "hakket", "revet", "rivet", "snittede", "skiver", "stykker", "stk", "pk", "både", "bidder", "små", "halv", "halve", "kvart", "lille", "store", "stor",
  "saften", "heraf", "deraf", "gerne", "pr", "person", "portioner", "af", "med", "og", "til", "en", "et", "den", "det", "the", "røget", "røgede", "glutenfri", "økologisk", "øko"];

/** Words that open a second choice inside one ingredient line: "Spinat alternativt
 *  grønkål" asks for spinach and only names a fallback. From such a word the line is
 *  cut, so the query stays the product we buy. A family adds its own wording in its
 *  profile under `exclusions.queryAsides` - these are connectives, not food words. */
const ASIDES = ["alternativt", "alternativ", "eventuelt", "evt", "tilføj", "tilføjes", "link", "erstattes"];
const WORD = /[^\p{L}\p{N}%]+/u;
const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Words before the first aside, lowercased. "Sojasauce evt glutenfri" -> [sojasauce]. */
function asideCut(text, asides = []) {
  const tk = String(text || "").toLowerCase().split(WORD).filter(Boolean);
  const all = ASIDES.concat((asides || []).map((w) => String(w).toLowerCase()));
  // An aside that opens the line is dropped, but never the last word: a line of one word
  // is a product name, however it starts.
  let start = 0;
  while (start < tk.length - 1 && all.includes(tk[start])) start++;
  const at = tk.findIndex((w, i) => i > start && all.includes(w));
  return at > 0 ? tk.slice(start, at) : tk.slice(start);
}

/** Turn one Namlig ingredient sentence into something the search understands. */
import { clashWith } from "./similarity.mjs";
import { nightsOf, reheatOf, portionsPerNight } from "./nights.mjs";

export function cleanQuery(text, asides = []) {
  // Normalise the number first, then strip the amount. Splitting on a comma before
  // this turned "1,5 dl fløde" into "1" and lost the product.
  let t = normalizeAmountText(String(text || ""), { range: false });
  t = t.replace(/\d+(?:[.,]\d+)?\s*(?:g|kg|ml|cl|dl|l|stk|pk|pakker?|poser?|net|bakker?|karton|glas|flasker?|bægre?|bøtter?|skiver?|både|bidder|blade|spsk|tsk|knivspids|dåser?|bdt|bundt|fed|stilk|stilke|kvist|håndfuld|drys|nip|klat|skvæt|sjat|år)\b/gi, " ");
  t = t.split(/\bfx\b| - |;|,| eller | gerne /)[0];
  t = t.replace(/\d+\s*$/, " ");
  // Cut before the noise words go, not after: dropping "evt" alone would leave
  // "glutenfri" behind, and "Sojasauce glutenfri" is a product this family did not ask for.
  const words = asideCut(t, asides)
    .filter((w) => w.length > 1 && !NOISE.includes(w))
    .filter((w) => !/^\d/.test(w));
  if (words.length > 1 && GENERIC_HEAD.has(fold(words[0]))) words.shift();
  const kept = words.slice(0, 3);
  if (kept.length === 0) return String(text || "").trim();
  return titleCase(kept.join(" "));
}

/** The second search for a line: the same words without the aside and without the
 *  brackets a recipe puts around them. Empty when it would only repeat the first query. */
function altQuery(text, asides = []) {
  return titleCase(asideCut(text, asides).join(" ").replace(/\s+/g, " ").trim());
}

/** Namlig servings to the 5 servings this household cooks. */
function scaleFactor(recipe, household) {
  const from = Number(recipe.servings) || 4;
  const to = Number(household.cookServings) || 5;
  return to / from;
}

/** The meat, poultry or fish rule that answers this ingredient, or null. */
function meatRuleFor(text, rules) {
  const t = fold(text);
  for (const r of rules || []) {
    // A family rule's own word can mean something else on this line: "fløde" inside
    // "piskefløde" is whipping cream, not the cooking cream the rule is about. The profile
    // says where with `except`, and the rule is skipped.
    if ((r.except || []).some((w) => t.includes(fold(w)))) continue;
    if ((r.match || []).some((m) => t.includes(fold(m)))) return r;
  }
  return null;
}

/** Amount text for Namlig: grams, litres or pieces, rounded to something buyable. */
/** A recipe amount as a number. The parser handles Danish comma, fractions, vulgar
 *  fractions and ranges; a line with no readable number counts as one. */
function amountOf(value) {
  return amountNumber(value) ?? 1;
}

function needTextOf(ing, factor, pieceWeights) {
  const grams = Number(ing.grams) || 0;
  const litres = Number(ing.litres) || 0;
  const amount = amountOf(ing.amount);
  const rounded = Math.max(1, Math.ceil(amount * factor));
  // A can, a pack or a bunch is a PACK COUNT. The page may also state grams, but two
  // cans are two packs, not one 800 g pack.
  const packUnit = baseUnit(ing.unit);
  if (packUnit && PACK_COUNT_UNITS.has(packUnit) && !smallUnitGrams(ing.unit, pieceWeights)) {
    return { need: `${rounded} ${packUnit}`, unit: packUnit, pieces: rounded };
  }
  // A spoon or a pinch is a measure. The recipe page's gram figure for it is not trusted:
  // 2 tsk of chili flakes arrived as 50 g and the shelf sold ten 5 g packs. Use the
  // kitchen measure, and keep the family's own `pieceWeights` override if it has one.
  const small = smallUnitGrams(ing.unit, pieceWeights);
  if (small) {
    if (litres > 0) {
      const ml = amount * small * factor;
      const roundedMl = Math.max(5, Math.ceil(ml / 5) * 5);
      return { need: `${roundedMl} ml`, unit: "ml", litres: roundedMl / 1000 };
    }
    const g = amount * small * factor;
    const roundedG = Math.max(5, Math.ceil(g / 5) * 5);
    return { need: `${roundedG} g`, unit: "g", grams: roundedG };
  }
  const mlPer = liquidMl(ing.unit);
  if (mlPer) {
    const ml = amount * mlPer * factor;
    const roundedMl = Math.max(5, Math.ceil(ml / 5) * 5);
    return { need: `${roundedMl} ml`, unit: "ml", litres: roundedMl / 1000 };
  }
  if (grams > 0) {
    const g = grams * factor;
    const roundedG = g >= 1000 ? Math.ceil(g / 250) * 250 : Math.max(50, Math.ceil(g / 50) * 50);
    return { need: `${roundedG} g`, unit: "g", grams: roundedG };
  }
  if (litres > 0) {
    const l = litres * factor;
    const roundedL = l >= 1 ? Math.ceil(l * 4) / 4 : Math.ceil(l * 10) / 10;
    return { need: `${roundedL} l`, unit: "l", litres: roundedL };
  }
  // A unit with no weight on the page but a measured name (kg) still converts.
  if (packUnit === "g" || packUnit === "kg") {
    const g = amount * (packUnit === "kg" ? 1000 : 1) * factor;
    const roundedG = g >= 1000 ? Math.ceil(g / 250) * 250 : Math.max(50, Math.ceil(g / 50) * 50);
    return { need: `${roundedG} g`, unit: "g", grams: roundedG };
  }
  // "6 fed hvidløg" is six cloves off one head, not six packets, and the shelf sells a
  // head by the piece and a net bag by the kilo. Weighed here, at 5 g a clove, the need
  // reaches the pack rule as a measure and one 4 kr head can meet a 200 g bag. A recipe
  // word that is not a known part stays a piece: a count, never a guess.
  const per = subunitGrams(ing.unit, pieceWeights);
  if (per) {
    const g = rounded * per;
    const weighed = g >= 1000 ? Math.ceil(g / 250) * 250 : Math.max(25, Math.ceil(g / 25) * 25);
    return { need: `${weighed} g`, unit: "g", grams: weighed };
  }
  return { need: `${rounded} stk`, unit: "stk", pieces: rounded };
}

/** A dinner the family has never cooked sits this far back in the queue: oldest of all, so a
 *  dish they have eaten last month can never beat one they have never tried. */
const NEVER_COOKED = 9999;

/**
 * The queue the rotation draws from: least recently cooked first, a liked dish pushed forward,
 * and - while `alternate` holds - a never-cooked dish placed between two the family knows, so
 * the table keeps its favourites and the rotation still moves. Strict alternation: new, known,
 * new, known, then whatever is left of the longer half.
 */
function orderQueue(rest, { rank, alternate }) {
  const sorted = rest.slice().sort((a, b) => rank(b) - rank(a) || (b.score || 0) - (a.score || 0));
  if (!alternate) return sorted;
  const fresh = sorted.filter((p) => rank(p) >= 3650);
  const known = sorted.filter((p) => rank(p) < 3650);
  const out = [];
  for (let i = 0; i < Math.max(fresh.length, known.length); i++) {
    if (fresh[i]) out.push(fresh[i]);
    if (known[i]) out.push(known[i]);
  }
  return out;
}

/**
 * Fill the period. A family rule is bent one at a time, in this order, and only while evenings
 * are still empty: the cooldown first, then the per-protein cap, then the ban on two versions
 * of the same dinner. Every bend is recorded with the rule, the dish and the reason, because a
 * plan that quietly broke a rule is worse than one that says it had to.
 */
function fillPeriod({ queue, forced, days, coversOf, maxPerProtein, isResting, noVariants, coolDays, coolTimes,
  isNew = () => false, maxNew = Infinity, newMaxMinutes = Infinity }) {
  // One entry per cooking, not per dish: a dish can be cooked twice in a week when the pool is
  // too small for the period, and each cooking needs its own evenings and its own food.
  const chosen = [], relaxed = [], used = {};
  const covered = () => chosen.reduce((n, e) => n + e.nights, 0);
  const times = (p) => chosen.filter((e) => e.dish === p).length;
  const newChosen = () => chosen.filter((e) => isNew(e.dish)).length;
  const push = (p, bend) => {
    const left = days - covered();
    if (left <= 0) return false;
    chosen.push({ dish: p, nights: Math.max(1, Math.min(coversOf(p), left)), repeated: times(p) > 0 });
    used[p.protein] = (used[p.protein] || 0) + 1;
    for (const b of bend || []) relaxed.push(b);
    return true;
  };
  for (const f of forced) push(f, null);
  // Every bend a pass allows, named as it is allowed, so a dish that needed two rules to get
  // in reports both. A plan that bent a rule and said nothing is the failure mode to avoid.
  const bends = {
    cooldown: (p) => ({ rule: "cooldown", dish: p.name, because: `the ${days} evenings do not fill without a dish eaten ${coolTimes} times in ${coolDays} days` }),
    cap: (p) => ({ rule: "maxPerProtein", dish: p.name, because: `the cap is ${maxPerProtein} and the pool holds too few other proteins for ${days} evenings` }),
    variant: (p) => ({ rule: "neverTwoVariantsOfTheSameDinner", dish: p.name, because: `${days} evenings cannot be covered without a second version of ${p.protein || p.name}` }),
    reuse: (p) => ({ rule: "poolTooSmallForThePeriod", dish: p.name, because: `the pool runs out before the ${days} evenings do, so this dish is cooked twice - run node pick-recipe-pool.mjs to widen it` }),
    newCap: (p) => ({ rule: "maxNewPerPlan", dish: p.name, because: `the ${days} evenings need more than ${maxNew} new dinner(s)` }),
    slowNew: (p) => ({ rule: "newMaxMinutes", dish: p.name, because: `no new ${newMaxMinutes}-minute dinner could fill the week` }),
  };
  // A new dish is a trial, not the whole week: the cap keeps the library in charge, and
  // the minute limit keeps a trial quick. A proven dish is never held to the trial limit.
  const trialIssues = (p) => {
    if (!isNew(p)) return [];
    const issues = [];
    if (newChosen() >= maxNew) issues.push(bends.newCap(p));
    if (Number(p.minutes || 0) > newMaxMinutes) issues.push(bends.slowNew(p));
    return issues;
  };
  // The ladder, in the order a family would bend its own rules: wait out a cooldown, then eat
  // one protein more often, then accept two versions of a dinner, and only then cook one dish
  // twice. Nothing above this pass runs once the evenings are covered.
  const passes = [
    { rest: false, cap: maxPerProtein, variants: noVariants, reuse: false, trial: true, bend: () => [] },
    { rest: true, cap: maxPerProtein, variants: noVariants, reuse: false, trial: true, bend: (p) => [bends.cooldown(p)] },
    { rest: true, cap: Infinity, variants: noVariants, reuse: false, trial: true,
      bend: (p) => (isResting(p) ? [bends.cooldown(p), bends.cap(p)] : [bends.cap(p)]) },
    { rest: true, cap: Infinity, variants: false, reuse: false, trial: false,
      bend: (p) => [bends.variant(p)].concat((used[p.protein] || 0) >= maxPerProtein ? [bends.cap(p)] : [])
        .concat(isResting(p) ? [bends.cooldown(p)] : []) },
    { rest: true, cap: Infinity, variants: false, reuse: true, trial: false, bend: (p) => [bends.reuse(p)] },
  ];
  for (const pass of passes) {
    if (covered() >= days) break;
    for (const p of queue) {
      if (covered() >= days) break;
      if (times(p) > 1) continue;
      if (!pass.reuse && times(p) > 0) continue;
      if (!pass.rest && isResting(p)) continue;
      if ((used[p.protein] || 0) >= pass.cap) continue;
      if (pass.variants && clashWith(chosen.map((e) => e.dish), p)) continue;
      const trial = pass.trial ? trialIssues(p) : [];
      if (trial.length > 0) continue;
      push(p, pass.bend(p).concat(pass.trial ? [] : trialIssues(p)));
    }
  }
  return { chosen, relaxed, used };
}

/**
 * One fish dinner a week, counted in dishes and not in evenings. The rule may not empty an
 * evening or break the cap it is not allowed to bend, so it only replaces a dish whose protein
 * appears more than once, and it hands over the same number of evenings.
 */
function ensureFish({ chosen, queue, used, minFish, isResting }) {
  if (!(Number(minFish) > 0) || chosen.some((e) => e.dish.protein === "fisk")) return null;
  const taken = new Set(chosen.map((e) => e.dish.url));
  const fish = queue.find((p) => p.protein === "fisk" && !taken.has(p.url) && !isResting(p))
    || queue.find((p) => p.protein === "fisk" && !taken.has(p.url));
  if (!fish) return { in: null, out: null, because: "the pool holds no fish dish" };
  const twice = (p) => chosen.filter((e) => e.dish.protein === p.protein).length;
  const slot = chosen.slice().reverse().find((e) => twice(e.dish) > 1);
  if (!slot) return { in: null, out: null, because: "every protein in the menu is there once, so a fish dinner would leave an evening without a dinner" };
  const out = slot.dish;
  slot.dish = fish;
  used[out.protein] = Math.max(0, (used[out.protein] || 1) - 1);
  used.fisk = (used.fisk || 0) + 1;
  return { in: fish.name, out: out.name, nights: slot.nights, because: `minFishDishes ${minFish} in the profile` };
}

/**
 * Pick the dinners for this period: least recently cooked, capped per protein, every evening
 * covered. What each rule cost is in `relaxed`, and what made the queue is on every menu entry.
 */
export function chooseDinners(pool, opts) {
  // A corrupt pool file is an empty pool, not a TypeError: the plan then says it has no
  // dinner, which a person can fix, instead of a stack trace.
  pool = Array.isArray(pool) ? pool : [];
  const { days, coversDays = 2, lastUsed = {}, wanted = [], maxPerProtein = 2, minFish = 1 } = opts;
  const per = Math.max(1, Number(coversDays) || 2);
  const legacy = (opts.singleNight || []).map((x) => String(x).toLowerCase());
  const nightOpts = {
    preferLeftovers: opts.preferLeftovers !== false,
    maxNights: opts.maxNights || per,
    overrides: opts.nightsOverride || {},
    table: opts.reheatByFormat || undefined,
  };
  const coversOf = (d) => (legacy.includes(String(d.format || "").toLowerCase()) ? 1 : nightsOf(d, nightOpts));
  const byUrl = new Map(pool.map((p) => [p.url, p]));
  const asked = wanted.map((w) => ({ wanted: String(w), hit: pool.find((p) => p.url === w || fold(p.name) === fold(w)) }));
  const forced = asked.map((a) => a.hit).filter(Boolean);
  const unknownWanted = asked.filter((a) => !a.hit).map((a) => a.wanted);
  const taste = opts.taste || {};
  const refused = new Set(taste.refused || []);
  const liked = new Set(taste.liked || []);
  // A family that asked for meat on the table never gets a vegetarian dish from the
  // rotation. A dish named in `wanted` is still honoured, because that is a person asking.
  const noVeg = opts.noVegetarian === true;
  const isVeg = (p) => ["vegetar", "vegan", "vegetarisk", "ostaeq", "aeg"].includes(String(p.protein || "").toLowerCase());
  const excludedWords = (opts.excludeWords || []).map((w) => String(w).toLowerCase().trim()).filter(Boolean);
  // The recipe's own name is not the only place its main word lives: the URL and tags
  // say "kylling" when the title says "Salatpizza med kebab". Check all three.
  const dishText = (p) => `${p.name || ""} ${p.url || ""} ${(p.tags || []).join(" ")} `
    + `${(p.ingredients || []).map((i) => i.text || "").join(" ")}`.toLowerCase();
  const nameExcluded = (p) => excludedWords.some((w) => dishText(p).includes(w));
  const rest = pool.filter((p) => !forced.includes(p) && !refused.has(p.url)
    && !(noVeg && isVeg(p)) && !nameExcluded(p));
  const ex = opts.exploration || {};
  const coolDays = Number(ex.cooldownDays) || 42;
  const coolTimes = Number(ex.cooldownTimes) || 3;
  const isResting = (d) => {
    const c = (opts.cookedTimes || {})[d.url];
    if (!c || !c.dates || c.dates.length === 0) return false;
    // The cutoff is a calendar day in the family's zone, because the dates it is compared
    // against are written that way: a UTC-derived cutoff left every dish resting one day too
    // long during the first hour of the local day.
    const cutoff = copenhagenDay(Date.now() - coolDays * 86400000);
    return c.dates.filter((iso) => iso >= cutoff).length >= coolTimes;
  };
  const cookedAgo = (d) => (lastUsed[d.url] ? daysSince(lastUsed[d.url]) : NEVER_COOKED);
  // A dish the family rated good is a favourite, not a nudge: +30 was smaller than a
  // normal gap between two dinners, so a liked dish still lost to the oldest one. A year
  // puts the favourite at the front of the known half without pinning it forever.
  const rank = (d) => cookedAgo(d) + (liked.has(d.url) ? 365 : 0);
  const queue = orderQueue(rest, { rank, alternate: opts.alternateNewAndKnown !== false });
  // A dish the family chose and rated is a favourite, even before its first cook.
  // It must not consume one of the two exploration slots.
  const isNew = (d) => !lastUsed[d.url] && !liked.has(d.url);
  // No cap unless the profile asks for one: a direct caller of chooseDinners keeps the
  // old behaviour, and the plan passes the family's rotation.maxNewPerPlan.
  const maxNew = Number.isFinite(Number(opts.maxNewPerPlan)) && Number(opts.maxNewPerPlan) >= 0
    ? Number(opts.maxNewPerPlan) : Infinity;
  const newMaxMinutes = Number(opts.newMaxMinutes) > 0 ? Number(opts.newMaxMinutes) : Infinity;
  const fill = fillPeriod({ queue, forced, days, coversOf, maxPerProtein, isResting,
    noVariants: opts.neverTwoVariantsOfTheSameDinner !== false, coolDays, coolTimes,
    isNew, maxNew, newMaxMinutes });
  const fishSwap = ensureFish({ chosen: fill.chosen, queue, used: fill.used, minFish, isResting });
  let start = 1;
  const d0 = (c) => (byUrl.get(c.url) ? { ...byUrl.get(c.url), format: c.format || (byUrl.get(c.url) || {}).format } : c);
  const menu = fill.chosen.map(({ dish: c, nights: covers, repeated }) => {
    const entry = { id: c.url, url: c.url, name: c.name, minutes: c.minutes, protein: c.protein,
      format: c.format || null, covers, nights: covers, repeated: repeated,
      keepsFor: coversOf(c), clipped: covers < coversOf(c),
      reheat: reheatOf(d0(c), opts.reheatByFormat || undefined),
      days: `${start}-${start + covers - 1}`,
      cookedAgo: lastUsed[c.url] ? daysSince(lastUsed[c.url]) : "never",
      lastCooked: lastUsed[c.url] || "not in the stored history",
      resting: isResting(c), liked: liked.has(c.url) };
    start += covers;
    return entry;
  });
  const coveredDays = menu.reduce((n, m) => n + m.covers, 0);
  return { chosen: fill.chosen.map((e) => byUrl.get(e.dish.url)), menu, daysPerDinner: per, coveredDays,
    uncoveredDays: Math.max(0, days - coveredDays), unknownWanted,
    relaxed: fill.relaxed, fishSwap,
    refusedAsked: asked.filter((a) => a.hit && refused.has(a.hit.url)).map((a) => a.wanted) };
}

/** One recipe to shopping intents, with what was left out and why. */
export function recipeIntents(recipe, { amounts, meat, exclusions, purchasing = {}, sourcePrefix = "dinner", portions = null, standardPortions = null, note = "", pieceWeights = null }) {
  let factor = scaleFactor(recipe, amounts.household || {});
  // A dinner that runs one night cooks half the pot of a dinner that runs two.
  const needPortions = Number(portions) || Number(amounts.household?.cookServings) || 0;
  const basePortions = Number(standardPortions) || Number(amounts.household?.cookServings) || 0;
  if (needPortions > 0 && basePortions > 0 && needPortions !== basePortions) {
    factor = Number((factor * (needPortions / basePortions)).toFixed(4));
  }
  const intents = [], leftOut = [];
  const merged = new Map();
  const asides = (exclusions.queryAsides || {}).words || [];
  for (const ing of recipe.ingredients || []) {
    const text = String(ing.text || "").trim();
    if (!text) continue;
    const pantry = hitsWord(text, exclusions.pantryWords?.words);
    if (pantry) continue;
    const herb = hitsWord(text, exclusions.freshHerbs?.words);
    if (herb) { leftOut.push({ text, reason: "fresh herb (" + herb + ") - not used from a recipe" }); continue; }
    const never = hitsWord(text, exclusions.neverBought?.words);
    if (never) { leftOut.push({ text, reason: "we never buy " + never }); continue; }
    const size = needTextOf(ing, factor, pieceWeights);
    // A family may cook proteins by the pack, not by the recipe gram: the profile names
    // the main-protein words and the multiplier; toppings (bacon, kebab) keep the recipe.
    // Danish names are compounds ("kyllingebrystfilet"), so a word also hits at the front.
    if (size.grams && purchasing.proteinNightFactor > 1 &&
        (purchasing.proteinScaleWords || []).find((w) => hasWord(text, w) || fold(text).startsWith(fold(w)))) {
      size.grams = Math.round(size.grams * Number(purchasing.proteinNightFactor));
    }
    const key = fold(text) + "|" + size.unit;
    // Start the row empty and then add: copying `size` in and adding it again doubles
    // the first occurrence, which once turned 425 g of chicken into 850 g.
    const row = merged.get(key) || { text, count: 0, grams: 0, litres: 0, pieces: 0, unit: size.unit, recipeAmount: `${ing.amount} ${ing.unit}`.trim(), query: cleanQuery(text, asides) };
    row.grams += size.grams || 0;
    row.litres = Number((row.litres + (size.litres || 0)).toFixed(3));
    row.pieces += size.pieces || 0;
    row.count++;
    merged.set(key, row);
  }
  const aliases = (exclusions.queryAliases || {}).words || {};
  for (const row of merged.values()) {
    const need = row.grams ? `${row.grams} g`
      : row.litres ? (row.litres < 1 ? `${Math.round(row.litres * 1000)} ml` : `${row.litres} l`)
        : PACK_COUNT_UNITS.has(row.unit) ? `${row.pieces} ${row.unit}` : `${row.pieces} stk`;
    const rule = meatRuleFor(row.text, meat.rules);
    // The shop writes "Parmesan", the family buys its own hard cheese: rewrite before searching.
    // A family rule may carry no query of its own: then the recipe's word, or the family's alias
    // for it, is searched, because that rule is about the size of the pack, not its name.
    const aliased = Object.entries(aliases).find(([w]) => hasWord(row.query, w));
    const query = (rule && rule.query) || (aliased ? aliased[1] : row.query);
    if (aliased && !(rule && rule.query)) row.query = query;
    const why = `${row.recipeAmount || "as listed"} for ${recipe.servings || 4} in the recipe -> ${need} for ${needPortions || basePortions || "?"} portions${note ? ` (${note})` : ""}`;
    intents.push({
      source: `${sourcePrefix}:${recipe.slug || recipe.url}`,
      sourceLabel: recipe.name,
      query,
      alt: rule ? rule.alt || [] : [altQuery(row.text, asides)].filter((q) => q && q !== row.query),
      avoidWords: rule ? rule.avoid || [] : [],
      maxUnitPrice: rule && rule.maxKrPerKg ? rule.maxKrPerKg : undefined,
      maxFatPct: rule && rule.maxFatPct ? rule.maxFatPct : undefined,
      minPackGrams: rule && rule.minPackGrams ? rule.minPackGrams : undefined,
      need,
      mode: "cheapest",
      rationale: rule ? `${why}; ${ruleLabel(rule)}` : why,
      ingredient: row.text,
    });
  }
  return { intents, leftOut };
}

/** url to the last date the recipe was cooked: applied plans first, then order history. */
/**
 * Every date a dish was actually cooked: applied plans (rotation.json and the cooked
 * log) and recipe cards the family bought. Plans that were only printed are not there -
 * a dry run is not dinner. Map: url -> { last, dates: [ISO days, oldest first] }.
 */
export function readCookHistory({ linesFile, rotationFile, cookedFile }) {
  const out = new Map();
  const seen = (url, iso) => {
    if (!url || !iso) return;
    const day = String(iso).slice(0, 10);
    const e = out.get(url) || { last: "", dates: [] };
    if (day > e.last) e.last = day;
    if (!e.dates.includes(day)) e.dates.push(day);
    out.set(url, e);
  };
  try {
    const stored = JSON.parse(readFileSync(rotationFile, "utf8"));
    for (const [url, iso] of Object.entries(stored.used || {})) seen(url, iso);
  } catch { /* first run: no rotation file yet */ }
  try {
    for (const line of readFileSync(cookedFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      seen(row.url, row.at);
    }
  } catch { /* nothing cooked yet */ }
  try {
    for (const line of readFileSync(linesFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      for (const l of row.lines || []) if (l.IsRecipeLine && l.RecipeUrl) seen(l.RecipeUrl, row.iso);
    }
  } catch { /* history not mined yet */ }
  const plain = {};
  for (const [url, e] of out) plain[url] = { last: e.last, dates: e.dates.sort(), times: e.dates.length };
  return plain;
}

/**
 * Last cooked day per dish, from cook evidence only: applied baskets, the cooked log, and the
 * recipe cards in the order history. A plan that was only printed is NOT in here, deliberately.
 * It used to be, "so a dry run moves the queue" - and that made the menu different on every
 * run of the same command against the same home, because each run wrote a plan file the next
 * run read as a cooked meal. Fourteen plan files produced six menus. A dry run is not dinner:
 * the queue moves when the family buys the basket (`apply.mjs` writes both files below) or
 * tells the planner they ate it (`log-dinner.mjs`). Determinism and rotation both need that.
 */
export function readRotation({ linesFile, rotationFile, cookedFile }) {
  const out = {};
  for (const [url, e] of Object.entries(readCookHistory({ linesFile, rotationFile, cookedFile }))) out[url] = e.last;
  return out;
}

/** Remember what this plan cooked, so the next plan rotates away from it. */
export function writeRotation(rotationFile, urls, dayIso) {
  let stored = { schemaVersion: 1, used: {} };
  try { stored = JSON.parse(readFileSync(rotationFile, "utf8")); } catch { /* first run */ }
  stored.used = stored.used || {};
  stored.at = new Date().toISOString();
  for (const u of urls) stored.used[u] = dayIso;
  writeFileSync(rotationFile, JSON.stringify(stored, null, 1));
  return stored;
}
