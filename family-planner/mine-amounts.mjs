#!/usr/bin/env node
// mine-amounts.mjs — how much this family really buys, from the family's own orders.
//
// Two questions:
//   1. How much of a staple goes into one basket? Answered with the median over the
//      orders that contain the product family, plus the gap between orders, so the
//      number can be read as a rate per week.
//   2. How much protein and sides per dinner? Answered with the recipe amounts in
//      profiles/recipe-pool.json, scaled from Namlig's 4 persons to the 5 servings
//      this family cooks: 2 adults and 1 child, one pot, eaten two evenings.
//
// Output: profiles/amounts.json, with the evidence next to every number.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parsePack } from "./units.mjs";

import { HOME as BASE } from "./paths.mjs";
const LINES = BASE + "/data/order-lines-raw.jsonl";
const POOL = BASE + "/profiles/recipe-pool.json";
const OUT = BASE + "/profiles/amounts.json";

const HOUSEHOLD = { adults: 2, children: 1, people: 3, dinnersPerRecipe: 2, cookServings: 5 };

// Product families, folded so the Danish letters do not matter. First match wins.
const FAMILIES_RAW = [
  // "mælk" anywhere covers Minimælk, Go' mælk, Økoholdbar og chokolade- og jordbærmælk.
  ["mælk", /mælk/],
  ["æg", /æg(?!.*nudler|.*mayonnaise|.*pasta)/],
  ["skyr og yoghurt", /skyr|yoghurt|mysa|biola|go'?a/],
  ["fløde", /fløde|flødeskum|piskefløde|letfløje/],
  ["ost", /emmentaler|mozzarella|grana padano|ricotta|ost (i|på)|i blok|revet ost|flødeost|cheddar|havarti|sancerre|burrata/],
  ["brød", /rugbrød|boller|grove bolle|tebirkes|croissant|baguette|loff|bagel|bageri|hvedebolle/],
  ["pasta, ris og mel", /spaghetti|pasta|penne|fusilli|macaroni|tortellini|lasagneplader|ris|nudler|couscous|mel$|gryn|pizza dej|pizzadej|dej o|pølsehornsdej|tortilla|wraps/],
  ["kartofler", /kartoffel/],
  ["grønt", /kartoffel|gulerod|agurk|tomat|cherrytomat|peberfrugt|broccoli|blomkål|squash|courgette|løg|porre|champignon|svamp|spinat|salat|majs|ærter|chili|hvidløg|ingefær|radise|rosenkål|spidskål|kål|aebler?$/],
  ["frugt og bær", /banan|aebler|aeble|pære|jordbær|blaabær|hindbaer|hindbær|mandarin|appelsin|druer|melon|nektarin|fersken|avokado|avocado|dadler|blommer|kirsebær|ananas|vindruer/],
  ["pålæg", /spegepoelse|spegepølse|salami|skinke|roastbeef|fiskefilet|makrel|leverpostej|pølse|bacon|ostesnitter|pålægschokolade/],
  ["kød og fisk", /hakket|filet|kyllinge|kalkun|okseboef|oksekød|svine|flaesk|nakke|fiskefars|fisk|rejer|medister|pølser/],
  ["barn: grød og mos", /groed|grød|mos$|bleskat|bleer|frugtst|grød m/],
  ["opskrift til barnet", /fra 9 mdr|madpakke/],
  ["husholdning", /toiletpapir|koekkenrulle|køkkenrulle|vaadservietter|vådservietter|opvaskemiddel|affaldsposer|viskestykke|alufolie|baakefoelje|sugerør/],
  ["drikke", /vand|sodavand|juice|saftevand|sodavand|øl|coca|fanta|tea|cider|most/],
  ["frost", /frossen|pandepizza|is$|grøntsager frost|frosne/],
];
// Patterns must be folded with the same map as the product name, or æ/ø/å never match.
const FAMILIES = FAMILIES_RAW.map(([name, re]) => [name, new RegExp(String(re).slice(1, String(re).lastIndexOf("/")).replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a").replace(/[ÆØÅ]/g, (c) => c === "Æ" ? "AE" : "O"), "i")]);

const fold = (s) => String(s || "").toLowerCase().replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a").replace(/\s+/g, " ").trim();
const READ_JSONL = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const quant = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.floor(q * s.length))]); };
const median = (xs) => quant(xs, 0.5);

/** Grams or litres behind one order line, using the pack size in the description. */
function baseAmount(line) {
  const pack = parsePack(line.Description || "");
  const qty = Number(line.Quantity) || 0;
  if (pack.qty === null || qty <= 0) return null;
  const factor = { g: 1, kg: 1000, ml: 0.001, l: 1, stk: 1 }[pack.unit];
  if (!factor) return { unit: pack.unit, amount: qty, packs: qty };
  if (pack.unit === "g" || pack.unit === "kg") return { unit: "g", amount: pack.qty * (pack.unit === "kg" ? 1000 : 1) * qty, packs: qty };
  if (pack.unit === "ml" || pack.unit === "l") return { unit: "l", amount: pack.qty * (pack.unit === "ml" ? 0.001 : 1) * qty, packs: qty };
  return { unit: pack.unit, amount: qty * (pack.qty || 1), packs: qty };
}

/** Per family: how many orders contain it, and how much in grams or litres. */
function familyTotals(orders) {
  const gapDays = orderGapDays(orders);
  const out = {};
  for (const [name, re] of FAMILIES) {
    const rows = [];
    for (const o of orders) {
      let grams = 0, litres = 0, pieces = 0, packs = 0, hit = false;
      for (const l of o.lines || []) {
        if (!l.IsProductLine || l.IsRecipeLine) continue;
        if (!re.test(fold(l.ProductName))) continue;
        hit = true;
        const a = baseAmount(l);
        packs += Number(l.Quantity) || 0;
        if (!a) continue;
        if (a.unit === "g") grams += a.amount;
        else if (a.unit === "l") litres += a.amount;
        else pieces += a.amount;
      }
      if (hit) rows.push({ grams: Math.round(grams), litres: Number(litres.toFixed(2)), pieces, packs, iso: o.iso });
    }
    if (rows.length < 5) continue;
    const perWeek = (v) => (gapDays ? Number(((v * 7) / gapDays).toFixed(1)) : null);
    out[name] = {
      ordersContaining: rows.length,
      medianPacks: median(rows.map((r) => r.packs)),
      medianGrams: median(rows.map((r) => r.grams)) || null,
      p75Grams: quant(rows.map((r) => r.grams), 0.75) || null,
      medianLitres: median(rows.map((r) => r.litres)) || null,
      medianPieces: median(rows.map((r) => r.pieces)) || null,
      perWeekGrams: perWeek(median(rows.map((r) => r.grams)) || 0),
      perWeekLitres: perWeek(median(rows.map((r) => r.litres)) || 0),
      note: `median over the ${rows.length} of ${orders.length} orders that contained the family, with ${gapDays ?? "-"} days between orders`,
    };
  }
  return out;
}

/** Median number of days between two orders, so per-order amounts can be read per week. */
function orderGapDays(orders) {
  const days = orders.map((o) => Date.parse(o.iso)).filter(Number.isFinite).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < days.length; i++) gaps.push((days[i] - days[i - 1]) / 86400000);
  const med = median(gaps);
  return med === null ? null : Math.round(med);
}

/** Protein and side grams per dinner, from the recipes we cook, scaled to 5 servings. */
function perDinner(POOL_FILE) {
  const pool = JSON.parse(readFileSync(POOL_FILE, "utf8"));
  const foldRe = (re) => new RegExp(String(re).slice(1, String(re).lastIndexOf("/")).replace(/[æ]/g, "ae").replace(/[ø]/g, "o").replace(/[å]/g, "a"), "i");
  const groups = { protein: foldRe(/hakket|filet|kød|kylling|fisk|rejer|pølse|skinke|bacon|fars|bøf|okse|svin|kalkun/), side: foldRe(/spaghetti|pasta|ris|nudler|kartoffel|tortellini|quinoa|couscous|dej|tortilla|wraps|mel/), grønt: foldRe(/gulerod|broccoli|blomkål|agurk|tomat|peberfrugt|squash|courgette|porre|champignon|spinat|salat|ærter|majs|kål/) };
  const acc = {};
  for (const r of pool.pool) {
    const byKind = {};
    for (const ing of r.ingredients || []) {
      const grams = Number(ing.grams) || 0;
      if (grams <= 0) continue;
      const kind = Object.entries(groups).find(([, re]) => re.test(fold(ing.text)))?.[0];
      if (!kind) continue;
      byKind[kind] = (byKind[kind] || 0) + grams;
    }
    // One total per recipe and kind, so a dish with three vegetables is one data point.
    for (const [kind, grams] of Object.entries(byKind)) {
      (acc[kind] = acc[kind] || []).push(grams / (r.servings || 4));
    }
  }
  const out = {};
  for (const [kind, rows] of Object.entries(acc)) {
    const med = median(rows);
    if (med === null) continue;
    out[kind] = {
      gramsPerServingNamlig: Math.round(med),
      gramsForHouseholdDinner: Math.round(med * HOUSEHOLD.people),
      gramsWhenCookingOnceForTwoDinners: Math.round(med * HOUSEHOLD.cookServings),
      fromRecipes: rows.length,
      note: "median of the recipe amounts in profiles/recipe-pool.json, per person; 5 servings = 2 adults + 1 child eating the same pot twice",
    };
  }
  return out;
}

function main() {
  const orders = READ_JSONL(LINES).sort((a, b) => String(a.iso).localeCompare(String(b.iso)));
  const data = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    ordersRead: orders.length,
    household: { ...HOUSEHOLD, note: "one recipe is cooked once and eaten twice; quantities are scaled to 5 servings so nothing is cooked two evenings in a row" },
    staples: familyTotals(orders),
    perDinner: perDinner(POOL),
    rounding: { rule: "round up to the smallest pack Namlig sells that covers the need", maxExtraPacks: 1, note: "a larger pack is bought when it is cheaper per kg and the item keeps (see pantry.json)" },
  };
  writeFileSync(OUT, JSON.stringify(data, null, 1));
  console.log(`Wrote ${OUT} from ${orders.length} orders.`);
  console.log("family".padEnd(20), "orders", "median packs", "median g/l", "per week");
  for (const [k, v] of Object.entries(data.staples)) {
    const amount = v.medianGrams ? `${v.medianGrams} g` : v.medianLitres ? `${v.medianLitres} l` : v.medianPieces ? `${v.medianPieces} stk` : "-";
    const perWeek = v.perWeekGrams ? `${v.perWeekGrams} g/w` : v.perWeekLitres ? `${v.perWeekLitres} l/w` : "-";
    console.log(k.padEnd(20), String(v.ordersContaining).padStart(6), String(v.medianPacks).padStart(13), String(amount).padStart(12), perWeek.padStart(10));
  }
  console.log("\nper dinner (Namlig median per person):");
  for (const [k, v] of Object.entries(data.perDinner)) console.log(`  ${k.padEnd(8)} ${v.gramsPerServingNamlig} g/person -> ${v.gramsForHouseholdDinner} g for 3, ${v.gramsWhenCookingOnceForTwoDinners} g cooked for 2 dinners (${v.fromRecipes} recipes)`);
}

main();
