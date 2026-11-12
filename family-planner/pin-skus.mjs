#!/usr/bin/env node
// pin-skus.mjs — fill pantry.json "sku" fields from the mined order history.
//
// Why: mode=history must not depend on a fuzzy search hit. When we already know the
// exact sku this family rebuys, plan.mjs asks for that sku and only falls back to
// the cheapest option if Namlig no longer returns it.
//
// Usage:  node pin-skus.mjs [--write]
// Prints the chosen sku per pantry item. --write updates profiles/pantry.json.
// Matching is token-based and deliberate: the query's head noun must appear as a
// whole word in the product name, then the candidate with the most orders wins.
import { readFileSync, writeFileSync } from "node:fs";
import { score } from "./match.mjs";

import { PROFILES, DATA } from "./paths.mjs";
const PANTRY = PROFILES + "/pantry.json";
const STAPLES = DATA + "/staples.json";
/** Best rebuy for one query, or null. Ties break on more orders, then more recent. */
export function bestSku(query, staples, { minScore = 0.7 } = {}) {
  let best = null;
  for (const s of staples) {
    const sc = score(query, s.name);
    if (sc < minScore) continue;
    const cand = { score: sc, orders: s.orders, lastDate: s.lastDate || "", sku: s.sku, name: s.name, price: s.medianUnitPrice };
    if (!best
      || cand.orders > best.orders
      || (cand.orders === best.orders && cand.score > best.score)
      || (cand.orders === best.orders && cand.score === best.score && cand.lastDate > best.lastDate)) best = cand;
  }
  return best;
}

function main() {
  const write = process.argv.includes("--write");
  const pantry = JSON.parse(readFileSync(PANTRY, "utf8"));
  const staples = JSON.parse(readFileSync(STAPLES, "utf8"));
  let changed = 0;
  let missing = 0;
  for (const [block, items] of Object.entries(pantry.blocks)) {
    for (const it of items) {
      const best = bestSku(it.query, staples);
      if (!best || !best.sku) {
        missing++;
        console.log(`  MISS  ${block}:${it.id}  query="${it.query}" — no rebuy in history, resolver will use cheapest`);
        continue;
      }
      const was = it.sku;
      it.sku = String(best.sku);
      it.skuName = best.name;
      it.skuOrders = best.orders;
      if (was !== it.sku) changed++;
      console.log(`  pin   ${block}:${it.id}  ${it.sku}  "${best.name}"  (${best.orders} orders, score ${best.score.toFixed(2)})`);
    }
  }
  console.log(`\n${changed} sku(s) changed, ${missing} without a history match.`);
  if (write) {
    writeFileSync(PANTRY, JSON.stringify(pantry, null, 2) + "\n");
    console.log("Wrote " + PANTRY);
  } else {
    console.log("Dry run — add --write to save.");
  }
}

if (import.meta.url === "file://" + process.argv[1]) main();
