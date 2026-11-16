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

const TARGETS = ["never", "pantry", "herbs", "rotation"];

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
  else profile.exclusions.freshHerbs = words;
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node exclusions.mjs [--target never|pantry|herbs|rotation] [--add \"a,b\"] [--remove \"c,d\"] [--write] [--family <name>]\n  --list  print the effective lists\n  No --write means a dry run.");
    return;
  }
  const target = arg("target", "never");
  if (!TARGETS.includes(target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  const family = arg("family", null);
  const fam = loadFamily({ name: family });
  const file = findProfileFile(undefined, family);
  const profile = JSON.parse(readFileSync(file, "utf8"));
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
