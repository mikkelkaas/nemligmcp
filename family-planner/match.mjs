// match.mjs — name matching between a shopping intent and a Namlig product name.
//
// Rules, in order:
//   1. normalise: lower-case, strip punctuation, drop Danish filler words.
//   2. the head noun must match BOTH ways: the first meaningful token of the query
//      must appear in the product name, and the first token of the name must appear
//      in the query. "agurk" matches "Agurk" but not "Agurkesalat" (a prepared salad
//      is not a cucumber), and "jordbær" does not match "Yoghurt m. jordbær".
//   3. the remaining query tokens must cover at least `minScore` of the query.
//      A token also counts when it only differs by an inflection (karrypasta vs
//      karrypastaen), which is why we accept a shared prefix of 60% length.
//
// Pure functions, no network. Used by catalog.mjs and pin-skus.mjs, and tested by
// test/match.test.mjs against the real product names in data/staples.json.

const STOP = new Set(["m", "med", "og", "af", "til", "i", "på", "pa", "en", "et", "den", "det", "stk", "g", "kg", "l", "ml", "stk."]);

// Packaging and marketing words that describe the SAME product in a different size
// or grade. Dropped from both sides so the score measures product identity:
// "Solsikkerugbrød øko skiver" and "Solsikkerugbrød øko." are one product, and a
// recipe ingredient called "Gulerødder" may legally be answered by the non-organic
// bag because the plan wants the cheapest one.
const QUALIFIER = new Set(["øko", "oko", "økologisk", "okologisk", "økologiske", "skiver", "skive", "naturel", "natural",
  "dansker", "danmark", "dk", "klasse", "1", "2", "3", "stk", "ex", "pant", "uden", "indh", "indholdt", "tilsat",
  "light", "let", "stor", "store", "mellem", "sm", "ml", "g", "kg", "l"]);

/** Lower-case, punctuation-free form used for cache keys and comparisons. */
export function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Lower-case word list of a product name or query, filler words removed. */
export function tokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !STOP.has(w) && !QUALIFIER.has(w));
}

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
  return token.replace(/ø/g, "o").replace(/æ/g, "a").replace(/å/g, "a");
}

function tokenAccepts(rawName, rawQuery) {
  if (rawName === rawQuery) return true;
  const nameToken = fold(rawName);
  const queryToken = fold(rawQuery);
  if (nameToken === queryToken) return true;
  const shorter = queryToken.length <= nameToken.length ? queryToken : nameToken;
  const longer = queryToken.length <= nameToken.length ? nameToken : queryToken;
  if (shorter.length >= 4 && longer.startsWith(shorter) && shorter.length / longer.length >= 0.7) return true;
  // Danish puts the product at the END of a compound: "Fløde" is sold as
  // "Madlavningsfløde 4%" and "Piskefløde 38%", "Kylling" as "Kyllingebrystfilet".
  // Only the suffix direction is safe: "Agurk" must still miss "Agurkesalat", where the
  // query is the prefix.
  // Four letters after folding, not five: "maelk" becomes "malk" when a-e collapses, and
  // that is what has to find "minimaelk" and "soedmaelk".
  if (shorter.length >= 4 && longer.endsWith(shorter)) return true;
  // Long product names differ by one letter across producers: "Tortellini m. skinke"
  // is sold as "Tortelloni m. skinke". A single letter change inside a long word
  // that shares a 6-letter stem is still the same dish.
  return oneLetterApart(nameToken, queryToken);
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

/** 0 = clearly different product, 1 = every query token found.
 *  `qualifierWords` are this family's own front-of-name words that keep the product
 *  itself, so one call site can judge the shelf by the family's reading of it. */
export function score(query, name, qualifierWords = []) {
  const q = tokens(query);
  const n = tokens(name);
  if (q.length === 0 || n.length === 0) return 0;
  const inN = (tok) => n.some((t) => tokenAccepts(t, tok));
  const inQ = (tok) => q.some((t) => tokenAccepts(t, tok));
  // Head noun both ways. One direction alone is not enough: "Jordbær" would accept
  // "Yoghurt m. jordbær", and "Ost" would accept "Pølse m. ost".
  // Exception: a name that merely starts with a preparation word ("Frisk panang
  // karrypasta (sød)") keeps its identity in the second token, so the reverse check
  // is skipped for those words.
  const reverseNeeded = !descriptiveOf(qualifierWords).has(n[0]);
  if (!inN(q[0])) return 0;
  if (reverseNeeded && !inQ(n[0])) return 0;
  // A name that adds a processing word the query never asked for is a different
  // product: a query for "Dild" must not answer "Dild dip mix", and "Karry" must not
  // answer "Karry sauce". Words already in the query never count as extras.
  if (hasPreparedExtra(n, q)) return 0;
  const hit = q.filter(inN).length;
  return Number((hit / q.length).toFixed(3));
}

/** The share of the query's words the shop must show back before we call it the same
 *  product. A family changes it in its profile under `matching.minNameScore`; the
 *  catalog keeps what it is given between 0,5 and 0,95, so a typo cannot make the
 *  planner accept just anything. */
export const MIN_NAME_SCORE = 0.7;

/** Convenience predicate used by the resolver. */
export function nameMatches(query, name, minScore = MIN_NAME_SCORE, qualifierWords = []) {
  return score(query, name, qualifierWords) >= minScore;
}
