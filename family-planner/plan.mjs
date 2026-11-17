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
//   node plan.mjs --days 8 --breakfast yes --lunchbox yes --snacks no \
//                 --household auto --dinners <core-id>,<core-id> \
//                 --extra "Kyllingelår:1 stk" --avoid "wine,alkohol"
// Output:
//   data/plans/plan-<timestamp>.json + .md, and copies named plan-latest.{json,md}
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { copenhagenNow } from "./slots.mjs";
import { connect, loadEnv, Limiter, mapPool, readConcurrency, reportFailure, unknownFlags, warnUnknownFlags } from "./lib.mjs";
import { resolveIntent, parseNeed, loadCache, saveCache, extraFlag } from "./catalog.mjs";
import { toBaseMeasure, choosePack, pieceWeightOf } from "./units.mjs";
import { chooseDinners, recipeIntents, readRotation, readCookHistory } from "./dinners.mjs";
import { biasIntent, addIntentsOf, productWord } from "./learn.mjs";
import { trimItems } from "./trim.mjs";
import { loadFamily, blockPeopleOf } from "./family.mjs";

import { HOME as BASE, writeJsonAtomic } from "./paths.mjs";
const CALL_TIMEOUT = 60000;

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const value = process.argv[i + 1];
  // The next flag is not this flag's value. `--dinners --cores` used to search for a
  // dinner called "--cores" and skip the cores the person asked for.
  return value === undefined || value.startsWith("--") ? dflt : value;
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
  "max-per-protein", "extra", "extra-file", "max-kr", "trim", "simulate-empty", "debug", "help"];

/** A flag word for yes or no, in the words a person actually types, Danish included.
 *  Returns null when the word means neither, so the caller reports what it used instead.
 *  "on" and "off" belong here: --trim is documented as on|off, and an unknown word fell
 *  back to the default. So "--trim off" trimmed anyway, and "--breakfast off" bought
 *  breakfast. Both were believed, and neither was true. */
export function boolWord(value) {
  const s = String(value == null ? "" : value).trim().toLowerCase();
  if (["yes", "y", "ja", "on", "true", "1"].includes(s)) return true;
  if (["no", "n", "nej", "off", "false", "0"].includes(s)) return false;
  return null;
}
function yesNo(value, dflt) {
  const b = boolWord(value);
  return b === null ? dflt : b;
}

/** A whole number inside a range, or the default when the value is no number at all. */
export function clampInt(raw, min, max, dflt) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// One row per flag that carries a value, holding the same limits readOptions applies to it.
// One table for both, so a note can never promise a number the run did not use. Two flags
// are left out on purpose: --household reports its own value through householdMode, and
// --max-per-protein falls back to the profile's rotation number, which no flag can name.
const MINUTES_DEFAULT = clampInt(process.env.NEMLIG_MAX_MINUTES, 1, 60, 15);
const FLAG_SPECS = [
  { name: "days", kind: "int", min: 1, max: 14, dflt: 8, unit: "evenings", unitOne: "evening" },
  { name: "people", kind: "int", min: 1, max: 99, dflt: 5, unit: "people", unitOne: "person" },
  { name: "covers", kind: "int", min: 1, max: 14, dflt: 2, unit: "days a dinner covers" },
  { name: "max-minutes", kind: "int", min: 1, max: 60, dflt: MINUTES_DEFAULT, unit: "minutes of shop calls", unitOne: "minute of shop calls" },
  { name: "max-kr", kind: "kr", applies: "the profile's ceiling" },
  { name: "soft-cap", kind: "kr", applies: "the profile's soft cap" },
  { name: "trim", kind: "bool", dfltWord: "on" },
  { name: "breakfast", kind: "bool", dfltWord: "yes" },
  { name: "lunchbox", kind: "bool", dfltWord: "yes" },
  { name: "snacks", kind: "bool", dfltWord: "no" },
  { name: "avoid", kind: "empty", none: "names nothing - this run avoids nothing" },
  { name: "dinners", kind: "empty", none: "names no dish - this run uses the rotation" },
  { name: "extra", kind: "empty", none: "names nothing - this run adds no extra list" },
  { name: "extra-file", kind: "empty", none: "names no file - this run reads no extra list" },
  { name: "family", kind: "empty", none: "names no profile - this run takes the only profile in the folder, or stops and asks which one" },
];

/** The value a flag was given, or undefined when the flag is absent. A flag word in the
 *  value position is no value: --avoid --days 8 avoids nothing, it does not avoid "--days". */
function flagValue(argv, name) {
  const i = argv.indexOf("--" + name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith("--")) return "";
  return String(v);
}

/** One note per flag whose value could not be used as given, naming the value that was used.
 *  A silent default is what made --trim off decorative: the flag was read, the behaviour was
 *  not. Printed before a single shop call, so a typo costs no wait and no re-plan. */
export function flagNotes(argv, known = KNOWN_FLAGS) {
  const notes = [];
  for (const spec of FLAG_SPECS) {
    if (!known.includes(spec.name)) continue;
    const raw = flagValue(argv, spec.name);
    if (raw === undefined) continue;
    const note = noteOfFlag(spec, raw);
    if (note) notes.push(note);
  }
  return notes;
}

function noteOfFlag(spec, raw) {
  if (spec.kind === "int") {
    const applied = clampInt(raw, spec.min, spec.max, spec.dflt);
    const unit = applied === 1 && spec.unitOne ? spec.unitOne : spec.unit;
    if (!Number.isFinite(Number(raw))) {
      return `--${spec.name} "${raw}" is not a number - this run uses ${applied} ${unit} instead`;
    }
    if (applied === Number(raw)) return null;
    return `--${spec.name} ${raw} is outside ${spec.min}-${spec.max} - this run uses ${applied} ${unit} instead`;
  }
  if (spec.kind === "kr") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return null;
    return `--${spec.name} "${raw}" is not an amount in kr above 0 - this run uses ${spec.applies} instead`;
  }
  if (spec.kind === "bool") {
    if (boolWord(raw) !== null) return null;
    return `--${spec.name} "${raw}" is not yes or no - this run uses ${spec.dfltWord} instead`;
  }
  if (raw.trim() !== "") return null;
  return `--${spec.name} "" ${spec.none}`;
}
function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
/**
 * Whole calendar days since a date the mined history recorded, at noon on both sides and in the
 * family's own zone. Counted from a wall instant against one noon, a 7-day cycle (the rye bread,
 * the sliced cheese) opened a day late every morning, and the family went without it a day longer.
 */
function daysAgo(iso) {
  if (!iso) return null;
  const then = Date.parse(String(iso).slice(0, 10) + "T12:00:00Z");
  const today = Date.parse(copenhagenNow().slice(0, 10) + "T12:00:00Z");
  if (!Number.isFinite(then) || !Number.isFinite(today)) return null;
  return Math.max(0, Math.round((today - then) / 86400000));
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

/**
 * Intents from a pantry block, gated by the stock cycle when one is defined.
 *
 * Exported for the suite: the three bases below are arithmetic, and arithmetic is cheap to
 * pin and expensive to get wrong.
 *
 * `per` says what a line's quantity counts. `cycle` (the default, and every line mined
 * from an order history) means that number is what THIS household buys per cycle, so a
 * plan for 8 days scales it by days and nothing else - the mined number already contains
 * the family. `person-cycle` and `person-day` mean one unit per person, and those grow
 * with the household: a lunch box is a fixed kit, so it scales with heads, not with
 * appetite. Nobody reinterprets a mined number: a line says which base it is written on.
 */
export function blockIntents(items, blockName, days, cycleDays, staplesByName, staplesBySku, rules, people = 1) {
  const out = [];
  for (const it of items || []) {
    const qtyPerCycle = Number(it.qtyPerCycle || 1);
    const per = String(it.per || "cycle").toLowerCase();
    const onHead = per === "person-day" || per === "person-cycle";
    const heads = onHead ? Math.max(0, Math.round(Number(people) || 0)) : 1;
    let overCycle = per === "person-day"
      ? Math.ceil(qtyPerCycle * heads * days)
      : Math.ceil((qtyPerCycle * heads * days) / Math.max(1, cycleDays));
    if (per === "cycle") overCycle = Math.max(1, overCycle);   // a mined line always buys at least one pack
    // A pantry line is a MEASURE: "1 pære per lunch box" is 8 pieces over 8 days, about
    // 1,5 kg, and must meet the 1 kg bag - not buy three of them. Lines that count packs
    // (mælk, køkkenrulle) leave unit out and keep the old pack arithmetic.
    const need = it.unit ? `${overCycle} ${it.unit}` : `${overCycle} stk`;
    const unitWord = it.unit || "packs";
    const measureNote = per === "person-day"
      ? `${qtyPerCycle} ${unitWord} per person-day x ${heads} ${heads === 1 ? "person" : "people"} x ${days} d`
      : per === "person-cycle"
        ? `${qtyPerCycle} ${unitWord} per person-cycle x ${heads} ${heads === 1 ? "person" : "people"} x ${days} d / ${cycleDays} d cycle`
        : it.unit ? `${qtyPerCycle} ${it.unit} per cycle x ${days} d / ${cycleDays} d cycle` : `${overCycle} packs over ${days} d`;
    if (onHead && heads <= 0) {
      out.push({ source: blockName + ":" + it.id, sourceLabel: blockName, query: it.query,
        skipped: `skipped: ${per} lines need a person to count for, and household.blockPeople.${blockName} is 0`,
        sku: it.sku, mode: it.mode });
      continue;
    }
    let gate = null;
    if (it.everyNDays) {
      const known = (it.sku ? staplesBySku.get(String(it.sku)) : null) || staplesByName.get(norm(it.query)) || staplesByName.get(norm(it.name));
      // A hand-written lastBought (a delivery nobody has ordered yet, a shelf full from
      // a bulk run) counts: the newest of history and note wins the gate.
      const seen = [known ? daysAgo(known.lastDate) : null, it.lastBought ? daysAgo(String(it.lastBought).slice(0, 10)) : null]
        .filter((x) => Number.isFinite(x));
      const since = seen.length ? Math.min(...seen) : null;
      const elapsed = since === null ? it.everyNDays : since;
      // A stop, not an emergency: two evidence-based ways to say it, both family-settable.
      // The pantry compiler marks mined lines stoppedBuying when orders kept passing them
      // by, and a family may write staleAfterCycles on any line. No time default: without
      // either note, an overdue line stays urgent and is planned.
      const staleAfter = Number(it.staleAfterCycles) > 0 ? Number(it.staleAfterCycles) : 0;
      const stale = it.stoppedBuying === true
        || (staleAfter > 0 && since !== null && since > staleAfter * it.everyNDays);
      if (stale) {
        const ago = known && Number.isFinite(Number(known.ordersSince)) && Number(known.ordersSince) > 0
          ? `absent from ${known.ordersSince} orders since` : `cycle ${it.everyNDays} d`;
        gate = `stale: last bought ${since === null ? "unknown" : since + " d ago"}, ${ago} - not planned`;
      } else if (elapsed < it.everyNDays) {
        gate = `skipped: last bought ${since === null ? "unknown" : since + " d ago"}, cycle ${it.everyNDays} d`;
      } else {
        gate = `due: last bought ${since === null ? "unknown" : since + " d ago"}, cycle ${it.everyNDays} d`;
      }
    }
    if (gate && (gate.startsWith("skipped") || gate.startsWith("stale"))) {
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
  if (extraFile && !existsSync(extraFile)) {
    console.log(`  warn  --extra-file "${extraFile}" does not exist`);
  } else if (extraFile) {
    try {
      lines.push(...readFileSync(extraFile, "utf8").split("\n"));
    } catch (e) {
      console.log(`  warn  --extra-file "${extraFile}" could not be read: ${e.message}`);
    }
  }
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
      needMeasure: null, needAmount: 0, alternatives: [], packWindow: r.packWindow || null,
    };
    // Two different names can land on the same shelf item (a recipe's "Æg" and the
    // breakfast "Skrabeæg"). Their needs are summed so the pack decision sees the whole
    // week instead of two separate roundings.
    const nb = r.need ? toBaseMeasure(r.need.qty, r.need.unit) : null;
    if (nb) {
      if (!e.needMeasure) e.needMeasure = nb.measure;
      if (e.needMeasure === nb.measure) e.needAmount = Number((e.needAmount + nb.value).toFixed(2));
      // A count ask ("2 stk" milk from the breakfast block) cannot be added to a litre need
      // from a recipe. Remember the packs that ask paid for, so the litre sum cannot bargain
      // the basket down under a quantity the family named.
      else e.unfoldedPacks = Number((e.unfoldedPacks || 0) + r.packs);
    }
    if (r.packWindow) {
      // Two dinner lines of the same meat widen the band by both person counts:
      // the sum need may undershoot or overshoot within the summed window.
      e.packWindow = { min: (e.packWindow ? e.packWindow.min : 0) + (r.packWindow.min || 0),
        max: (e.packWindow ? e.packWindow.max : 0) + (r.packWindow.max || 0) };
    }
    e.packs += r.packs;
    e.sources.push(r.source);
    // The rivals this shelf offered for the line, kept on the item so a trim decision can
    // weigh them without asking the shop again. A product is never its own rival.
    for (const alt of r.alternatives || []) {
      if (!alt || !alt.sku || String(alt.sku) === String(key)) continue;
      if (!e.alternatives.some((x) => String(x.sku) === String(alt.sku))) e.alternatives.push(alt);
    }
    e.why.push(r.why);
    if (r.rationale) e.rationales.push(r.rationale);
    if (r.sourceLabel && !e.recipe) e.recipe = r.sourceLabel;
    bySku.set(key, e);
  }
  const items = [...bySku.values()].map((e) => {
    const summed = e.needMeasure && e.needAmount > 0 && e.sources.length > 1
      ? choosePack({ qty: e.needAmount, unit: e.needMeasure }, [e], { name: e.name, pieceWeight: pieceWeightOf(e), ...(purchase || {}), ...(e.packWindow ? { packWindow: e.packWindow } : {}) })
      : null;
    // The sum decides the pack, but never below the packs a count ask paid for.
    const wantPacks = summed ? Math.max(summed.packs, e.unfoldedPacks || 0) : e.packs;
    if (summed && wantPacks !== e.packs) {
      e.packs = wantPacks;
      e.why.push(`${summed.why} summed from ${e.sources.length} lines`);
      e.rationales.push(`${e.needAmount} ${e.needMeasure} wanted across ${e.sources.length} lines, bought as ${e.packs} pack(s)`);
      if ((e.unfoldedPacks || 0) > summed.packs) {
        e.why.push(`${e.unfoldedPacks} pack(s) were asked as a count on one line: a ${e.needMeasure} sum cannot hold that, so the count stands`);
      }
    }
    return {
      ...e,
      total: Number((e.price * e.packs).toFixed(2)),
      sources: [...new Set(e.sources)],
      why: [...new Set(e.why)].join("; "),
      rationale: [...new Set(e.rationales)].join(" | "),
      recipe: e.recipe,
      alternatives: e.alternatives.slice(0, 3),
    };
  }).sort((a, b) => a.sources[0].localeCompare(b.sources[0]) || a.name.localeCompare(b.name));
  const substitutions = unresolved.filter((u) => u.substitution)
    .map((u) => ({ wanted: u.query, source: u.source, why: u.why, ...u.substitution }));
  const flat = unresolved.map((u) => ({ query: u.query, source: u.source, why: u.why }));
  // A near miss is not a blocker and not a purchase: it is the shelf saying "almost" within
  // 0,15 of the family's own bar. Listed with its price so the answer is one flag, typed.
  const nearMisses = unresolved.filter((u) => Array.isArray(u.nearMiss) && u.nearMiss.length)
    .map((u) => ({ query: u.query, source: u.source, need: u.nearNeed || null, candidates: u.nearMiss }));
  const flatGaps = gaps.map((u) => ({ query: u.query, source: u.source, why: u.why, sourceLabel: u.sourceLabel || null }));
  return { items, unresolved: flat, recipeGaps: flatGaps, substitutions, substitutedAway, nearMisses };
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

/** Favourite SKUs the profile pins that were not bought: gone from the shelf, or refused by
 *  the family's own never-list. The difference is a different conversation, so it is kept. */
function stalePinsOf(resolved) {
  const out = [];
  for (const r of resolved) {
    if (r.ok && r.pinMissed) out.push({
      sku: r.pinMissed, source: r.source, using: r.pick ? r.pick.name : "cheapest",
      refused: r.pinRefused || null,
    });
  }
  return out;
}

/** The cap a run is measured against: --soft-cap wins, else the profile, else none.
 *  Exported for the suite: a family that set no budget must get no warning, and that
 *  needs a profile without a budget to prove, which is cheaper to test than to run. */
export function softCapOf(flagKr, profileValue) {
  const flag = Number(flagKr);
  if (Number.isFinite(flag) && flag > 0) return flag;
  const profile = Number(profileValue);
  return Number.isFinite(profile) && profile > 0 ? profile : null;
}

/** The ceiling this run must meet, or null when it may only warn about the soft cap.
 *  --trim off is the one thing that must never be read as yes: it plans the whole basket
 *  and lets the warning stand. Kept out of main so the suite can prove it on one shelf. */
export function capOf(trimWord, flagKr, profileKr) {
  if (!yesNo(trimWord == null ? "on" : trimWord, true)) return null;
  return softCapOf(flagKr, profileKr);
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

/** Which dinner is eaten which evening: each core covers `coversDays` evenings in order, and
 *  the last one only the evenings that are left. An evening nobody cooks for is reported, and
 *  a dinner cooked for an evening outside the period is money thrown away, so both are clipped.
 */
function menuOf(cores, wantedIds, days, coversDays) {
  const per = Math.max(1, Math.min(days, Number(coversDays) || 2));
  const ids = [...new Set(wantedIds)];
  const menu = [];
  let start = 1;
  for (const id of ids) {
    if (start > days) break;
    const core = cores.find((c) => c.id === id);
    const covers = Math.min(per, days - start + 1);
    menu.push({ id, url: id, name: core ? core.name : id, minutes: core ? core.minutes : null,
      covers, nights: covers, keepsFor: per, clipped: covers < per, cookedAgo: "unknown (pinned cores)",
      days: start + "-" + (start + covers - 1) });
    start += covers;
  }
  const covered = menu.reduce((n, m) => n + m.covers, 0);
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
      : `cooked once, eaten ${nights} nights (${Number(((plan.portionsPerNight || 0) * nights).toFixed(1))} portions for ${(plan.members || []).map((x) => `${x.count} ${x.role}${x.count > 1 ? "s" : ""}`).join(" + ") || o.people + " people"})`;
    const keeps = m.reheat === "fresh" ? ", does not keep" : m.reheat === "great" ? ", better the next day" : "";
    const again = m.repeated ? " — second cooking of this dish, the pool is too small for the period" : "";
    L.push(`- dag ${m.days}: ${m.name}${m.minutes ? " (" + m.minutes + " min)" : ""}${protein} — ${how}${keeps}${again}${link}`);
  }
  if (plan.uncoveredDays > 0) L.push(`- WARNING: ${plan.uncoveredDays} evening(s) have no dinner - name one with --dinners`);
  L.push("", `${plan.saleItems} of ${plan.items.length} products are on sale.${plan.priceCacheAgeHours ? ` Prices are at most ${plan.priceCacheAgeHours} h old (search cache).` : ""}`, "");
  L.push(`**Planned spend: ${plan.planTotal.toFixed(2)} kr** for ${diff.adds.length} purchases (${plan.items.length} products). Soft cap: ${o.softCapKr === null ? "none set (budget.softCapKr)" : o.softCapKr + " kr - " + (plan.overSoftCap ? "EXCEEDED - confirm before applying" : "ok")}.`);
  if ((plan.trim || []).length) {
    L.push("", `## Trimmed to fit ${plan.capKr} kr`, "");
    for (const t of plan.trim) {
      L.push(t.action === "swap"
        ? `- swap: ${t.name} ${t.from.total.toFixed(2)} kr -> ${t.to.name}, ${t.to.packs} x ${t.to.price.toFixed(2)} kr = ${t.to.total.toFixed(2)} kr, saves ${t.savedKr.toFixed(2)} kr`
          + `${t.fromPack && t.toPack ? `, ${t.fromPack} -> ${t.toPack}` : ""} (${t.why})`
        : `- put back: ${t.name} (${t.total.toFixed(2)} kr) - ${t.protectedBy} line, the least protected of what was left`);
    }
    L.push("", `Trimmed from ${plan.trimBefore.toFixed(2)} kr to ${plan.trimAfter.toFixed(2)} kr.`
      + (plan.trimShortfall > 0 ? ` Still ${plan.trimShortfall.toFixed(2)} kr over: what is left is a dinner's own ingredients.` : ""));
  }
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
    L.push("The usual product did not answer today - out of stock, or the shelf spells it differently. These are the", "closest the shelf has. None of them is in the basket.");
    L.push("");
    for (const s of plan.substitutions) {
      L.push(`- ${s.wanted} (${s.source}) → ${s.name}${s.brand && s.brand !== "-" ? " · " + s.brand : ""} · ${s.price.toFixed(2)} kr${s.onSale ? " (on sale)" : ""} · take ${s.packs}${s.foundBy ? " · " + s.foundBy : ""} · ${s.why}`);
      L.push(`  accept with: \`${s.accept}\``);
    }
  }
  return L;
}

const BACKTICK = String.fromCharCode(96);

/** The name where a person reads it, as a markdown code span: a quote inside the name cannot
 *  then look like the end of the name. A name carrying a backtick cannot be a code span,
 *  and there the sku on the same line is what identifies it. */
export function nameSpan(name) {
  return String(name).includes(BACKTICK) ? String(name) : BACKTICK + String(name) + BACKTICK;
}

export function markdownNotes(plan) {
  const L = [];
  if (plan.menuAgainst && plan.menuAgainst.at) {
    L.push("", "## Menu ranked against", "");
    L.push("The queue is the least recently cooked draw, so this menu comes out the same on every");
    L.push("run until the family buys a basket or logs a meal.");
    L.push(`The plan before this one: ${plan.menuAgainst.at}, ${plan.menuAgainst.dinners} dinners, `
      + `${plan.menuAgainst.total.toFixed(2)} kr (data/plans/plan-latest.json). It is named here, and it does not move the queue:`
      + " a plan nobody bought is not dinner.");
    L.push("To move the queue between orders: `node log-dinner.mjs --dish \"<name from the menu>\"`.");
  }
  const rules = plan.menuRules || {};
  const relaxed = rules.relaxed || [];
  const clipped = (plan.dinnerMenu || []).filter((m) => m.clipped);
  if (relaxed.length || rules.fishSwap || clipped.length) {
    L.push("", "## What the rotation decided, and what it bent", "");
    for (const m of (plan.dinnerMenu || [])) {
      const when = m.cookedAgo === "never" ? "never cooked"
        : Number.isFinite(m.cookedAgo) ? `cooked ${m.cookedAgo} d ago` : `last cooked ${m.lastCooked}`;
      L.push(`- ${m.name}: evenings ${m.days} (${m.nights} night${m.nights === 1 ? "" : "s"}, ${when}${m.resting ? ", back from cooldown" : ""}${m.repeated ? ", cooked again this week" : ""})`);
    }
    for (const r of relaxed) L.push(`- rule bent - ${r.rule}: ${r.dish} — ${r.because}`);
    if (rules.fishSwap && rules.fishSwap.in) {
      L.push(`- fish rule: ${rules.fishSwap.in} in for ${rules.fishSwap.out} (${rules.fishSwap.nights} night(s)) — ${rules.fishSwap.because}`);
    } else if (rules.fishSwap) {
      L.push(`- fish rule: no fish this week — ${rules.fishSwap.because}`);
    }
    for (const m of clipped) {
      L.push(`- cooked short - ${m.name}: keeps for ${m.keepsFor}, bought for ${m.nights}, because the period ends on evening ${String(m.days).split("-")[1]}`);
    }
  }
  if ((plan.bulkOffers || []).length) {
    L.push("", "## Bulk offers — cheaper only at the stated quantity (not applied)", "");
    for (const b of plan.bulkOffers) {
      L.push(`- ${b.min} × ${b.name} = ${b.totalPrice} kr (${b.perUnit} ${b.unitLabel}) — ${b.beatsBy.toFixed(2)} kr better per unit than the pick`);
    }
  }
  if ((plan.stalePins || []).length) {
    const gone = plan.stalePins.filter((p) => !p.refused);
    L.push("", "## Favourite SKUs not bought today", "");
    if (gone.length) L.push("Refresh with `node pin-skus.mjs --write` (run `node mine-history.mjs` first if it has been a while).");
    L.push("");
    for (const p of plan.stalePins) {
      L.push(`- ${p.source}: sku ${p.sku} ${p.refused ? `refused by your own never-list (${p.refused})` : "not offered"}, used ${p.using}`);
    }
  }
  if (plan.skipped.length) {
    L.push("", "## Skipped by stock cycle", "");
    for (const s of plan.skipped) L.push(`- ${s.query} — ${s.skipped}`);
  }
  if (plan.unresolved.length) {
    L.push("", "## NOT FOUND — check these", "");
    for (const u of plan.unresolved) L.push(`- ${u.query} (${u.source}) — ${u.why}`);
  }
  // Almost-good answers, kept out only by the family's own bar. Nothing is bought from here:
  // the line gives the flag that takes one, so a person decides with a price in front of them.
  if ((plan.nearMisses || []).length) {
    L.push("", "## Close but under your bar — one flag takes it", "");
    for (const n of plan.nearMisses) {
      for (const c of n.candidates) {
        const price = Number(c.price).toFixed(2).replace(".", ",");
        const flag = extraFlag(c.name, n.need);
        L.push(`- ${n.query} (${n.source}) — ${nameSpan(c.name)}${c.brand ? " (" + c.brand + ")" : ""} reached `
          + `${String(c.score).replace(".", ",")} against your bar, `
          + `${(c.pack && c.pack.raw) ? c.pack.raw + " for " : ""}${price} kr: `
          + (flag ? `take it with \`${flag}\` (sku ${c.sku})`
            : `its name holds both quote kinds, so no flag is safe to paste - take it with `
              + `\`--extra-file\` (sku ${c.sku})`));
      }
    }
  }
  return L;
}

/** Every intent for this run: dinners in menu order, then the enabled pantry blocks. */
function collectIntents(dinners, pantry, staplesByName, staplesBySku, options, household) {
  // No file and an empty file mean the same thing to a plan: those blocks buy nothing, and
  // the person reading the basket should be told that rather than count the lines.
  const pantryBlocksPresent = Boolean(pantry && pantry.blocks && Object.keys(pantry.blocks).length);
  const wanted = (arg("dinners", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const wantedIds = wanted.length ? wanted : dinners.cores.slice(0, Math.ceil(options.days / options.covers)).map((c) => c.id);
  const rules = saleRules(household);
  // The pack-choice limits travel with the profile so every resolver call and the merged
  // re-decision below use the same numbers. swapNeverWords rides along although it lives
  // under `budget`, because the resolver and the trim must refuse the same words.
  options.purchasing = { ...(household.purchasing || {}), swapNeverWords: household.swapNeverWords || [] };
  const poolState = poolDinnerIntents(options, wanted, rules, household);
  let intents = poolState.intents;
  if (!poolState.usedPool) intents = intents.concat(dinnerIntents(dinners.cores, wantedIds, rules));
  const blocks = [["breakfast", options.breakfast, "breakfast"], ["kidLunchbox", options.lunchbox, "lunchbox"],
    ["snacks", options.snacks, "snacks"], ["household", options.household !== "off", "household"]];
  if (!pantryBlocksPresent) {
    console.log("  warn: no profiles/pantry.json - no breakfast, lunch-box, snack or household lines will be bought");
    console.log("        the shape is profiles/pantry-EXAMPLE.json; pin-skus.mjs can fill its sku fields afterwards");
  }
  for (const [block, enabled, label] of blocks) {
    if (!enabled) continue;
    const lines = pantry.blocks && Array.isArray(pantry.blocks[block]) ? pantry.blocks[block] : null;
    const people = (options.blockPeople || {}).people || {};
    const heads = Number(people[block]);
    const built = blockIntents(lines, label, options.days, pantry.cycleDays, staplesByName, staplesBySku, rules,
      Number.isFinite(heads) ? heads : 1);
    if ((lines || []).some((it) => String(it.per || "cycle") !== "cycle")) {
      const where = (options.blockPeople || {}).fromOverride || [];
      console.log(`  block ${label}: ${Number.isFinite(heads) ? heads : 1} people counted for the per-person lines`
        + ` (${where.includes(block) ? "household.blockPeople" : "dinners.members"})`);
    }
    intents = intents.concat(built);
  }
  const extra = process.argv.flatMap((a, i2) => {
    if (a !== "--extra") return [];
    const value = process.argv[i2 + 1];
    return value && !value.startsWith("--") ? [value] : [];
  });
  const dinnerIds = poolState.usedPool ? poolState.dinnerIds : wantedIds;
  return { intents: intents.concat(extraIntents(extra, arg("extra-file", null), rules)), wantedIds: dinnerIds,
    menu: poolState.menu, leftOut: poolState.leftOut, dinnerSource: poolState.source };
}

/**
 * One entry per cooking, not per dish name. A dish cooked twice appears twice, each time with
 * its own evenings and its own portions, and the two asks merge on the sku later on. Every
 * cooking prints the line that says what the rotation chose and how it got there.
 */
function cookingIntents(pick, { amounts, meat, exclusions, purchasing = {}, household, rules, lastUsed }) {
  let intents = [], leftOut = [];
  // The base a real ask is divided by is the pot the recipe amounts were already scaled
  // to: household.cookServings in profiles/amounts.json, measured from this family's own
  // history. It used to be portionsPerNight x maxNightsPerDinner - the same household
  // appetite on both sides of the division - so appetite cancelled out: a family of two
  // teenagers and a family of one adult bought the identical pot. Keep the appetite on one
  // side only, and the number becomes what a portion costs in food.
  const cookBase = Number((amounts.household || {}).cookServings) || 5;
  const portionsPerNight = Number(household.portionsPerNight) || 3;   // nights.mjs fallback
  const stdPortions = cookBase;
  const portionNote = `${portionsPerNight.toFixed(1)} portions a night`;
  for (const [i, r] of pick.chosen.entries()) {
    // The menu is one entry per cooking, so a dish cooked twice appears twice with its own
    // evenings. Pairing by position keeps the printed evenings the ones that were bought for.
    const entry = (pick.menu || [])[i] || {};
    const portionsForThis = Number((portionsPerNight * (entry.nights || entry.covers || 2)).toFixed(1));
    const built = recipeIntents(r, { amounts, meat, exclusions, purchasing, sourcePrefix: "dinner",
      pieceWeights: ((household || {}).purchasing || {}).pieceWeights || null,
      portions: portionsForThis, standardPortions: stdPortions, note: `${entry.nights || entry.covers || 2} ${entry.nights === 1 ? "night" : "nights"}, ${portionNote}` });
    for (const it of built.intents) intents.push({ ...it, preferSale: rules.preferSale, saleTolerancePct: rules.saleTolerancePct });
    for (const lo of built.leftOut) leftOut.push({ ...lo, recipe: r.name });
    const when = entry.cookedAgo === "never" ? "never cooked"
      : Number.isFinite(entry.cookedAgo) ? `cooked ${entry.cookedAgo} d ago`
      : `last cooked ${lastUsed[r.url] || "not in the stored history"}`;
    const clipNote = entry.clipped ? `, cut to ${entry.nights} night${entry.nights === 1 ? "" : "s"} by the end of the period` : "";
    const again = entry.repeated ? ", cooked again this week" : "";
    console.log(`  dinner ${i + 1}: ${r.name} (${r.minutes} min, ${r.protein}, `
      + `evenings ${entry.days}, ${when}${clipNote}${again})`);
  }
  // A rule the planner bent is a decision the family should see while it is cheap to change.
  for (const b of pick.relaxed || []) {
    console.log(`  warn: ${b.rule} bent for "${b.dish}" - ${b.because}`);
  }
  if (pick.fishSwap && pick.fishSwap.in) {
    console.log(`  fish: ${pick.fishSwap.in} swapped in for ${pick.fishSwap.out} (${pick.fishSwap.nights} night(s)) - ${pick.fishSwap.because}`);
  } else if (pick.fishSwap) {
    console.log(`  warn: no fish dinner in the menu - ${pick.fishSwap.because}`);
  }
  return { intents, leftOut };
}

/**
 * Dinners from the recipe rotation (profiles/recipe-pool.json). Used unless --cores is
 * given, or the pool file or its profiles are missing - then plan.mjs falls back to the
 * pinned cores in profiles/dinners.json.
 */
function poolDinnerIntents(options, wanted, rules, household) {
  const fam = options.family;
  if (process.argv.includes("--cores") || !fam.pool.pool.length) {
    if (!fam.pool.pool.length) console.log("  cores: no recipe pool - run node pick-recipe-pool.mjs first");
    return { usedPool: false, intents: [], menu: null, leftOut: [], dinnerIds: null, source: "cores" };
  }
  const { amounts, meat, exclusions, purchasing } = fam;
  const rot = household.rotation || {};
  const COOKED = BASE + "/data/cooked-log.jsonl";
  const cookedTimes = readCookHistory({ linesFile: BASE + "/data/order-lines-raw.jsonl", rotationFile: BASE + "/data/rotation.json", cookedFile: COOKED });
  const lastUsed = readRotation({ linesFile: BASE + "/data/order-lines-raw.jsonl", rotationFile: BASE + "/data/rotation.json", cookedFile: COOKED });
  const coversDays = options.covers;
  const pick = chooseDinners(fam.pool.pool, {
    days: options.days, coversDays, lastUsed, wanted,
    preferLeftovers: household.preferLeftovers,
    // `--covers` is the one knob for how long a dinner is eaten. It used to reach only the
    // pinned-cores fallback, so the README promised a steering wheel while the rotation drove
    // past it on `dinners.maxNightsPerDinner` whatever the person typed.
    maxNights: coversDays,
    reheatByFormat: household.reheatByFormat,
    nightsOverride: household.nightsOverride,
    maxPerProtein: Number(arg("max-per-protein", String(rot.maxPerProtein ?? 2))) || 2,
    minFish: Number(rot.minFishDishes ?? 1) || 0,
    noVegetarian: household.noVegetarian,
    excludeWords: [...(rot.excludeWords || []), ...(options.avoid || [])],
    maxNewPerPlan: rot.maxNewPerPlan,
    newMaxMinutes: rot.newMaxMinutes,
    // Two rules the profile carries and nothing used to read: a family that set them off
    // still got the interleaved queue and the variant ban. They are wired now.
    alternateNewAndKnown: rot.alternateNewAndKnown !== false,
    neverTwoVariantsOfTheSameDinner: rot.neverTwoVariantsOfTheSameDinner !== false,
    cookedTimes,
    taste: fam.learning.enabled ? fam.taste : { liked: [], refused: [] },
    exploration: fam.learning.exploration,
  });
  // A --dinners id that matches nothing in the pool used to decide nothing at all: the
  // rotation chose the menu and the person believed the dinner they asked for was in it.
  for (const w of (pick.unknownWanted || [])) {
    console.log(`  warn: --dinners "${w}" is not in the recipe pool - use a name from the menu or the recipe url`);
  }
  // What each cooking needs, and the lines that say what the rotation chose and why.
  const { intents, leftOut } = cookingIntents(pick, { amounts, meat, exclusions,
    purchasing: purchasing || {}, household, rules, lastUsed });
  return {
    usedPool: true, intents, leftOut, dinnerIds: pick.chosen.map((c) => c.url), source: "recipe pool",
    menu: { menu: pick.menu, uncoveredDays: pick.uncoveredDays, daysPerDinner: pick.daysPerDinner,
      relaxed: pick.relaxed || [], fishSwap: pick.fishSwap || null },
  };
}

/** Resolve every live intent against Namlig, pacing and caching each search. */
/**
 * What one intent asks the shop for. A rule's own words travel here: `avoid` is what the
 * family said never, `maxUnitPrice` is the ceiling they set for a cut, `minPackGrams` is the
 * smallest pack they buy of a loose good. Dropping them from this object would let the buy
 * land on exactly what the profile refused, while the plan line still printed the rule.
 */
export function searchIntentOf(it, options = {}) {
  const floor = Number(it.minPackGrams);
  const cap = Number(it.maxUnitPrice);
  const fat = Number(it.maxFatPct);
  return {
    query: it.query, need: it.need, mode: it.mode, sku: it.sku, alt: it.alt || [],
    avoidBrands: options.avoid,
    // --avoid is one list for the person typing it: a brand ("First Price") and a word
    // ("kylling") are both refused in the same place. A brand-only check silently kept
    // every chicken product when the word was a product, not a maker.
    avoidWords: [...new Set([...(it.avoidWords || []), ...(options.avoid || [])])].slice(0, 40),
    maxUnitPrice: Number.isFinite(cap) && cap > 0 ? cap : undefined,
    maxFatPct: Number.isFinite(fat) && fat > 0 ? fat : undefined,
    minPackGrams: Number.isFinite(floor) && floor > 0 ? floor : undefined,
    packWindow: it.packWindow && typeof it.packWindow === "object" ? it.packWindow : undefined,
    force: options.fresh,
    preferSale: it.preferSale, saleTolerancePct: it.saleTolerancePct, purchasing: options.purchasing,
  };
}

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
    const r = await resolveIntent(mcp, searchIntentOf(it, options), { cache });
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
  // A warm cache answers everything, so the run says out loud what the shop was and was
  // not asked for. A dead server never reaches this line: connect() above already failed
  // the run with "no MCP endpoint answered" - the scenario battery guards exactly that.
  if (live.length > 0 && fromCache === live.length) {
    console.log(`Note: every price came from the 24 h cache. The shop was reached (${(connectMs / 1000).toFixed(1)}s handshake) but asked nothing. --fresh asks now.`);
  }
  return { mcp, resolved, oldestCacheMs, timing };
}

/** One line a person reads to know where the time went, and what the gate did. */
function timingLine(t) {
  return `Timing: connect ${(t.connectMs / 1000).toFixed(1)}s, catalog ${(t.catalogMs / 1000).toFixed(1)}s for `
    + `${t.intents} intent(s) — ${t.fromCache} answered from cache, gate: ${t.gate}${t.serial ? ", serial" : ""}`
    + (t.stale ? `, ${t.stale} from a stale shelf` : "") + ".";
}

/** Console summary: the headline numbers, the warnings, and where to read more. */
/** The trim ledger on the terminal: every move the ceiling forced, in the order it made them. */
function printTrim(trimmed, capKr) {
  console.log(`  trim: ${trimmed.before.toFixed(2)} kr is ${(trimmed.before - capKr).toFixed(2)} kr over the ${capKr} kr ceiling`);
  for (const t of trimmed.actions) {
    if (t.action === "swap") {
      const size = t.fromPack && t.toPack ? `, ${t.fromPack} -> ${t.toPack}` : "";
      console.log(`    swap  ${t.name} ${t.from.total.toFixed(2)} kr -> ${t.to.name}, ${t.to.packs} x ${t.to.price.toFixed(2)} kr = ${t.to.total.toFixed(2)} kr (-${t.savedKr.toFixed(2)} kr${size})`);
      continue;
    }
    console.log(`    defer ${t.name} ${t.total.toFixed(2)} kr back on the shelf (${t.protectedBy})`);
  }
  console.log(`    = ${trimmed.after.toFixed(2)} kr` + (trimmed.shortfall > 0
    ? `: STILL ${trimmed.shortfall.toFixed(2)} kr OVER. What is left is a dinner's own ingredients, and a budget does not cut those.`
    : `, ${(capKr - trimmed.after).toFixed(2)} kr under the ceiling.`));
}

function printSummary(plan, diff, options, planTotal, jsonPath, mdPath) {
  if ((plan.substitutions || []).length) {
    console.log("");
    console.log(`SUBSTITUTIONS: ${plan.substitutions.length} item(s) the shelf could not answer as searched - closest proposed, nothing added:`);
    for (const s of plan.substitutions) console.log(`  ${s.wanted} -> ${s.name} ${s.price.toFixed(2)} kr${s.foundBy ? " (" + s.foundBy + ")" : ""}   accept: ${s.accept}`);
  }
  if (plan.uncoveredDays > 0) console.log(`WARNING: ${plan.uncoveredDays} evening(s) have no dinner - add cores with --dinners.`);
  console.log("");
  console.log(`PLAN (dry run): ${diff.adds.length} purchases, ${plan.saleItems} on sale, ${planTotal.toFixed(2)} kr added. Basket now ${plan.basketBefore.lines} lines / ${plan.basketBefore.totalProducts} kr.`);
  if (plan.overSoftCap) console.log(`WARNING: over the ${options.softCapKr} kr soft cap by ${(planTotal - options.softCapKr).toFixed(2)} kr.`);
  if (plan.capKr) {
    console.log(plan.trimShortfall > 0
      ? `CEILING ${plan.capKr} kr: CANNOT BE MET - ${plan.trimShortfall.toFixed(2)} kr still over after ${plan.trim.length} trim move(s).`
      : `Ceiling ${plan.capKr} kr: ${planTotal.toFixed(2)} kr, ${(plan.capKr - planTotal).toFixed(2)} kr spare${plan.trim.length ? `, after ${plan.trim.length} trim move(s)` : ""}.`);
  }
  if (plan.unresolved.length) console.log(`WARNING: ${plan.unresolved.length} intent(s) found no product — fix them before applying.`);
  // The way out of that WARNING, when there is one: the count and where to read it.
  if ((plan.nearMisses || []).length) {
    const n = plan.nearMisses.reduce((a, x) => a + x.candidates.length, 0);
    console.log(`NOTE: ${plan.nearMisses.length} of them have a close answer under your own bar - ${n} name(s) with prices and the flag to take one, under "Close but under your bar".`);
  }
  if ((plan.timing || {}).stale) console.log(`WARNING: ${plan.timing.stale} line(s) were decided on a shelf the shop could not answer - the price cache from the run before was used, check those lines.`);
  if ((plan.recipeGaps || []).length) console.log(`NOTE: ${plan.recipeGaps.length} recipe line(s) name something Namlig has no product for (an "add yourself" line, a link) — listed under Left out, they do not block applying.`);
  if (plan.skipped.length) console.log(`Stock cycle skipped ${plan.skipped.length} item(s).`);
  if ((plan.stalePins || []).length) console.log(`NOTE: ${plan.stalePins.length} pinned favourite sku(s) were not offered - cheapest used, see the plan file.`);
  if (plan.saleSwaps) console.log(`NOTE: ${plan.saleSwaps} line(s) bought a tilbud instead of the sku the family usually buys - the plan line says what it saved.`);
  if ((plan.bulkOffers || []).length) console.log(`Bulk offers (cheaper in quantity, not applied): ${plan.bulkOffers.length} - see the plan file.`);
  console.log("Wrote " + jsonPath + " and " + mdPath);
  console.log("Nothing was added to the basket. This was a dry run.");
}

function readOptions() {
  const a = (name, dflt) => arg(name, dflt);
  return {
    // Every bound here is the bound flagNotes quotes, through clampInt. Two places that
    // clamp the same flag differently is how a note ended up lying about the run.
    days: clampInt(a("days", "8"), 1, 14, 8),
    people: a("people", null),
    covers: process.argv.includes("--covers") ? clampInt(a("covers", "2"), 1, 14, 2) : null,
    breakfast: yesNo(a("breakfast", null), true),
    lunchbox: yesNo(a("lunchbox", null), true),
    snacks: yesNo(a("snacks", null), false),
    household: householdMode(a("household", "auto")),
    softCapKr: a("soft-cap", null),   // no default: the profile decides, see softCapOf
    // A ceiling is not a warning: budget.maxKrPerPlan makes the plan trim itself.
    maxKrPerPlan: a("max-kr", null),
    trim: a("trim", "on"),            // off plans it whole and lets the soft cap warn only
    avoid: (a("avoid", "") || "").split(",").map((s) => s.trim()).filter(Boolean),
    fresh: process.argv.includes("--fresh"),
    // --serial is the polite switch: one call at a time, wider spacing. Use it when the
    // shop answers slowly or pushes back. maxMinutes ends the run instead of hanging.
    serial: process.argv.includes("--serial"),
    // A full basket as if the shop basket were empty. It reads the shelf and never writes
    // the basket, so a family can see the whole plan before a shop, or audit a change.
    simulateEmpty: process.argv.includes("--simulate-empty"),
    maxMinutes: maxRunMinutes(a("max-minutes", process.env.NEMLIG_MAX_MINUTES || "15")),
  };
}

/** A run may not spend more than this much wall clock on shop calls. */
export function maxRunMinutes(value) {
  return clampInt(value, 1, 60, 15);
}

const USAGE = [
  "usage: node plan.mjs [options]  (dry run: nothing is written to the basket)",
  "  --days 8                1-14 evenings        --breakfast|--lunchbox|--snacks yes|no|on|off|ja|nej",
  "  --household auto|off    --people N           --soft-cap <kr>  (default: the profile's budget.softCapKr; --people sets dinner portions, block head-counts still follow the profile members)",
  "  --max-kr <kr>           --trim on|off        (default: the profile's budget.maxKrPerPlan; a ceiling is met by swapping the brand first, then putting lines back)",
  "  --family <name>         --covers 2           --dinners <name>    (a menu name)",
  "  --cores                 --max-per-protein N  --avoid \"brand,word\"",
  "  --extra \"Name:300g\"    --fresh (ignore the 24 h price cache)",
  "  --serial                one request at a time, wider spacing",
  "  --simulate-empty        plan the whole basket as if the live basket were empty; never writes it",
  "  --max-minutes 15        stop the run after this much wall clock",
  "  --debug                 print the stack on a failure",
  "  A value that cannot be used as given is reported with a warn line, naming the value used.",
  "plan file: data/plans/plan-latest.md and plan-latest.json",
].join("\n");

// The main below is exported so run.mjs can call it in-process after setting
// process.argv; it still self-runs only when plan.mjs is the command.
export async function main() {
  const tRun = Date.now();
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (arg("dinners", null) && !process.argv.includes("--cores")) {
    console.log("  warn  --dinners only picks from the pinned cores: add --cores, else the rotation pool decides the menu");
  }
  const options = readOptions();
  // Before a single shop call: a flag whose value was not used as given says so here, and
  // says what the run went to instead. Silence is how --trim off survived being false.
  for (const note of flagNotes(process.argv, KNOWN_FLAGS)) console.log("  warn  " + note);
  warnUnknownFlags(process.argv, KNOWN_FLAGS);
  // The rotation ranks dinners by how recently they were cooked and reads data/plans to do
  // it, so the menu is a move against the last plan written. Name that plan: the same
  // command run twice can buy a different basket, and that looks like a bug without a line.
  const menuAgainst = previousPlanOf(BASE + "/data/plans");
  console.log(menuLineOf(menuAgainst));
  const fam = loadFamily({ name: arg("family", null) });
  // How many people each pantry block is bought for, set once here: collectIntents sees the
  // derived household, not the profile object the headcounts are derived from.
  options.family = fam;
  const household = { ...fam.household };
  // --people overrides the dinner portions, not the profile's members: the breakfast and
  // lunch-box headcounts still come from who lives here. It used to be parsed and dropped.
  if (options.people !== null) {
    const people = clampInt(options.people, 1, 99, household.people);
    household.people = people;
    household.portionsPerNight = people;
    options.people = people;
    options.blockPeople = blockPeopleOf(fam.profile, household);
    console.log(`  note  --people ${people}: ${fam.household.people} portions per dinner and ${Number(fam.household.portionsPerNight || 0).toFixed(1)} portions a night in the profile are overridden for this plan`);
  } else {
    options.blockPeople = fam.blockPeople;
    options.people = household.people;
  }
  options.covers = options.covers === null ? household.maxNightsPerDinner : options.covers;
  const pantry = fam.pantry;
  const dinners = fam.dinners;
  console.log(`Profile: ${fam.name} (${fam.file}) - ${household.people} portions per dinner, soft cap ${household.softCapKr === null ? "none set - budget.softCapKr decides" : household.softCapKr + " " + household.currency}.`);
  const staples = readJson(BASE + "/data/staples.json");
  const famText = `${(Array.isArray(household.members) ? household.members : []).map((x) => `${x.count} ${x.role}${x.count > 1 ? "s" : ""}`).join(" + ") || household.people + " people"} = ${(household.portionsPerNight || 0).toFixed(1)} portions a night`;
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

  const { mcp, resolved, oldestCacheMs, timing } = await resolveAll(live, options);
  const tAfterResolve = Date.now();
  const merged = mergeItems(resolved, options.purchasing);
  // A ceiling the family set is a request to decide, not a request to be warned: the
  // brand goes first, the treats go first among the removals, and a dinner's own
  // ingredient is never touched. --trim off plans it whole and lets the warning stand.
  const capKr = capOf(options.trim, options.maxKrPerPlan, household.maxKrPerPlan);
  const trimmed = trimItems(merged.items, {
    capKr, minSwapKr: household.minSwapKr, purchasing: options.purchasing,
    swapNeverWords: household.swapNeverWords,
  });
  if (trimmed.actions.length) printTrim(trimmed, capKr);
  const items = trimmed.items;
  const { unresolved, recipeGaps, substitutions, substitutedAway, nearMisses } = merged;
  // How often a tilbud beat this family's own habit today. Worth one line per run:
  // it is the only place the planner overrides a favourite on price.
  const saleSwaps = resolved.filter((r) => r && r.ok && r.compare === "sale-vs-usual").length;
  let bJson = { Lines: [] };
  if (!options.simulateEmpty) {
    const basket = await mcp.call("get_basket", {}, { timeoutMs: CALL_TIMEOUT });
    if (basket.isError) throw new Error("get_basket failed: " + basket.text.slice(0, 200));
    bJson = basket.json || {};
  }
  const diff = basketDiff(items, bJson.Lines || []);
  const planTotal = Number(diff.adds.reduce((sum, i) => sum + i.total, 0).toFixed(2));
  const menu = poolMenu || menuOf(dinners.cores, wantedIds, options.days, options.covers);
  // One number for the whole run. Until now the flag carried a budget copied from one
  // family, so the profile's own budget.softCapKr was printed on the profile line and
  // never applied to the warning. Writing it back means the plan file, the report and the
  // warning all carry the number that was actually used.
  options.softCapKr = softCapOf(options.softCapKr, household.softCapKr);

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
    menuAgainst,
    uncoveredDays: menu.uncoveredDays,
    daysPerDinner: menu.daysPerDinner,
    menuRules: { relaxed: menu.relaxed || [], fishSwap: menu.fishSwap || null },
    householdNote: famText,
    learning,
    portionsPerNight: household.portionsPerNight || 0,
    members: fam.household.members || [],
    items,
    skipped,
    unresolved,
    recipeGaps,
    substitutions,
    substitutedAway,
    nearMisses,
    bulkOffers: bulkOffersOf(resolved),
    stalePins: stalePinsOf(resolved),
    saleItems: items.filter((i) => i.onSale).length,
    saleSwaps,
    priceCacheAgeHours: Number((oldestCacheMs / 3600000).toFixed(1)),
    timing,
    planTotal,
    overSoftCap: options.softCapKr !== null && planTotal > options.softCapKr,
    capKr,
    trim: trimmed.actions,
    trimBefore: trimmed.before,
    trimAfter: trimmed.after,
    trimShortfall: trimmed.shortfall,
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

/** The plan file this run's menu was ranked against: the newest plan on disk before this
 *  run, read through the same alias the rotation reads. Returns null when there is none,
 *  and { broken: true } when the file is there but cannot be read - a guess is not a fact.
 *  Called before writePlan, because after it there is no "before" left to name. */
export function previousPlanOf(plansDir) {
  const alias = plansDir + "/plan-latest.json";
  if (!existsSync(alias)) return null;
  let prev = null;
  try { prev = JSON.parse(readFileSync(alias, "utf8")); } catch { return { broken: true }; }
  if (!prev || typeof prev !== "object") return { broken: true };
  const menu = Array.isArray(prev.dinnerMenu) ? prev.dinnerMenu : [];
  const total = Number(prev.planTotal);
  return { at: prev.createdAt || prev.atIso || "unknown time", dinners: menu.length, total: Number.isFinite(total) ? total : 0 };
}

/** One line saying which plan the menu was a move against, or why that cannot be said. */
function menuLineOf(prev) {
  if (!prev) return "Menu: no earlier plan on disk, so every dish counted as never cooked.";
  if (prev.broken) return "Menu: the newest plan file could not be read, so the menu was ranked without it.";
  return `Menu: ranked against the plan of ${prev.at} - ${prev.dinners} dinners, ${prev.total.toFixed(2)} kr. `
    + "The rotation moves against that plan, so the same command twice can buy a different basket.";
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
