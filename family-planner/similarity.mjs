// similarity.mjs — decides when two recipes are really the same dinner.
//
// A rule from one family's order history, and a sensible one: two dishes clash when the FORMAT and the
// PROTEIN are the same, so "Spaghetti bolognese" and "Spaghetti med kødboller" may not
// share a week, while "Chili con carne" and "Tortillas" may, even though both are
// Mexican. Same food, different dinner.
//
// The format comes from the dish name first, then from its ingredients. The protein is
// scored across name (3), tags (2) and ingredients (1), because a recipe that lists
// "Rejer" in one line is still "Nudler med kylling og broccoli".
export const FOLD = (s) => String(s || "")
  .toLowerCase()
  .replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Formats, most specific first. The first group whose words appear in the name wins. */
const FORMATS = [
  ["pastasalat", ["pastasalat", "pasta salad"]],
  ["spaghetti", ["spaghetti", "tagliatelle", "tagliarini", "linguine", "vermicelli"]],
  ["pasta", ["penne", "farfalle", "fusilli", "orzo", "risoni", "skruer", "macaroni", "lasagne", "tortelloni", "tortellini", "pasta", "nudelpasta"]],
  ["nudler", ["nudler", "nudelret", "bami", "mienudler", "glasnudler", "wok", "stir fry", "pad thai", "ramen", "chow mein"]],
  ["pizza", ["pizza", "fladepizza", "pizzabund"]],
  ["wrap", ["wrap", "wraps", "tortilla", "tortillas", "tacos", "burrito", "quesadilla", "pita", "flatbread"]],
  ["suppe", ["suppe", "bouillon", "mælkesuppe", "kødsuppe"]],
  ["salat", ["salat", "sidesalat", "bowle", "coleslaw"]],
  ["kartoffel", ["kartoffel", "kartofler", "brune kart", "ovnkartofler", "kartoffelmos", "pomfrit", "brændte"]],
  ["ris", ["risotto", "basmati", "jasminris", "ris ", "grød"]],
  ["kal", ["kål", "kålruller", "rødkål", "hovedrol", "majo og kål"]],
  ["aeg", ["æggekage", "æggemuffin", "omelet", "shakshuka", "æg "]],
  ["pandekage", ["pandekage", "pandekager", "vaffel", "lefse"]],
  ["fad", ["fad", "gratiner", "overbæren", "pyramide", "cannelloni", "stroganoff", "lasagne"]],
  ["gryde", ["gryde", "gryderet", "bolognese", "karry", "curry", "panang", "masala", "chili con carne", "chili", "stuvning", "kofte", "kødboller", "boller i", "frikadeller", "frikadelle", "bøffer", "burger", "ret"]],
  ["ovn", ["ovn", "bagt", "stegt", "sprød", "filet", "deller", "spyd", "grill", "marineret"]],
];

/**
 * Protein families, spelled the way the pool and the protein caps spell them:
 * fisk, kylling, oksekod, svinepolse, ostaeq, vegetar.
 */
const PROTEINS = [
  ["fisk", ["laks", "torsk", "morrej", "hvidfisk", "hvid fisk", "sej", "rødspætte", "makrel", "sild", "ørred", "fiskefars", "fiskefilet", "fiskedeller", "fisk", "rejer", "hummer", "muslinger", "blæksprutte", "tun", "fish"]],
  ["kylling", ["kylling", "kyllinge", "kalkun", "fjerkræ", "kip", "andefilet", "forår"]],
  // A sauce named after its meat counts as that meat: "bolognese" is ground beef.
  ["oksekod", ["okse", "hakket", "kød", "kødboller", "kødbolle", "kødsovs", "kødsauce", "bolognese", "gullash", "gulasj", "boef", "kalv", "kofte", "kebab", "burger", "stroganoff", "entrecote", "mørbrad", "forloverit", "mørkebiff"]],
  ["svinepolse", ["svin", "flæsk", "ribben", "medister", "pølse", "skinke", "bacon", "nakke", "pendel", "spege", "medaljon", "marineret", "carbonara", "pølseret"]],
  ["aegost", ["æg", "ost", "mozzarella", "ricotta", "feta", "cheddar", "parmesan", "yoghurt"]],
  ["vegetar", ["kikerter", "linser", "bønner", "kidneyer", "tofu", "svampe", "champignon", "portabelo", "kål", "blomkål", "hakkede mandler"]],
];

function wordsOf(recipe, part) {
  if (part === "name") return FOLD(recipe.name || "");
  if (part === "tags") return FOLD([].concat(recipe.tags || []).join(" "));
  return FOLD((recipe.ingredients || []).map((i) => `${i.text} ${i.amount || ""} ${i.unit || ""}`).join(" "));
}

/**
 * Which protein the dish is really about. A word in the name counts 3, in the tags 2,
 * in the ingredients 1, so a single "Rejer" line cannot outrank "med kylling" in the name.
 */
/**
 * Whole-word hit. Danish builds words: "grillpølser" is a pølse, "oksekød" is okse.
 * A word of 4+ letters may be the stem a token starts with, a word of 5+ may also be
 * what a token ends with. Short words must match exactly, or "and" finds "Vand".
 */
function hits(tokens, word) {
  return tokens.some((t) => t === word
    || (word.length >= 4 && t.startsWith(word))
    || (word.length >= 5 && t.endsWith(word)));
}

export function mainProtein(recipe) {
  const name = FOLD(wordsOf(recipe, "name")).split(" ").filter(Boolean);
  const tags = FOLD(wordsOf(recipe, "tags")).split(" ").filter(Boolean);
  const rawIng = FOLD(wordsOf(recipe, "ing"));
  // Fish sauce, soy and oyster sauce are seasonings, not the protein of the dish.
  const ing = rawIng.replace(/fisk(e)?sauce/g, "krydderi").replace(/østersovs/g, "krydderi").replace(/soja|soya/g, "krydderi").split(" ").filter(Boolean);
  const scored = [];
  for (const [protein, words] of PROTEINS) {
    let weight = 0;
    for (const w of words) {
      const word = FOLD(w);
      if (!word) continue;
      if (hits(name, word)) weight += 3;
      if (hits(tags, word)) weight += 2;
      if (hits(ing, word)) weight += 1;
    }
    scored.push({ protein, weight });
  }
  const meat = ["fisk", "kylling", "oksekod", "svinepolse"];
  const byMeat = scored.filter((s) => meat.includes(s.protein)).sort((a, b) => b.weight - a.weight)[0];
  const cheese = scored.find((s) => s.protein === "aegost") || { protein: "aegost", weight: 0 };
  const veg = scored.find((s) => s.protein === "vegetar") || { protein: "vegetar", weight: 0 };
  // Real meat or fish wins. Eggs and cheese win when no meat is named, and vegetables
  // only when neither is: "Stegt kål med blå ost og grillpølser" is a pork dish.
  const best = byMeat && byMeat.weight >= 3 ? byMeat : (cheese.weight >= 3 ? cheese : (veg.weight > 0 ? veg : byMeat));
  if (!best || best.weight === 0) return "vegetar";
  return best.protein === "aegost" ? "ostaeq" : best.protein;
}

/**
 * The format of the dish: what it is served as. Name first, so "Pastasalat med kylling"
 * is a salad, not a pasta bake.
 */
export function dishFormat(recipe) {
  const name = FOLD(recipe.name || "");
  const ing = FOLD((recipe.ingredients || []).map((i) => i.text).join(" "));
  // The lists are written in Danish; the text is folded, so fold the words too.
  const inName = (...ws) => ws.some((w) => name.includes(FOLD(w)));
  const inIng = (...ws) => ws.some((w) => ing.includes(FOLD(w)));
  for (const [format, words] of FORMATS) {
    if (inName(...words)) return format;
  }
  for (const [format, words] of FORMATS) {
    if (format === "gryde" || format === "ovn") continue;
    if (inIng(...words)) return format;
  }
  return "andet";
}

/** True when two dishes are the same dinner in a different wrapper. */
export function conflicts(a, b, { proteinOf = mainProtein, formatOf = dishFormat } = {}) {
  if (!a || !b) return false;
  if ((a.url || a.name) === (b.url || b.name)) return true;
  const pa = a.protein || proteinOf(a);
  const pb = b.protein || proteinOf(b);
  const fa = a.format || formatOf(a);
  const fb = b.format || formatOf(b);
  if (fa === "andet" || fb === "andet") return false;
  return fa === fb && pa === pb;
}

/** Every clashing pair in a list, best dish first in each pair. */
export function conflictPairs(list, opts = {}) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (conflicts(list[i], list[j], opts)) {
        const [keep, drop] = (list[i].score || 0) >= (list[j].score || 0) ? [list[i], list[j]] : [list[j], list[i]];
        out.push({ keep: keep.name, drop: drop.name, format: keep.format || dishFormat(keep), protein: keep.protein || mainProtein(keep) });
      }
    }
  }
  return out;
}

/** The first dish in `chosen` that `candidate` clashes with, or null. */
export function clashWith(chosen, candidate, opts = {}) {
  for (const c of chosen) if (conflicts(c, candidate, opts)) return c;
  return null;
}
