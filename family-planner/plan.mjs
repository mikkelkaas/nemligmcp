#!/usr/bin/env node
// plan.mjs — build a grocery plan and resolve it to real Namlig products. DRY RUN ONLY.
//
// This script never writes to the basket. apply.mjs does the writes, and only after
// you have approved the plan. plan.mjs reads:
//   profiles/family-*.json    the ONE profile: who we shop for, budget, meat, exclusions
//                             (profiles/family.mjs reads it; --family <name> picks one)
//   profiles/pantry.json      rebuy staples with qtyPerCycle and stock cycles
//   profiles/dinners.json     the dinner cores learned from the order history
//   data/staples.json         last purchase dates (used by the stock-cycle gate)
//
// Usage (all flags optional):
//   node plan.mjs --days 8 --people 5 --breakfast yes --lunchbox yes --snacks no \
//                 --household auto --dinners pasta-bolognese,pizza-dej \
//                 --extra "Kyllingelår:1 stk" --avoid "wine,alkohol"
// Output:
//   data/plans/plan-<timestamp>.json + .md, and copies named plan-latest.{json,md}
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { connect, loadEnv, Limiter, mapPool, readConcurrency, reportFailure, unknownFlags, warnUnknownFlags } from "./lib.mjs";
import { resolveIntent, parseNeed, loadCache, saveCache } from "./catalog.mjs";
import { toBaseMeasure, choosePack } from "./units.mjs";
import { chooseDinners, recipeIntents, readRotation, readCookHistory } from "./dinners.mjs";
import { biasIntent, addIntentsOf, productWord } from "./learn.mjs";
import { loadFamily } from "./family.mjs";

import { HOME as BASE, writeJsonAtomic } from "./paths.mjs";
const CALL_TIMEOUT = 60000;

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}
/** The household block is on unless the value clearly says off. Anything else is a
 *  warning, not a silent default: --household auto is not the same as --household no. */
export function householdMode(value) {
  const s = String(value == null ? "auto" : value).trim().toLowerCase();
  if (["no", "off", "nej", "false", "0"].includes(s)) return "off";
  if (["auto", "yes", "on", "ja", "true", "1"].includes(s)) return "auto";
  console.log(`  warn  --household "${s}" is not auto or off - treated as auto`);
  return "auto";
}

// unknownFlags lives in lib.mjs now, so every script warns the same way about a typo.
export { unknownFlags };

const KNOWN_FLAGS = ["family", "days", "people", "breakfast", "lunchbox", "snacks", "household",
  "soft-cap", "avoid", "fresh", "serial", "max-minutes", "dinners", "cores", "covers",
  "max-per-protein", "extra", "extra-file", "debug", "help"];

function yesNo(value, dflt) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  if (["yes", "y", "ja", "true", "1"].includes(s)) return true;
  if (["no", "n", "nej", "false", "0"].includes(s)) return false;
  return dflt;
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function daysAgo(iso) {
  if (!iso) return null;
  const t = Date.parse(iso + "T12:00:00Z");
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}
function readJson(path) {
  // A missing file here is always something a run wrote earlier, not the profile a person
  // edits, so the message names the command that creates it: the same dead end looked like
  // a broken install to the first person who cloned this without an order history.
  if (!existsSync(path)) {
    const what = path.includes("/data/") ? "run node mine-history.mjs (and the recipe miners) first" : "run node init-family.mjs first";
    throw new Error("missing file: " + path + " - " + what);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Intents from the dinner cores, in menu order: one core covers 2 days for 5 people. */
function dinnerIntents(cores, wantedIds, rules) {
  const out = [];
  for (const id of [...new Set(wantedIds)]) {
    const core = cores.find((c) => c.id === id);
    if (!core) {
      console.log(`  skip  dinner:${id} is not in profiles/dinners.json`);
      continue;
    }
    for (const ing of core.ingredients || []) {
      out.push({ source: "dinner:" + id, sourceLabel: core.name, query: ing.query, need: ing.need,
        mode: "cheapest", alt: ing.alt || [], preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct });
    }
  }
  return out;
}

/** Intents from a pantry block, gated by the stock cycle when one is defined. */
function blockIntents(items, blockName, days, cycleDays, staplesByName, staplesBySku, rules) {
  const out = [];
  for (const it of items || []) {
    const qtyPerCycle = Number(it.qtyPerCycle || 1);
    const overCycle = Math.max(1, Math.ceil((qtyPerCycle * days) / Math.max(1, cycleDays)));
    // A pantry line is a MEASURE: "1 pære per lunch box" is 8 pieces over 8 days, about
    // 1,5 kg, and must meet the 1 kg bag - not buy three of them. Lines that count packs
    // (mælk, køkkenrulle) leave unit out and keep the old pack arithmetic.
    const need = it.unit ? `${overCycle} ${it.unit}` : `${overCycle} stk`;
    const measureNote = it.unit ? `${qtyPerCycle} ${it.unit} per cycle x ${days} d / ${cycleDays} d cycle` : `${overCycle} packs over ${days} d`;
    let gate = null;
    if (it.everyNDays) {
      const known = (it.sku ? staplesBySku.get(String(it.sku)) : null) || staplesByName.get(norm(it.query)) || staplesByName.get(norm(it.name));
      const since = known ? daysAgo(known.lastDate) : null;
      const elapsed = since === null ? it.everyNDays : since;
      if (elapsed < it.everyNDays) {
        gate = `skipped: last bought ${since === null ? "unknown" : since + " d ago"}, cycle ${it.everyNDays} d`;
      } else {
        gate = `due: last bought ${since === null ? "unknown" : since + " d ago"}, cycle ${it.everyNDays} d`;
      }
    }
    if (gate && gate.startsWith("skipped")) {
      out.push({ source: blockName + ":" + it.id, sourceLabel: blockName, query: it.query, skipped: gate, sku: it.sku, mode: it.mode });
      continue;
    }
    out.push({
      source: blockName + ":" + it.id, sourceLabel: blockName, query: it.query,
      need, mode: it.mode, sku: it.sku, alt: it.alt || [], note: it.note || gate || measureNote,
      preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct,
    });
  }
  return out;
}

/** Parse --extra "Name:2 stk" repeated, plus an optional --extra-file with one per line. */
export function extraIntents(argvExtra, extraFile, rules) {
  const lines = [];
  for (const e of argvExtra) if (e) lines.push(e);
  if (extraFile && existsSync(extraFile)) lines.push(...readFileSync(extraFile, "utf8").split("\n"));
  const out = [];
  for (const line of lines) {
    const t = String(line || "").trim();
    if (!t || t.startsWith("#")) continue;
    const [q, need] = t.split(":").map((s) => (s || "").trim());
    if (!q) {
      console.log(`  skip  --extra "${t}" has no product name in front of the colon`);
      continue;
    }
    out.push({ source: "extra", sourceLabel: "extra", query: q, need: need || null, mode: "cheapest",
      preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct });
  }
  return out;
}

/**
 * One product, one decision, before anything is bought.
 *
 * Two dinners that each ask for 4 eggs need 8 eggs. Resolved separately they each
 * round up to a 10-pack and the basket carries 20; summed they need one. The same
 * rule joins a dinner and a breakfast line that ask for the same product. Only needs
 * in one scale (g/kg, ml/l, pieces) are added, and an intent that pins a sku or an
 * unparseable need is passed through untouched.
 */
export function consolidateIntents(intents) {
  const out = [], byKey = new Map();
  for (const it of intents || []) {
    const need = it.need ? parseNeed(it.need) : null;
    const base = need ? toBaseMeasure(need.qty, need.unit) : null;
    if (!base || it.sku || it.mode === "history") { out.push(it); continue; }
    const key = `${norm(it.query)}|${it.mode || "cheapest"}|${base.measure}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.amount = Number((seen.amount + base.value).toFixed(2));
      seen.parts.push({ source: it.source, need: it.need });
      continue;
    }
    const ref = { ...it };
    byKey.set(key, { ref, amount: base.value, measure: base.measure, parts: [{ source: it.source, need: it.need }] });
    out.push(ref);
  }
  let collapsed = 0;
  for (const e of byKey.values()) {
    if (e.parts.length < 2) continue;
    collapsed++;
    const rounded = Number(e.amount.toFixed(e.measure === "stk" ? 0 : 1));
    e.ref.need = `${rounded} ${e.measure}`;
    e.ref.rationale = [e.ref.rationale, `${rounded} ${e.measure} in total from ${e.parts.length} lines (${e.parts.map((x) => `${x.need} ${x.source}`).join(" + ")})`].filter(Boolean).join(" | ");
  }
  return { intents: out, collapsed };
}

/**
 * What the loop learned from the baskets this family approved itself.
 *
 * learn.mjs compares a plan with the order that followed it. Three things come back:
 * products this family keeps taking OUT of the basket, how much more or less of a
 * product they really buy, and what they keep ADDING themselves. The first is left out
 * and named in the plan file, the second scales the need, the third is bought with its
 * evidence next to it. A line the family typed with --extra is never dropped: they asked
 * for it today.
 */
export function applyLearning(intents, fam, options, rules) {
  const out = { enabled: fam.learning.enabled, pairs: 0, avoided: [], biased: 0, adds: [], taste: fam.taste ? fam.taste.liked.length + fam.taste.refused.length : 0 };
  const learned = fam.learned;
  if (!out.enabled || !learned) return out;
  out.pairs = (learned.compared || {}).plans || 0;
  const avoid = learned.avoid || [];
  const kept = [];
  for (const it of intents) {
    const w = productWord(it.query || "");
    const hit = w && it.source !== "extra" ? avoid.find((a) => a.word === w) : null;
    if (hit) { out.avoided.push({ query: it.query, source: it.source, word: w, evidence: hit.evidence }); continue; }
    const b = biasIntent(it, learned.quantityBias || [], { maxQuantityFactor: fam.learning.maxQuantityFactor });
    if (b.changed) out.biased++;
    kept.push(b.intent);
  }
  intents.length = 0;
  intents.push(...kept);
  if (fam.learning.autoAddMissing && (learned.add || []).length > 0) {
    const adds = addIntentsOf(learned.add, { gapDays: learned.orderGapDays || 10, days: options.days, rules });
    intents.push(...adds);
    out.adds = adds.map((a) => ({ query: a.query, need: a.need, evidence: a.note }));
  }
  return out;
}

/** Merge duplicate queries so the same product is bought once with summed packs. */
/** Public for the test: what a resolved answer list becomes (items, gaps, blockers). */
export function mergeItems(resolved, purchase) {
  const bySku = new Map();
  const unresolved = [];
  const gaps = [];
  const substitutedAway = [];
  for (const r of resolved) {
    if (!r.ok) {
      if (recipeGapOf(r)) gaps.push(r);
      else unresolved.push(r);
      continue;
    }
    if (r.substitutedFrom) substitutedAway.push({ wanted: r.substitutedFrom, got: r.pick.name, source: r.source });
    const key = r.pick.sku;
    const e = bySku.get(key) || {
      sku: r.pick.sku, name: r.pick.name, brand: r.pick.brand, price: r.pick.price,
      unitPrice: r.pick.unitPrice, unitLabel: r.pick.unitLabel, pack: r.pick.pack,
      url: r.pick.url, packs: 0, sources: [], why: [], rationales: [], recipe: null, mode: r.mode, onSale: !!r.pick.onSale,
      needMeasure: null, needAmount: 0,
    };
    // Two different names can land on the same shelf item (a recipe's "Æg" and the
    // breakfast "Skrabeæg"). Their needs are summed so the pack decision sees the whole
    // week instead of two separate roundings.
    const nb = r.need ? toBaseMeasure(r.need.qty, r.need.unit) : null;
    if (nb) {
      if (!e.needMeasure) e.needMeasure = nb.measure;
      if (e.needMeasure === nb.measure) e.needAmount = Number((e.needAmount + nb.value).toFixed(2));
    }
    e.packs += r.packs;
    e.sources.push(r.source);
    e.why.push(r.why);
    if (r.rationale) e.rationales.push(r.rationale);
    if (r.sourceLabel && !e.recipe) e.recipe = r.sourceLabel;
    bySku.set(key, e);
  }
  const items = [...bySku.values()].map((e) => {
    const summed = e.needMeasure && e.needAmount > 0 && e.sources.length > 1
      ? choosePack({ qty: e.needAmount, unit: e.needMeasure }, [e], { name: e.name, ...(purchase || {}) })
      : null;
    if (summed && summed.packs !== e.packs) {
      e.packs = summed.packs;
      e.why.push(`${summed.why} summed from ${e.sources.length} lines`);
      e.rationales.push(`${e.needAmount} ${e.needMeasure} wanted across ${e.sources.length} lines, bought as ${summed.packs} pack(s)`);
    }
    return {
      ...e,
      total: Number((e.price * e.packs).toFixed(2)),
      sources: [...new Set(e.sources)],
      why: [...new Set(e.why)].join("; "),
      rationale: [...new Set(e.rationales)].join(" | "),
      recipe: e.recipe,
    };
  }).sort((a, b) => a.sources[0].localeCompare(b.sources[0]) || a.name.localeCompare(b.name));
  const substitutions = unresolved.filter((u) => u.substitution)
    .map((u) => ({ wanted: u.query, source: u.source, why: u.why, ...u.substitution }));
  const flat = unresolved.map((u) => ({ query: u.query, source: u.source, why: u.why }));
  const flatGaps = gaps.map((u) => ({ query: u.query, source: u.source, why: u.why, sourceLabel: u.sourceLabel || null }));
  return { items, unresolved: flat, recipeGaps: flatGaps, substitutions, substitutedAway };
}

/**
 * A line from a recipe card that Namlig has no product for at all - "add yourself to the
 * basket", "see the recipe link", an ingredient the shop simply does not carry. It is a
 * gap in the card, not a product the planner forgot, and it must not block writing the
 * basket. A line that returned products we could not buy stays a problem to fix, and so
 * does anything from breakfast, the lunch box or the household.
 */
function recipeGapOf(r) {
  return String(r.source || "").startsWith("dinner:") && Number(r.candidates) === 0;
}

/** Diff the plan against what is already in the live basket (keep-and-top-up). */
function basketDiff(items, basketLines) {
  const existing = new Map();
  for (const l of basketLines) {
    const sku = String(l.ProductNumber ?? l.ProductId ?? l.Id ?? "");
    const qty = Number(l.Quantity ?? l.Amount ?? 0);
    if (sku) existing.set(sku, { sku, name: l.Name || l.ProductName || "", qty });
  }
  const adds = [];
  let kept = 0;
  for (const it of items) {
    const have = existing.get(String(it.sku));
    if (have && have.qty >= it.packs) { kept++; continue; }
    const extra = have ? it.packs - have.qty : it.packs;
    adds.push({ ...it, packs: extra, alreadyInBasket: have ? have.qty : 0, total: Number((it.price * extra).toFixed(2)) });
  }
  const plannedSkuSet = new Set(items.map((i) => String(i.sku)));
  const untouched = [...existing.values()].filter((e) => !plannedSkuSet.has(e.sku));
  return { adds, keptInFull: kept, untouchedInBasket: untouched };
}

/** Bulk campaigns found while resolving, de-duplicated and ranked by the saving. */
function bulkOffersOf(resolved) {
  const by = new Map();
  for (const r of resolved) {
    if (!r.ok || !r.campaignTip) continue;
    by.set(String(r.campaignTip.sku) + "|" + r.campaignTip.min, r.campaignTip);
  }
  return [...by.values()].sort((a, b) => b.beatsBy - a.beatsBy).slice(0, 10);
}

/** Favourite SKUs the profile pins but Namlig no longer returns. */
function stalePinsOf(resolved) {
  const out = [];
  for (const r of resolved) {
    if (r.ok && r.pinMissed) out.push({ sku: r.pinMissed, source: r.source, using: r.pick ? r.pick.name : "cheapest" });
  }
  return out;
}

/** Sale policy, read from the household profile so a family tunes it in one place. */
function saleRules(household) {
  const r = (household && household.purchaseRules) || {};
  const pct = Number(r.saleTolerancePct);
  return {
    preferSale: r.preferSale !== false,
    saleTolerancePct: Number.isFinite(pct) && pct >= 0 ? Math.min(pct, 50) : 10,
  };
}

/** Which dinner is eaten on which day: each core covers `coversDays` days in order. */
function menuOf(cores, wantedIds, days, coversDays) {
  const per = Math.max(1, Math.min(days, Number(coversDays) || 2));
  const ids = [...new Set(wantedIds)];
  const menu = ids.map((id, i) => {
    const core = cores.find((c) => c.id === id);
    const from = i * per + 1;
    return { id, name: core ? core.name : id, minutes: core ? core.minutes : null,
      days: from + "-" + Math.min(days, from + per - 1) };
  });
  const covered = Math.min(days, ids.length * per);
  return { menu, uncoveredDays: days - covered, daysPerDinner: per };
}

function markdown(plan, diff) {
  return [...markdownHeader(plan, diff), ...markdownLines(diff), ...markdownSwaps(plan),
    ...markdownLeftOut(plan), ...markdownNotes(plan), "", "Next: approve, then run `node apply.mjs --plan <file> --approve I-APPROVE-THIS-BASKET`."]
    .join("\n");
}

/** Ingredients the recipes ask for that this family does not buy: visible, not silent. */
function markdownLeftOut(plan) {
  const rows = plan.dinnerLeftOut || [];
  const gaps = plan.recipeGaps || [];
  if (!rows.length && !gaps.length) return [];
  const L = ["", "## Left out of the recipes", ""];
  for (const r of rows) L.push(`- ${r.recipe}: ${r.text} — ${r.reason}`);
  for (const g of gaps) {
    L.push(`- ${g.sourceLabel || "a dinner"}: "${g.query}" — Namlig has no product with that name (${g.why}). Not counted as a missing item.`);
  }
  return L;
}

function markdownHeader(plan, diff) {
  const o = plan.options;
  const L = ["# Nemlig plan — " + plan.createdAt, "",
    `Days: ${o.days} | ${plan.householdNote || o.people + " people"} | dinners: ${(plan.dinnerMenu || plan.dinnerIds || []).length} (${(plan.dinnerMenu || []).map((m) => m.nights || m.covers).join("+") || plan.daysPerDinner} nights each)`,
    `Blocks: breakfast ${o.breakfast ? "yes" : "no"}, lunch box ${o.lunchbox ? "yes" : "no"}, snacks ${o.snacks ? "yes" : "no"}, household ${o.household}`,
    "", "## Menu", ""];
  for (const m of plan.dinnerMenu) {
    const link = m.url ? ` [recipe](https://www.nemlig.com${m.url})` : "";
    const protein = m.protein ? `, ${m.protein}` : "";
    const nights = Number(m.nights || m.covers || 1);
    const how = nights === 1 ? "one night only, cooked fresh"
      : `cooked once, eaten ${nights} nights (${Math.round((plan.portionsPerNight || 0) * nights)} portions for ${(plan.members || []).map((x) => `${x.count} ${x.role}${x.count > 1 ? "s" : ""}`).join(" + ") || o.people + " people"})`;
    const keeps = m.reheat === "fresh" ? ", does not keep" : m.reheat === "great" ? ", better the next day" : "";
    L.push(`- dag ${m.days}: ${m.name}${m.minutes ? " (" + m.minutes + " min)" : ""}${protein} — ${how}${keeps}${link}`);
  }
  if (plan.uncoveredDays > 0) L.push(`- WARNING: ${plan.uncoveredDays} evening(s) have no dinner - name one with --dinners`);
  L.push("", `${plan.saleItems} of ${plan.items.length} products are on sale.${plan.priceCacheAgeHours ? ` Prices are at most ${plan.priceCacheAgeHours} h old (search cache).` : ""}`, "");
  L.push(`**Planned spend: ${plan.planTotal.toFixed(2)} kr** for ${diff.adds.length} purchases (${plan.items.length} products). Soft cap ${o.softCapKr} kr: ${plan.overSoftCap ? "EXCEEDED - confirm before applying" : "ok"}.`);
  if (plan.keptInFull) L.push(`${plan.keptInFull} product(s) already in the basket at the planned quantity or more - nothing added for those.`);
  if (plan.untouchedInBasket.length) L.push(`${plan.untouchedInBasket.length} product(s) in the basket are not in the plan and are left untouched: ${plan.untouchedInBasket.map((u) => u.name + " x" + u.qty).join(", ")}`);
  L.push("");
  const lw = plan.learning || {};
  L.push("## What the planner learned from your baskets", "");
  if (!lw.enabled) L.push("Learning is off in the profile (`learning.enabled: false`). Nothing here was changed by itself.");
  else if (!lw.pairs) L.push("Nothing yet: no order has followed a plan. Run `node learn.mjs` after you have applied a basket and shopped again - the loop then fills itself from your own edits.");
  else {
    L.push(`${lw.pairs} approved basket(s) compared with what was planned. Every line below is your own doing, and profiles/family-*.json outranks all of it.`);
    if ((lw.avoided || []).length) L.push("", "Left out because you keep taking it out of the basket:", ...lw.avoided.map((a) => `- ${a.query} (${a.source}) - ${a.evidence}`));
    if (lw.biased) L.push("", `${lw.biased} line(s) were scaled to the amount your family actually buys. The line's rationale says so.`);
    if ((lw.adds || []).length) L.push("", "Bought because you add them yourself, not because a recipe asked:", ...lw.adds.map((a) => `- ${a.query} (${a.need}) - ${a.evidence}`));
  }
  L.push("");
  return L;
}

function markdownLines(diff) {
  const L = [];
  let last = "";
  for (const it of diff.adds) {
    const group = (it.sources[0] || "").split(":")[0];
    if (group !== last) { L.push("", "## " + group, ""); last = group; }
    const pack = it.pack && it.pack.qty ? ` (${it.pack.qty} ${it.pack.unit})` : "";
    const wanted = it.needText ? ` · wanted ${it.needText}` : "";
    const why2 = it.rationale ? ` (${it.rationale})` : "";
    L.push(`- ${it.name}${pack} — ${it.packs} × ${it.price.toFixed(2)} = ${it.total.toFixed(2)} kr · ${it.brand || "-"} · ${it.why}${wanted}${why2}`);
  }
  return L;
}

function markdownSwaps(plan) {
  const L = [];
  if ((plan.substitutedAway || []).length) {
    L.push("", "## Swapped by the profile's alt queries", "");
    for (const s of plan.substitutedAway) L.push(`- ${s.wanted} → ${s.got} (${s.source})`);
  }
  if ((plan.substitutions || []).length) {
    L.push("", "## Proposed substitution — approve or ignore", "");
    L.push("None of the usual products were in stock. These are the cheapest alternatives. None of them is in the basket.");
    L.push("");
    for (const s of plan.substitutions) {
      L.push(`- ${s.wanted} (${s.source}) → ${s.name}${s.brand && s.brand !== "-" ? " · " + s.brand : ""} · ${s.price.toFixed(2)} kr${s.onSale ? " (on sale)" : ""} · take ${s.packs} · ${s.why}`);
      L.push(`  accept with: \`${s.accept}\``);
    }
  }
  return L;
}

function markdownNotes(plan) {
  const L = [];
  if ((plan.bulkOffers || []).length) {
    L.push("", "## Bulk offers — cheaper only at the stated quantity (not applied)", "");
    for (const b of plan.bulkOffers) {
      L.push(`- ${b.min} × ${b.name} = ${b.totalPrice} kr (${b.perUnit} ${b.unitLabel}) — ${b.beatsBy.toFixed(2)} kr better per unit than the pick`);
    }
  }
  if ((plan.stalePins || []).length) {
    L.push("", "## Stale favourite SKUs — Namlig did not offer them today", "");
    L.push("Refresh with `node pin-skus.mjs --write` (run `node mine-history.mjs` first if it has been a while).");
    L.push("");
    for (const p of plan.stalePins) L.push(`- ${p.source}: sku ${p.sku} not offered, used ${p.using}`);
  }
  if (plan.skipped.length) {
    L.push("", "## Skipped by stock cycle", "");
    for (const s of plan.skipped) L.push(`- ${s.query} — ${s.skipped}`);
  }
  if (plan.unresolved.length) {
    L.push("", "## NOT FOUND — check these", "");
    for (const u of plan.unresolved) L.push(`- ${u.query} (${u.source}) — ${u.why}`);
  }
  return L;
}

/** Every intent for this run: dinners in menu order, then the enabled pantry blocks. */
function collectIntents(dinners, pantry, staplesByName, staplesBySku, options, household) {
  const wanted = (arg("dinners", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const wantedIds = wanted.length ? wanted : dinners.cores.slice(0, Math.ceil(options.days / dinners.coversDays)).map((c) => c.id);
  const rules = saleRules(household);
  // The pack-choice limits travel with the profile so every resolver call and the
  // merged re-decision below use the same numbers.
  options.purchasing = household.purchasing || {};
  const poolState = poolDinnerIntents(options, wanted, rules);
  let intents = poolState.intents;
  if (!poolState.usedPool) intents = intents.concat(dinnerIntents(dinners.cores, wantedIds, rules));
  const blocks = [["breakfast", options.breakfast, "breakfast"], ["kidLunchbox", options.lunchbox, "lunchbox"],
    ["snacks", options.snacks, "snacks"], ["household", options.household !== "off", "household"]];
  for (const [block, enabled, label] of blocks) {
    if (!enabled) continue;
    intents = intents.concat(blockIntents(pantry.blocks[block], label, options.days, pantry.cycleDays, staplesByName, staplesBySku, rules));
  }
  const extra = process.argv.flatMap((a, i2) => (a === "--extra" ? [process.argv[i2 + 1]] : []));
  const dinnerIds = poolState.usedPool ? poolState.dinnerIds : wantedIds;
  return { intents: intents.concat(extraIntents(extra, arg("extra-file", null), rules)), wantedIds: dinnerIds,
    menu: poolState.menu, leftOut: poolState.leftOut, dinnerSource: poolState.source };
}

/**
 * Dinners from the recipe rotation (profiles/recipe-pool.json). Used unless --cores is
 * given, or the pool file or its profiles are missing - then plan.mjs falls back to the
 * pinned cores in profiles/dinners.json.
 */
function poolDinnerIntents(options, wanted, rules) {
  const fam = options.family;
  if (process.argv.includes("--cores") || !fam.pool.pool.length) {
    if (!fam.pool.pool.length) console.log("  cores: no recipe pool - run node pick-recipe-pool.mjs first");
    return { usedPool: false, intents: [], menu: null, leftOut: [], dinnerIds: null, source: "cores" };
  }
  const { amounts, meat, exclusions } = fam;
  const rot = fam.household.rotation || {};
  const COOKED = BASE + "/data/cooked-log.jsonl";
  const cookedTimes = readCookHistory({ linesFile: BASE + "/data/order-lines-raw.jsonl", rotationFile: BASE + "/data/rotation.json", cookedFile: COOKED });
  const lastUsed = readRotation({ plansDir: BASE + "/data/plans", linesFile: BASE + "/data/order-lines-raw.jsonl", rotationFile: BASE + "/data/rotation.json", cookedFile: COOKED });
  const coversDays = Number(arg("covers", "2")) || 2;
  const pick = chooseDinners(fam.pool.pool, {
    days: options.days, coversDays, lastUsed, wanted,
    preferLeftovers: fam.household.preferLeftovers,
    maxNights: fam.household.maxNightsPerDinner,
    reheatByFormat: fam.household.reheatByFormat,
    nightsOverride: fam.household.nightsOverride,
    maxPerProtein: Number(arg("max-per-protein", String(rot.maxPerProtein ?? 2))) || 2,
    minFish: Number(rot.minFishDishes ?? 1) || 0,
    cookedTimes,
    taste: fam.learning.enabled ? fam.taste : { liked: [], refused: [] },
    exploration: fam.learning.exploration,
  });
  // A --dinners id that matches nothing in the pool used to decide nothing at all: the
  // rotation chose the menu and the person believed the dinner they asked for was in it.
  for (const w of (pick.unknownWanted || [])) {
    console.log(`  warn: --dinners "${w}" is not in the recipe pool - use a name from the menu or the recipe url`);
  }
  let intents = [], leftOut = [];
  const stdPortions = Number((fam.household.portionsPerNight || 2.6) * fam.household.maxNightsPerDinner) || 5;
  const portionNote = `${(fam.household.portionsPerNight || 0).toFixed(1)} portions a night`;
  for (const r of pick.chosen) {
    const entry = (pick.menu || []).find((m) => (m.url || m.id) === r.url) || {};
    const portionsForThis = Number(((fam.household.portionsPerNight || 2.6) * (entry.nights || entry.covers || 2)).toFixed(1));
    const built = recipeIntents(r, { amounts, meat, exclusions, sourcePrefix: "dinner",
      portions: portionsForThis, standardPortions: stdPortions, note: `${entry.nights || entry.covers || 2} ${entry.nights === 1 ? "night" : "nights"}, ${portionNote}` });
    for (const it of built.intents) intents.push({ ...it, preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct });
    for (const lo of built.leftOut) leftOut.push({ ...lo, recipe: r.name });
    console.log(`  dinner ${pick.chosen.indexOf(r) + 1}: ${r.name} (${r.minutes} min, ${r.protein}, last cooked ${lastUsed[r.url] || "not in the stored history"})`);
  }
  return {
    usedPool: true, intents, leftOut, dinnerIds: pick.chosen.map((c) => c.url), source: "recipe pool",
    menu: { menu: pick.menu, uncoveredDays: pick.uncoveredDays, daysPerDinner: pick.daysPerDinner },
  };
}

/** Resolve every live intent against Namlig, pacing and caching each search. */
/**
 * Ask Namlig about every intent. The gate in lib.mjs keeps the traffic polite: a bounded
 * number of calls at once, a minimum spacing between two starts, a backoff when the shop
 * pushes back, and a deadline so a slow evening ends with a message instead of a hang.
 * Results keep the order the intents came in, so the plan reads the same every time.
 */
async function resolveAll(live, options) {
  const lanes = options.serial ? 1 : readConcurrency();
  const limiter = new Limiter({
    concurrency: lanes,
    minIntervalMs: options.serial ? 400 : 120,
    deadlineAtMs: Date.now() + options.maxMinutes * 60000,
    maxCalls: Number(process.env.NEMLIG_MAX_CALLS) || 400,
  });
  const t0 = Date.now();
  const { mcp } = await connect(loadEnv(), { limiter });
  const connectMs = Date.now() - t0;
  const cache = loadCache();
  const t1 = Date.now();
  const resolved = await mapPool(live, async (it) => {
    const r = await resolveIntent(mcp, {
      query: it.query, need: it.need, mode: it.mode, sku: it.sku, alt: it.alt || [],
      avoidBrands: options.avoid, force: options.fresh,
      preferSale: it.preferSale, saleTolerancePct: it.saleTolerancePct, purchasing: options.purchasing,
    }, { cache });
    const tag = r.ok ? `${r.pick.name} x${r.packs} = ${r.total} kr` : "NOT FOUND";
    console.log(`  ${it.source.padEnd(28)} ${String(it.query).slice(0, 34).padEnd(34)} ${tag}`);
    return { ...r, source: it.source, sourceLabel: it.sourceLabel || null, needText: it.need || null, rationale: it.rationale || null };
  }, { concurrency: lanes });
  saveCache(cache);
  let oldestCacheMs = 0;
  let fromCache = 0;
  let stale = 0;
  for (const r of resolved) {
    if (Number.isFinite(r.ageMs) && r.ageMs > oldestCacheMs) oldestCacheMs = r.ageMs;
    if (r.cached) fromCache++;
    if (r.stale) stale++;
  }
  const timing = {
    connectMs, catalogMs: Date.now() - t1, intents: live.length, fromCache,
    stale: resolved.filter((r) => r.stale).length,
    gate: limiter.summary(), lanes, serial: options.serial, maxMinutes: options.maxMinutes,
    maxCalls: limiter.maxCalls,
  };
  console.log(timingLine(timing));
  return { mcp, resolved, oldestCacheMs, timing };
}

/** One line a person reads to know where the time went, and what the gate did. */
function timingLine(t) {
  return `Timing: connect ${(t.connectMs / 1000).toFixed(1)}s, catalog ${(t.catalogMs / 1000).toFixed(1)}s for `
    + `${t.intents} intent(s) — ${t.fromCache} answered from cache, gate: ${t.gate}${t.serial ? ", serial" : ""}`
    + (t.stale ? `, ${t.stale} from a stale shelf` : "") + ".";
}

/** Console summary: the headline numbers, the warnings, and where to read more. */
function printSummary(plan, diff, options, planTotal, jsonPath, mdPath) {
  if ((plan.substitutions || []).length) {
    console.log("");
    console.log(`SUBSTITUTIONS: ${plan.substitutions.length} item(s) out of stock - cheapest alternative proposed, nothing added:`);
    for (const s of plan.substitutions) console.log(`  ${s.wanted} -> ${s.name} ${s.price.toFixed(2)} kr   accept: ${s.accept}`);
  }
  if (plan.uncoveredDays > 0) console.log(`WARNING: ${plan.uncoveredDays} evening(s) have no dinner - add cores with --dinners.`);
  console.log("");
  console.log(`PLAN (dry run): ${diff.adds.length} purchases, ${plan.saleItems} on sale, ${planTotal.toFixed(2)} kr added. Basket now ${plan.basketBefore.lines} lines / ${plan.basketBefore.totalProducts} kr.`);
  if (plan.overSoftCap) console.log(`WARNING: over the ${options.softCapKr} kr soft cap by ${(planTotal - options.softCapKr).toFixed(2)} kr.`);
  if (plan.unresolved.length) console.log(`WARNING: ${plan.unresolved.length} intent(s) found no product — fix them before applying.`);
  if ((plan.timing || {}).stale) console.log(`WARNING: ${plan.timing.stale} line(s) were decided on a shelf the shop could not answer - the price cache from the run before was used, check those lines.`);
  if ((plan.recipeGaps || []).length) console.log(`NOTE: ${plan.recipeGaps.length} recipe line(s) name something Namlig has no product for (an "add yourself" line, a link) — listed under Left out, they do not block applying.`);
  if (plan.skipped.length) console.log(`Stock cycle skipped ${plan.skipped.length} item(s).`);
  if ((plan.stalePins || []).length) console.log(`NOTE: ${plan.stalePins.length} pinned favourite sku(s) were not offered - cheapest used, see the plan file.`);
  if ((plan.bulkOffers || []).length) console.log(`Bulk offers (cheaper in quantity, not applied): ${plan.bulkOffers.length} - see the plan file.`);
  console.log("Wrote " + jsonPath + " and " + mdPath);
  console.log("Nothing was added to the basket. This was a dry run.");
}

function readOptions() {
  const a = (name, dflt) => arg(name, dflt);
  return {
    days: Math.max(1, Math.min(14, Number(a("days", "8")) || 8)),
    people: Math.max(1, Number(a("people", "5")) || 5),
    breakfast: yesNo(a("breakfast", null), true),
    lunchbox: yesNo(a("lunchbox", null), true),
    snacks: yesNo(a("snacks", null), false),
    household: householdMode(a("household", "auto")),
    softCapKr: Number(a("soft-cap", "1500")) || 1500,
    avoid: (a("avoid", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
    fresh: process.argv.includes("--fresh"),
    // --serial is the polite switch: one call at a time, wider spacing. Use it when the
    // shop answers slowly or pushes back. maxMinutes ends the run instead of hanging.
    serial: process.argv.includes("--serial"),
    maxMinutes: maxRunMinutes(a("max-minutes", process.env.NEMLIG_MAX_MINUTES || "15")),
  };
}

/** A run may not spend more than this much wall clock on shop calls. */
function maxRunMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  return Math.max(1, Math.min(60, Math.floor(n)));
}

const USAGE = [
  "usage: node plan.mjs [options]  (dry run: nothing is written to the basket)",
  "  --days 8                1-14 evenings        --breakfast|--lunchbox|--snacks yes|no",
  "  --household auto|off    --people N           --soft-cap 1500",
  "  --family <name>         --covers 2           --dinners <name>    (a menu name)",
  "  --cores                 --max-per-protein N  --avoid \"brand,word\"",
  "  --extra \"Name:300g\"    --fresh (ignore the 24 h price cache)",
  "  --serial                one request at a time, wider spacing",
  "  --max-minutes 15        stop the run after this much wall clock",
  "  --debug                 print the stack on a failure",
  "plan file: data/plans/plan-latest.md and plan-latest.json",
].join("\n");

async function main() {
  const tRun = Date.now();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (arg("dinners", null) && !process.argv.includes("--cores")) {
    console.log("  warn  --dinners only picks from the pinned cores: add --cores, else the rotation pool decides the menu");
  }
  const options = readOptions();
  const fam = loadFamily({ name: arg("family", null) });
  options.family = fam;
  const household = fam.household;
  const pantry = fam.pantry;
  const dinners = fam.dinners;
  console.log(`Profile: ${fam.name} (${fam.file}) - ${household.people} portions per dinner, soft cap ${household.softCapKr} ${household.currency}.`);
  const staples = readJson(BASE + "/data/staples.json");
  const famText = `${(fam.household.members || []).map((x) => `${x.count} ${x.role}${x.count > 1 ? "s" : ""}`).join(" + ") || fam.household.people + " people"} = ${(fam.household.portionsPerNight || 0).toFixed(1)} portions a night`;
  console.log(`Household: ${famText}.`);
  const staplesByName = new Map();
  const staplesBySku = new Map();
  for (const s of staples) {
    staplesByName.set(norm(s.name), s);
    if (s.sku) staplesBySku.set(String(s.sku), s);
  }

  const { intents, wantedIds, menu: poolMenu, leftOut, dinnerSource } = collectIntents(dinners, pantry, staplesByName, staplesBySku, options, household);
  const skipped = intents.filter((i) => i.skipped);
  const liveIntents = intents.filter((i) => !i.skipped);
  const learning = applyLearning(liveIntents, fam, options, saleRules(household));
  if (learning.enabled && learning.pairs > 0) {
    console.log(`Learning from ${learning.pairs} approved basket(s): ${learning.avoided.length} product(s) left out, ${learning.biased} quantity correction(s), ${learning.adds.length} add-on(s) you keep buying.`);
  }
  const grouped = consolidateIntents(liveIntents);
  const live = grouped.intents;
  console.log(`Resolving ${live.length} intents (${grouped.collapsed} product(s) summed across lines, ${skipped.length} skipped by stock cycle) against Namlig...`);

  warnUnknownFlags(process.argv, KNOWN_FLAGS);
  const { mcp, resolved, oldestCacheMs, timing } = await resolveAll(live, options);
  const tAfterResolve = Date.now();
  const { items, unresolved, recipeGaps, substitutions, substitutedAway } = mergeItems(resolved, options.purchasing);
  const basket = await mcp.call("get_basket", {}, { timeoutMs: CALL_TIMEOUT });
  if (basket.isError) throw new Error("get_basket failed: " + basket.text.slice(0, 200));
  const bJson = basket.json || {};
  const diff = basketDiff(items, bJson.Lines || []);
  const planTotal = Number(diff.adds.reduce((sum, i) => sum + i.total, 0).toFixed(2));
  const menu = poolMenu || menuOf(dinners.cores, wantedIds, options.days, dinners.coversDays);

  const plan = {
    schemaVersion: 1,
    kind: "nemlig-plan",
    atIso: new Date().toISOString(),
    createdAt: new Date().toLocaleString("da-DK", { timeZone: household.timezone || "Europe/Copenhagen", hour12: false }) + " (Europe/Copenhagen)",
    options,
    dinnerIds: wantedIds,
    dinnerMenu: menu.menu,
    dinnerSource: dinnerSource || "cores",
    dinnerLeftOut: leftOut || [],
    uncoveredDays: menu.uncoveredDays,
    daysPerDinner: menu.daysPerDinner,
    householdNote: famText,
    learning,
    portionsPerNight: fam.household.portionsPerNight || 0,
    members: fam.household.members || [],
    items,
    skipped,
    unresolved,
    recipeGaps,
    substitutions,
    substitutedAway,
    bulkOffers: bulkOffersOf(resolved),
    stalePins: stalePinsOf(resolved),
    saleItems: items.filter((i) => i.onSale).length,
    priceCacheAgeHours: Number((oldestCacheMs / 3600000).toFixed(1)),
    timing,
    planTotal,
    overSoftCap: planTotal > options.softCapKr,
    basketBefore: { lines: (bJson.Lines || []).length, totalProducts: Number(bJson.TotalProductsPrice ?? 0), minOrder: bJson.MinimumOrderTotal ?? null },
    keptInFull: diff.keptInFull,
    untouchedInBasket: diff.untouchedInBasket,
    adds: diff.adds,
    policy: household.basketPolicy,
  };

  const paths = writePlan(plan, diff);
  console.log(`Timing: plan written in ${((Date.now() - tAfterResolve) / 1000).toFixed(1)}s, whole run ${((Date.now() - tRun) / 1000).toFixed(1)}s.`);
  printSummary(plan, diff, options, planTotal, paths.jsonPath, paths.mdPath);
}

/** Save the plan under a timestamp plus the two plan-latest aliases. */
function writePlan(plan, diff) {
  mkdirSync(BASE + "/data/plans", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "").slice(0, 15);
  const jsonPath = BASE + "/data/plans/plan-" + stamp + ".json";
  const mdPath = BASE + "/data/plans/plan-" + stamp + ".md";
  writeJsonAtomic(jsonPath, plan);
  writeFileSync(mdPath, markdown(plan, diff));
  writeJsonAtomic(BASE + "/data/plans/plan-latest.json", plan);
  writeFileSync(BASE + "/data/plans/plan-latest.md", markdown(plan, diff));
  return { jsonPath, mdPath };
}

// Run only when started as a command, so a test can import the pure parts.
if (process.argv[1] && process.argv[1].endsWith("plan.mjs")) {
  main().catch((e) => { reportFailure(e); process.exitCode = 1; });
}
