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
import { join } from "node:path";

const fold = (s) => String(s || "").toLowerCase().replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a").replace(/[^a-z0-9% ]/g, " ").replace(/\s+/g, " ").trim();

const daysSince = (iso, now = Date.now()) => {
  if (!iso) return 9999;
  const t = Date.parse(String(iso).slice(0, 10) + "T12:00:00Z");
  if (!Number.isFinite(t)) return 9999;
  return Math.max(0, Math.floor((now - t) / 86400000));
};

/** Does the text contain the word, with word boundaries so "ost" misses "mos"? */
function hasWord(text, word) {
  const t = fold(text), w = fold(word);
  if (!w) return false;
  if (w.includes(" ")) return t.includes(w);
  return new RegExp(`(^| )${w}e?(s|n|r|t)?( |$|%)`, "i").test(t) || t.startsWith(w + " ") || t.endsWith(" " + w);
}
const hitsWord = (text, list) => (list || []).find((w) => hasWord(text, w)) || null;

// Words in front of the product, or a quantity stuck to it, that Namlig search does
// not need. They made "Håndfuld bønnespirer" and "Ægnudler, ca. 200 g" unfindable.
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
  let t = String(text || "");
  t = t.split(/\bfx\b| - |;|,| eller | gerne /)[0];
  t = t.replace(/\d+([.,]\d+)?\s*(g|kg|ml|dl|l|stk|pk|skiver|både|bidder|dl|år)\b/gi, " ");
  t = t.replace(/\d+\s*$/, " ");
  // Cut before the noise words go, not after: dropping "evt" alone would leave
  // "glutenfri" behind, and "Sojasauce glutenfri" is a product this family did not ask for.
  const words = asideCut(t, asides)
    .filter((w) => w.length > 1 && !NOISE.includes(w))
    .filter((w) => !/^\d/.test(w));
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
    if ((r.match || []).some((m) => t.includes(fold(m)))) return r;
  }
  return null;
}

/** Amount text for Namlig: grams, litres or pieces, rounded to something buyable. */
function needTextOf(ing, factor) {
  const grams = Number(ing.grams) || 0;
  const litres = Number(ing.litres) || 0;
  if (grams > 0) {
    const g = grams * factor;
    const rounded = g >= 1000 ? Math.ceil(g / 250) * 250 : Math.max(50, Math.ceil(g / 50) * 50);
    return { need: `${rounded} g`, unit: "g", grams: rounded };
  }
  if (litres > 0) {
    const l = litres * factor;
    const rounded = l >= 1 ? Math.ceil(l * 4) / 4 : Math.ceil(l * 10) / 10;
    return { need: `${rounded} l`, unit: "l", litres: rounded };
  }
  const pieces = Number(ing.amount) || 1;
  const rounded = Math.max(1, Math.ceil(pieces * factor));
  return { need: `${rounded} stk`, unit: "stk", pieces: rounded };
}

/** Pick the dinners for this period: least recently cooked, capped per protein. */
export function chooseDinners(pool, opts) {
  const { days, coversDays = 2, lastUsed, wanted = [], maxPerProtein = 2, minFish = 1 } = opts;
  const per = Math.max(1, Number(coversDays) || 2);
  // How many nights a dinner runs for is a property of the dish: how well it keeps.
  // `singleNight` is the old name list and still works, as a fresh-only override.
  const legacy = (opts.singleNight || []).map((x) => String(x).toLowerCase());
  const nightOpts = {
    preferLeftovers: opts.preferLeftovers !== false,
    maxNights: opts.maxNights || per,
    overrides: opts.nightsOverride || {},
    table: opts.reheatByFormat || undefined,
  };
  const coversOf = (d) => (legacy.includes(String(d.format || "").toLowerCase()) ? 1 : nightsOf(d, nightOpts));
  const coveredOf = (list) => list.reduce((n, d) => n + coversOf(d), 0);
  const byUrl = new Map(pool.map((p) => [p.url, p]));
  // --dinners matches a pool name or url. An id that matches nothing used to vanish in
  // silence, and the menu came from the rotation anyway - so a person believed the dish
  // they asked for was in the plan. The names the plan prints under "menu" work here.
  const asked = wanted.map((w) => ({ wanted: String(w), hit: pool.find((p) => p.url === w || fold(p.name) === fold(w)) }));
  const forced = asked.map((a) => a.hit).filter(Boolean);
  const unknownWanted = asked.filter((a) => !a.hit).map((a) => a.wanted);
  // A refused dish never comes back by itself; --dinners still overrides, because a
  // human who asks for it today is not the family that refused it last month.
  const taste = opts.taste || {};
  const refused = new Set(taste.refused || []);
  const liked = new Set(taste.liked || []);
  const rest = pool.filter((p) => !forced.includes(p) && !refused.has(p.url));
  // A dish eaten cooldownTimes or more inside cooldownDays is resting: it stays in the
  // pool, but it goes to the back of the queue so the table gets variety on its own.
  const ex = opts.exploration || {};
  const coolDays = Number(ex.cooldownDays) || 42;
  const coolTimes = Number(ex.cooldownTimes) || 3;
  const isResting = (d) => {
    const c = (opts.cookedTimes || {})[d.url];
    if (!c || !c.dates || c.dates.length === 0) return false;
    const cutoff = new Date(Date.now() - coolDays * 86400000).toISOString().slice(0, 10);
    return c.dates.filter((iso) => iso >= cutoff).length >= coolTimes;
  };
  // Least recently cooked first; never cooked counts as the oldest of all (9999 days).
  const rank = (d) => daysSince(lastUsed[d.url]) + (liked.has(d.url) ? 30 : 0);
  rest.sort((a, b) => rank(b) - rank(a) || (b.score || 0) - (a.score || 0));
  // Every other dinner is a dish the family has never cooked, so the rotation moves and
  // the table still keeps its favourites.
  const fresh = rest.filter((p) => daysSince(lastUsed[p.url]) >= 3650);
  const known = rest.filter((p) => daysSince(lastUsed[p.url]) < 3650);
  const interleaved = [];
  for (let i = 0; i < Math.max(fresh.length, known.length); i++) {
    if (i % 2 === 0) interleaved.push(...[fresh[i]].filter(Boolean), ...[known[i]].filter(Boolean));
    else interleaved.push(...[known[i]].filter(Boolean), ...[fresh[i]].filter(Boolean));
  }
  rest.length = 0;
  rest.push(...interleaved.filter(Boolean));
  const chosen = [];
  const used = {};
  for (const f of forced) {
    if (coveredOf(chosen) >= days) break;
    chosen.push(f);
    used[f.protein] = (used[f.protein] || 0) + 1;
  }
  // Resting dishes are only used when the period cannot be covered without them.
  const picked = [];
  for (const allowResting of [false, true]) {
    for (const p of rest) {
      if (coveredOf(chosen) >= days) break;
      if (chosen.includes(p) || picked.includes(p)) continue;
      if (!allowResting && isResting(p)) continue;
      if ((used[p.protein] || 0) >= maxPerProtein) continue;
      if (clashWith(chosen, p)) continue;
      used[p.protein] = (used[p.protein] || 0) + 1;
      chosen.push(p);
      picked.push(p);
    }
  }
  // The family eats fish about once a week: swap the last pick if the period has none.
  if (coveredOf(chosen) >= minFish && !chosen.some((c) => c.protein === "fisk") && coveredOf(chosen) >= days) {
    const fish = rest.find((p) => p.protein === "fisk" && !chosen.includes(p) && !isResting(p))
      || rest.find((p) => p.protein === "fisk" && !chosen.includes(p));
    const replaceable = [...chosen].reverse().find((c) => (used[c.protein] || 0) > 1);
    if (fish && replaceable) {
      used[replaceable.protein]--;
      chosen[chosen.indexOf(replaceable)] = fish;
      used.fisk = (used.fisk || 0) + 1;
    }
  }
  let start = 1;
  const d0 = (c) => (byUrl.get(c.url) ? { ...byUrl.get(c.url), format: c.format || (byUrl.get(c.url) || {}).format } : c);
  const menu = chosen.map((c) => {
    const covers = coversOf(c);
    const entry = { id: c.url, url: c.url, name: c.name, minutes: c.minutes, protein: c.protein, format: c.format || null,
      covers, nights: covers, reheat: reheatOf(d0(c), opts.reheatByFormat || undefined),
      days: start + "-" + Math.min(days, start + covers - 1),
      lastCooked: lastUsed[c.url] || "not in the stored history",
      resting: isResting(c), liked: liked.has(c.url) };
    start += covers;
    return entry;
  });
  return { chosen: chosen.map((c) => byUrl.get(c.url)), menu, daysPerDinner: per, coveredDays: coveredOf(chosen),
    uncoveredDays: Math.max(0, days - coveredOf(chosen)), unknownWanted };
}

/** One recipe to shopping intents, with what was left out and why. */
export function recipeIntents(recipe, { amounts, meat, exclusions, sourcePrefix = "dinner", portions = null, standardPortions = null, note = "" }) {
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
    const size = needTextOf(ing, factor);
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
    const need = row.grams ? `${row.grams} g` : row.litres ? `${row.litres} l` : `${row.pieces} stk`;
    const rule = meatRuleFor(row.text, meat.rules);
    // The shop writes "Parmesan", the family buys its own hard cheese: rewrite before searching.
    const aliased = Object.entries(aliases).find(([w]) => hasWord(row.query, w));
    const query = rule ? rule.query : (aliased ? aliased[1] : row.query);
    if (aliased && !rule) row.query = query;
    const why = `${row.recipeAmount || "as listed"} for ${recipe.servings || 4} in the recipe -> ${need} for ${needPortions || basePortions || "?"} portions${note ? ` (${note})` : ""}`;
    intents.push({
      source: `${sourcePrefix}:${recipe.slug || recipe.url}`,
      sourceLabel: recipe.name,
      query,
      alt: rule ? rule.alt || [] : [altQuery(row.text, asides)].filter((q) => q && q !== row.query),
      avoidWords: rule ? rule.avoid || [] : [],
      maxUnitPrice: rule && rule.maxKrPerKg ? rule.maxKrPerKg : undefined,
      need,
      mode: "cheapest",
      rationale: rule ? `${why}; meat rule "${rule.id}": ${rule.fatBands?.length ? "fat " + rule.fatBands.join("/") + ", " : ""}ceiling ${rule.maxKrPerKg || "-"} kr per kg` : why,
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

/** Last cooked day per dish, also counting printed plans so a dry run moves the queue. */
export function readRotation({ plansDir, linesFile, rotationFile, cookedFile }) {
  const out = {};
  const seen = (url, iso) => { if (url && iso && (!out[url] || iso > out[url])) out[url] = iso; };
  const hist = readCookHistory({ linesFile, rotationFile, cookedFile });
  for (const [url, e] of Object.entries(hist)) seen(url, e.last);
  try {
    for (const f of readdirSync(plansDir)) {
      if (!/^plan-\d{4}-\d{2}-\d{2}/.test(f)) continue;
      const day = statSync(join(plansDir, f)).mtime.toISOString().slice(0, 10);
      let plan = null;
      try { plan = JSON.parse(readFileSync(join(plansDir, f), "utf8")); } catch { continue; }
      for (const m of plan.dinnerMenu || []) seen(m.url || m.id, day);
    }
  } catch { /* no plans yet */ }
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
