#!/usr/bin/env node
// exclusions.mjs — edit the family's manual exclusion lists. This is the only supported
// way to add or remove a word; profiles/exclusions.json is generated evidence and is
// never hand-edited. A dry run is the default; --write changes the family profile.
//
//   node exclusions.mjs --list
//   node exclusions.mjs --remove "prosciutto,ymer" --target never --write
//   node exclusions.mjs --add "persille" --target herbs --write
import { readFileSync, writeFileSync } from "node:fs";
import { findProfileFile, loadFamily } from "./family.mjs";
import { DATA } from "./paths.mjs";

const TARGETS = ["never", "pantry", "herbs", "rotation"];

/** Fold a name the same way the catalog does, without the percent sign. */
function fold(s) {
  return String(s || "").toLowerCase()
    .replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

const STOP = new Set(["og", "med", "eller", "til", "af", "i", "pa", "den", "det", "en", "et", "m", "ca"]);

/** True when the product is the thing the word names, not a product that merely
 *  carries the word. "Andebryst" is duck; "Sandwich" is not. "Salt" is salt;
 *  "Chips m. salt" is not. mode "herb" accepts a fresh root by its head noun, so
 *  "frisk ingefær" matches "Ingefær øko." */
export function boughtWord(name, word, mode = "head") {
  const tokens = fold(name).split(" ").filter(Boolean);
  const parts = fold(word).split(" ").filter((w) => w.length >= 3 && !STOP.has(w));
  if (tokens.length === 0 || parts.length === 0) return false;
  if (mode === "herb") {
    const head = parts[parts.length - 1];
    return tokens[0] === head || tokens[0].startsWith(head);
  }
  if (mode === "exact") return parts.length === 1 && tokens[0] === parts[0];
  if (parts.length === 1) {
    return tokens[0] === parts[0] || tokens[0].startsWith(parts[0]);
  }
  return parts.every((p) => tokens.includes(p));
}

/** Drop a word from a list when recent orders bought a matching product. A hard ban
 *  or a herb is dropped after one purchase; a pantry assumption needs two orders,
 *  because one purchase does not mean the cupboard is empty. */
export function learnExclusions(lists, orders, opts = {}) {
  const limit = Number(opts.limit) || 5;
  const recent = (Array.isArray(orders) ? orders : []).slice(0, limit);
  const hits = (word, exact) => recent.filter((o) => (o.lines || []).some((l) => boughtWord(l.name, word, exact))).length;
  const keep = (words, need, exact) => {
    const removed = [];
    const left = [];
    for (const w of words) {
      if (hits(w, exact) >= need) removed.push(w);
      else left.push(w);
    }
    return { left, removed };
  };
  const never = keep(lists.never || [], 1, "head");
  const herbs = keep(lists.herbs || [], 1, "herb");
  const pantry = keep(lists.pantry || [], 2, "exact");
  return {
    never: never.left, herbs: herbs.left, pantry: pantry.left,
    removed: { never: never.removed, herbs: herbs.removed, pantry: pantry.removed },
    ordersSeen: recent.length,
  };
}

export function changeWords(list, { add = [], remove = [] } = {}) {
  const norm = (w) => String(w || "").toLowerCase().trim();
  const gone = new Set(remove.map(norm).filter(Boolean));
  const out = (Array.isArray(list) ? list : []).map(norm).filter(Boolean).filter((w) => !gone.has(w));
  for (const w of add.map(norm).filter(Boolean)) if (!out.includes(w)) out.push(w);
  return out;
}

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return dflt;
  const value = process.argv[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

function wordsOf(value) {
  return String(value || "").split(",").map((w) => w.trim()).filter(Boolean);
}

function effective(fam, target) {
  if (target === "never") return fam.exclusions.neverBought.words;
  if (target === "pantry") return fam.exclusions.pantryWords.words;
  if (target === "herbs") return fam.exclusions.freshHerbs.words;
  return fam.household.rotation.excludeWords || [];
}

function setTarget(profile, target, words) {
  if (target === "rotation") {
    profile.rotation = profile.rotation || {};
    profile.rotation.excludeWords = words;
    return;
  }
  profile.exclusions = profile.exclusions || {};
  if (target === "never") profile.exclusions.neverBought = words;
  else if (target === "pantry") profile.exclusions.pantryWords = words;
  else profile.exclusions.herbWords = words;
}

/** Reconcile the three word lists with the last orders. Only an explicit list in the
 *  family profile is touched; the generated evidence is never rewritten. */
function learnFromHistory(profile, file) {
  const explicit = {
    never: Array.isArray(profile.exclusions?.neverBought),
    herbs: Array.isArray(profile.exclusions?.herbWords),
    pantry: Array.isArray(profile.exclusions?.pantryWords),
  };
  const historyFile = `${DATA}/history-raw.json`;
  let orders = [];
  try {
    orders = JSON.parse(readFileSync(historyFile, "utf8"));
  } catch (e) {
    throw new Error(`${historyFile} is missing or not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(orders)) throw new Error(`${historyFile} must hold an array of orders`);
  const lists = {
    never: explicit.never ? fam.exclusions.neverBought.words : [],
    herbs: explicit.herbs ? fam.exclusions.freshHerbs.words : [],
    pantry: explicit.pantry ? fam.exclusions.pantryWords.words : [],
  };
  const result = learnExclusions(lists, orders, { limit: Number(arg("learn-limit", 5)) });
  console.log(`learned from the last ${result.ordersSeen} order(s)`);
  for (const [k, removed] of Object.entries(result.removed)) {
    if (removed.length) console.log(`  ${k}: remove ${removed.join(", ")}`);
    else console.log(`  ${k}: nothing to remove`);
  }
  if (!process.argv.includes("--write")) {
    console.log(`Dry run: ${file} was not changed. Add --write to apply.`);
    return;
  }
  if (explicit.never) profile.exclusions.neverBought = result.never;
  if (explicit.herbs) profile.exclusions.herbWords = result.herbs;
  if (explicit.pantry) profile.exclusions.pantryWords = result.pantry;
  writeFileSync(file, JSON.stringify(profile, null, 1) + "\n");
  console.log(`Wrote ${file}.`);
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node exclusions.mjs [--target never|pantry|herbs|rotation] [--add \"a,b\"] [--remove \"c,d\"] [--write] [--family <name>]\n  --list  print the effective lists\n  --learn  drop words the last orders bought (--learn-limit N)\n  No --write means a dry run.");
    return;
  }
  const target = arg("target", "never");
  const family = arg("family", null);
  const fam = loadFamily({ name: family });
  const file = findProfileFile(undefined, family);
  const profile = JSON.parse(readFileSync(file, "utf8"));
  if (process.argv.includes("--learn")) {
    learnFromHistory(profile, file);
    return;
  }
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  const before = effective(fam, target);
  if (process.argv.includes("--list")) {
    console.log(`never (${fam.exclusions.neverBought.words.length}): ${fam.exclusions.neverBought.words.join(", ")}`);
    console.log(`pantry (${fam.exclusions.pantryWords.words.length}): ${fam.exclusions.pantryWords.words.join(", ")}`);
    console.log(`herbs (${fam.exclusions.freshHerbs.words.length}): ${fam.exclusions.freshHerbs.words.join(", ")}`);
    console.log(`rotation (${(fam.household.rotation.excludeWords || []).length}): ${(fam.household.rotation.excludeWords || []).join(", ")}`);
    return;
  }
  const add = wordsOf(arg("add", ""));
  const remove = wordsOf(arg("remove", ""));
  if (add.length === 0 && remove.length === 0) throw new Error("give --add or --remove (or --list)");
  const after = changeWords(before, { add, remove });
  const gone = before.filter((w) => !after.includes(w));
  const added = after.filter((w) => !before.includes(w));
  console.log(`target ${target}: ${before.length} -> ${after.length} word(s)`);
  if (gone.length) console.log(`  removed: ${gone.join(", ")}`);
  if (added.length) console.log(`  added:   ${added.join(", ")}`);
  if (!process.argv.includes("--write")) {
    console.log(`Dry run: ${file} was not changed. Add --write to apply.`);
    return;
  }
  setTarget(profile, target, after);
  writeFileSync(file, JSON.stringify(profile, null, 1) + "\n");
  console.log(`Wrote ${file}. The generated profiles/exclusions.json was not touched.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  }
}
