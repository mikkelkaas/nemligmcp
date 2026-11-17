// match.mjs — name matching between a shopping intent and a Namlig product name.
//
// Rules, in order:
//   1. normalise: lower-case, strip punctuation, drop Danish filler words.
//   2. the head noun must match BOTH ways: the first meaningful token of the query
//      must appear in the product name, and the first token of the name must appear
//      in the query. "agurk" matches "Agurk" but not "Agurkesalat" (a prepared salad
//      is not a cucumber), and "jordbær" does not match "Yoghurt m. jordbær".
//      The shop's own words about the product - its brand and the shelf category it
//      sits in (`shelfContext`) - stand in for both directions, because they are the
//      shop's claim, not the shopper's guess: a brand-first name under the category
//      "Vodka" is vodka, and a hard cheese under "Specialost, hård" answers "hård ost".
//   3. the remaining query tokens must cover at least `minScore` of the query, and
//      words no producer prints ("færdig", "almindelig") are not asked for at all.
//      A token also counts when it only differs by an inflection (karrypasta vs
//      karrypastaen), which is why we accept a shared prefix of 60% length.
//
// Pure functions, no network. Used by catalog.mjs and pin-skus.mjs, and tested by
// test/match.test.mjs against the real product names in data/staples.json.

const STOP = new Set(["m", "med", "og", "af", "til", "i", "på", "pa", "en", "et", "den", "det", "stk", "g", "kg", "l", "ml", "stk."]);

// Packaging and marketing words that describe the SAME product in a different size
// or grade. Dropped from both sides so the score measures product identity:
// "grovbrød øko skiver" and "grovbrød øko." are one product, and a
// recipe ingredient called "Gulerødder" may legally be answered by the non-organic
// bag because the plan wants the cheapest one.
const QUALIFIER = new Set(["øko", "oko", "økologisk", "okologisk", "økologiske", "baby", "skiver", "skive", "naturel", "natural",
  "dansker", "danmark", "dk", "klasse", "1", "2", "3", "stk", "ex", "pant", "uden", "indh", "indholdt", "tilsat",
  "light", "let", "stor", "store", "mellem", "sm", "ml", "g", "kg", "l"]);

/** Lower-case, punctuation-free form used for cache keys and comparisons. */
export function norm(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Lower-case word list of a product name or query, filler words removed. */
export function tokens(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w) && !QUALIFIER.has(w));
}

// Words a shopper writes and the shelf never repeats: "Færdig pizzadej" is sold as
// "Pizzadej", "Almindelig ris" as "Ris". Dropped from the query, because requiring them
// loses a real match for a word no producer prints. "hakket", "revet" and "røget" are
// deliberately NOT here: the shelf does repeat those words, and a steak is not mince.
const UNWRITTEN = new Set(["færdig", "faerdig", "færdigkøbt", "klar", "almindelig",
  "almindeligt", "normal", "normalt", "sædvanlig", "meget", "lidt", "den", "det", "en"]);

// Preparation and grade words that sit in front of the real product name. They do
// not carry the product identity, so they do not have to appear in the query.
const DESCRIPTIVE = new Set(["frisk", "frossen", "frosne", "røget", "ryget", "marineret", "paneret", "hakket",
  "revet", "skåret", "skaaret", "hel", "store", "stor", "mellemstor", "grove", "grov", "fin", "finvalsede",
  "let", "light", "økologiske", "dansk", "danske", "import", "økologisk"]);

/** DESCRIPTIVE plus the words THIS family adds in its profile (`purchasing.qualifierWords`).
 *  "Parboiled ris" and "Basmati ris" are rice to a family that buys both, so for them those
 *  words sit in front of the product without changing it. The list is data, not code, and it
 *  never reaches the reverse check the other way: a query for "Basmati ris" still refuses a
 *  plain "Ris", because the query's own head noun must appear in the name. */
function descriptiveOf(extra) {
  const words = Array.isArray(extra) ? extra.map((w) => String(w).toLowerCase()) : [];
  if (words.length === 0) return DESCRIPTIVE;
  return new Set([...DESCRIPTIVE, ...words]);
}

// Words that turn a raw ingredient into another product: a mix, a sauce, a drink.
const PREPARED = new Set(["dip", "mix", "blanding", "suppe", "suppen", "bouillon", "fond", "pulver", "granulat",
  "koncentrat", "koncentreret", "saft", "juice", "the", "salat", "pålæg", "paalaeg", "leverpostej", "paté", "pate",
  "mos", "moset", "sirup", "sauce", "saucen", "marinade", "dressing", "sol", "creme", "flødepudder", "pudder"]);

/** True when the name carries a processing word the query did not ask for. */
function hasPreparedExtra(nameTokens, queryTokens) {
  const asked = new Set(queryTokens);
  return nameTokens.some((t) => PREPARED.has(t) && !asked.has(t));
}

/** Danish inflection swaps the vowels: gulerod -> gulerødder. Fold before comparing. */
function fold(token) {
  return token.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ø/g, "o").replace(/æ/g, "a").replace(/å/g, "a");
}

// A compound whose tail names a different product, not a cut of the same one.
// "Agurk" must miss "Agurkesalat"; "Fisk" must still find "Fiskefars".
const PREPARED_COMPOUND = ["salat", "suppe", "sauce", "sovs", "dip", "mix", "postej", "paalaeg", "pålæg",
  "mos", "creme", "dressing", "saft", "juice", "chips", "snack", "pulver", "koncentrat", "krydderi",
  "olie", "eddike", "pure", "puré", "ketchup", "sylte", "syltetøj", "most", "kage", "pasta", "nudler", "pølse",
  "flødeost", "flødeskum", "flødeis"];

function tokenAccepts(rawName, rawQuery) {
  if (rawName === rawQuery) return true;
  const nameToken = fold(rawName);
  const queryToken = fold(rawQuery);
  if (nameToken === queryToken) return true;
  const shorter = queryToken.length <= nameToken.length ? queryToken : nameToken;
  const longer = queryToken.length <= nameToken.length ? nameToken : queryToken;
  // A Danish plural is the same product: "tomat" finds "cherrytomater".
  if (shorter.length >= 4 && (longer.endsWith(shorter + "er") || longer.endsWith(shorter + "e") || longer.endsWith(shorter + "r"))) return true;
  // Danish puts the product first in a compound: "Kylling" is sold as
  // "Kyllingebrystfilet", "Spaghetti" as "Spaghettoni". The tail decides whether it is
  // still the same product; a prepared tail is a different one.
  if (shorter.length >= 4 && longer.startsWith(shorter)) {
    const rest = longer.slice(shorter.length);
    const dairy = ["flode", "floede", "creme", "malk", "maelk"].includes(shorter);
    if (dairy && ["ost", "skum", "is"].some((w) => rest.endsWith(w))) return false;
    if (rest.length >= 2 && !PREPARED_COMPOUND.some((w) => rest.includes(fold(w)))) return true;
  }
  // Product at the END: "Fløde" is "Madlavningsfløde"; "Mælk" is "Letmælk".
  if (shorter.length >= 4 && longer.endsWith(shorter)) return true;
  // Long product names differ by one or two letters across producers: "Tortellini"
  // is sold as "Tortelloni", "Spaghetti" as "Spaghettoni".
  return oneLetterApart(nameToken, queryToken) || twoEditsApart(nameToken, queryToken);
}

/** True when two long words share a six-letter stem and are at most two edits apart. */
function twoEditsApart(a, b) {
  if (a.length < 8 || b.length < 8 || Math.abs(a.length - b.length) > 2) return false;
  if (a.slice(0, 6) !== b.slice(0, 6)) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    if (Math.min(...row) > 2) return false;
    prev = row;
  }
  return prev[b.length] <= 2;
}

/** True when both words are 8+ letters, share a 6-letter stem and differ once. */
function oneLetterApart(a, b) {
  if (a.length < 8 || b.length < 8 || Math.abs(a.length - b.length) > 1) return false;
  if (a.slice(0, 6) !== b.slice(0, 6)) return false;
  let diff = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    diff++;
    if (diff > 1) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else if (a.length > b.length) {
      i++;
    } else {
      j++;
    }
  }
  diff += a.length - i + b.length - j;
  return diff <= 1;
}

/** What the shop states beside the product name: its own brand and the two shelf
 *  categories it sits in. "Polskey Vodka" under the category "Vodka" says the first
 *  word is a brand and not the product - the one thing the reverse head check cannot
 *  read out of a name. Returns "" for a caller that has no shelf context. */
export function shelfContext(product) {
  if (!product) return "";
  return [product.brand, product.mainGroup, product.subGroup].filter(Boolean).join(" ");
}

/** 0 = clearly different product, 1 = every query word found.
 *  `qualifierWords` are this family's own front-of-name words that keep the product
 *  itself, so one call site can judge the shelf by the family's reading of it.
 *  `where` is `shelfContext(product)`: the product's own brand and shelf category. */
export function score(query, name, qualifierWords = [], where = "") {
  const q = tokens(query).filter((t) => !UNWRITTEN.has(t));
  const n = tokens(name);
  if (q.length === 0 || n.length === 0) return 0;
  const ctx = tokens(where);
  const inN = (tok) => n.some((t) => tokenAccepts(t, tok));
  const inQ = (tok) => q.some((t) => tokenAccepts(t, tok));
  const inCtx = (tok) => ctx.some((t) => tokenAccepts(t, tok));
  // The shelf itself calls this product that word: the category "Specialost, hård
  // (parmesan, pecorino, osv.)" answers a query for "hård ost", and the category
  // "Vodka" answers it for "Polskey Vodka" whatever the brand in front is.
  const shelfSays = inCtx(q[0]);
  // Head noun both ways. One direction alone is not enough: "Jordbær" would accept
  // "Yoghurt m. jordbær", and "Ost" would accept "Pølse m. ost".
  // Exception: a name that merely starts with a preparation word ("Frisk panang
  // karrypasta (sød)") keeps its identity in the second token, so the reverse check
  // is skipped for those words.
  const reverseNeeded = !descriptiveOf(qualifierWords).has(n[0]);
  if (!inN(q[0]) && !shelfSays) return 0;
  if (reverseNeeded && !shelfSays && !inQ(n[0])) return 0;
  // A name that adds a processing word the query never asked for is a different
  // product: a query for "Dild" must not answer "Dild dip mix", and "Karry" must not
  // answer "Karry sauce". Words already in the query never count as extras.
  if (hasPreparedExtra(n, q)) return 0;
  const hit = q.filter((t) => inN(t) || inCtx(t)).length;
  return Number((hit / q.length).toFixed(3));
}

/** The share of the query's words the shop must show back before we call it the same
 *  product. A family changes it in its profile under `matching.minNameScore`; the
 *  catalog keeps what it is given between 0,5 and 0,95, so a typo cannot make the
 *  planner accept just anything. */
export const MIN_NAME_SCORE = 0.7;

/** Convenience predicate used by the resolver. `where` is `shelfContext(product)`. */
export function nameMatches(query, name, minScore = MIN_NAME_SCORE, qualifierWords = [], where = "") {
  return score(query, name, qualifierWords, where) >= minScore;
}
