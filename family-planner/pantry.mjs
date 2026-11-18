#!/usr/bin/env node
// pantry.mjs - compile the rebuy list from the mined order history.
//
// The pantry is the set of things a household buys again and again without a recipe
// asking for them: milk, bread, lunch-box topping, fruit, cleaning. This file reads
// data/staples.json (one row per product, with purchase dates), classifies each row
// into a block, and writes the block entries plan.mjs already understands.
//
// A dry run prints what would change. --write updates profiles/pantry.json. Existing
// entries keep their hand-written note, unit and everyNDays unless the entry was added
// by this tool (scheduleSource "mined"). A removed entry stays removed when its name
// is in the pantry's "rejected" list.
//
// Usage: node pantry.mjs [--write] [--prune] [--min-orders N] [--min-pct N] [--data DIR]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DATA, PROFILES } from "./paths.mjs";

const BLOCKS = ["breakfast", "kidLunchbox", "snacks", "household"];

/** Words that place a product in a block. A family can override any list under
 *  pantry.mining.blocks in profiles/pantry.json, so a household with other habits
 *  is not forced through this family's Danish shelf. */
const BLOCK_WORDS = {
  household: ["toiletpapir", "koekkenrulle", "kokkenrulle", "serviet", "bleer", "opvask",
    "affald", "tandpasta", "shampoo", "sae", "sabe", "vaskepulver", "rengoring", "plaster", "batteri"],
  breakfast: ["maelk", "milk", "skyr", "yoghurt", "havregryn", "musli", "muesli", "cheerios",
    "aeg", "egg", "smoer", "smor", "kaffe", "coffee", "juice"],
  kidLunchbox: ["rugbroed", "rugbrod", "broed", "brod", "spegepoelse", "spegepolse", "leverpostej",
    "ost", "cheese", "havarti", "agurk", "tomat", "peberfrugt", "gulerod", "aeble", "aebler",
    "paere", "makrelsalat", "mayonnaise", "hummus", "paalaeg", "palæg"],
  snacks: ["banan", "chips", "mueslibar", "muslibar", "jordbaer", "jordbær", "noedder", "nodder",
    "kiks", "frugtstang", "is"],
};

/** Names that are cooking ingredients, not a rebuy staple. A recipe buys these; the
 *  pantry must not add a second pack on top of the recipe line. */
const COOKING_WORDS = ["floede", "fløde", "creme fraiche", "tomatpure", "tomatpuré", "passata",
  "mascarpone", "mozzarella", "grana", "parmesan", "tortellini", "pizzadej", "ris", "pasta",
  "nudler", "sauce", "bouillon", "mel", "sukker", "olie", "eddike", "ketchup", "sennep",
  "karry", "pesto", "spaghetti", "lasagne"];

/** Lower case and fold the Danish letters, so one keyword matches every spelling. */
export function fold(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[øØ]/g, "o").replace(/[æÆ]/g, "ae").replace(/[åÅ]/g, "a")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** True when the folded text names the word. A short word must stand alone, so
 *  "is" does not match "fisk" and "te" does not match "tomat". */
function mentions(text, word) {
  const w = fold(word);
  if (!w) return false;
  if (w.includes(" ") || w.length > 3) return text.includes(w);
  return text.split(" ").includes(w);
}

/** The block a product belongs to, or null when it is not a staple. First match wins. */
export function blockOf(name, rules = BLOCK_WORDS) {
  const text = fold(name);
  for (const block of BLOCKS) {
    const words = Array.isArray(rules[block]) ? rules[block] : [];
    if (words.some((w) => mentions(text, w))) return block;
  }
  return null;
}

/** A restock gate in days, or null when the item is bought on every order.
 *  The history gap is the measured usage; buy at 80 % of it, never below a week. */
export function scheduleFor(medianGapDays, cycleDays) {
  const gap = Number(medianGapDays);
  const cycle = Number(cycleDays) > 0 ? Number(cycleDays) : 9;
  if (!Number.isFinite(gap) || gap < cycle * 1.5) return null;
  return Math.min(180, Math.max(7, Math.round(gap * 0.8)));
}

/** A stable id from the product name; the sku breaks a tie between two variants. */
export function slugId(name, sku) {
  const base = fold(name).replace(/ /g, "-").slice(0, 40).replace(/-+$/, "");
  const tail = String(sku || "").replace(/[^0-9a-z]/gi, "").slice(-6);
  return tail ? `${base || "item"}-${tail}` : (base || "item");
}

/** The head noun: "Yoghurt m. æble" and "Yoghurt m. jordbær" are one shelf habit,
 *  not two lines in the same order. */
function headOf(name) {
  return fold(name).split(" ")[0] || "";
}

function cleanQuery(name) {
  return String(name || "").trim().replace(/\.+$/, "").replace(/\s+/g, " ");
}

function clampQty(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(4, n);
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
}

/**
 * Merge the mined staples into the pantry.
 * Existing entries are matched by sku first, then by folded query. Their note, unit
 * and manual schedule survive. New entries are added only for a pinned sku, a known
 * block, and a product that is not a cooking ingredient.
 */
export function buildPantry(staples, existing = {}, opts = {}) {
  const mining = existing.mining && typeof existing.mining === "object" ? existing.mining : {};
  const cycleDays = Number(existing.cycleDays || opts.cycleDays || 9);
  const minOrders = Number(opts.minOrders ?? mining.minOrders ?? 6);
  const minPct = Number(opts.minPct ?? mining.minPct ?? 40);
  const maxAgeDays = Number(opts.maxAgeDays ?? mining.maxAgeDays ?? 60);
  const now = Number(opts.now ?? mining.now) || Date.now();
  const maxPerBlock = Number(opts.maxPerBlock ?? mining.maxPerBlock ?? 12);
  const custom = { ...(mining.blocks || {}), ...(opts.rules || {}) };
  const rules = {};
  for (const block of BLOCKS) rules[block] = Array.isArray(custom[block]) ? custom[block] : BLOCK_WORDS[block];
  const rejected = new Set((Array.isArray(existing.rejected) ? existing.rejected : []).map(fold));
  const pantry = { ...existing, blocks: {} };
  for (const block of BLOCKS) {
    pantry.blocks[block] = Array.isArray(existing.blocks?.[block])
      ? existing.blocks[block].map((e) => ({ ...e })) : [];
  }
  const bySku = new Map();
  const byName = new Map();
  const usedIds = new Set();
  for (const block of BLOCKS) {
    for (const e of pantry.blocks[block]) {
      if (e.sku) bySku.set(String(e.sku), e);
      byName.set(fold(e.query || e.name), e);
      if (e.id) usedIds.add(String(e.id));
    }
  }
  const added = [];
  const updated = [];
  const skipped = [];
  const pruned = [];
  const keepAuto = new Set();
  const seenUpdated = new Set();
  const heads = new Map(BLOCKS.map((b) => [b, new Set()]));
  for (const block of BLOCKS) for (const e of pantry.blocks[block]) heads.get(block).add(headOf(e.query || e.name));
  const rows = Array.isArray(staples) ? [...staples] : [];
  rows.sort((a, b) => Number(b.orders) - Number(a.orders));
  for (const s of rows) {
    if (!s || !s.sku) continue;
    // The merge of a line that already exists runs first: its evidence (last date,
    // orders passed, stopped-buying flag) must refresh even when the add threshold
    // is too high for this product. The threshold gates NEW lines only. The flag
    // branch matches on the pinned sku alone: same-name variants (three toilet
    // papers) must not stamp each other's dates. Stopped means two full cycles
    // gone AND six orders walked past it - one undelivered basket is not a stop.
    const hitSku = bySku.get(String(s.sku));
    const since0 = Number(s.ordersSince || 0);
    if (hitSku && (Number(s.orders) < minOrders || Number(s.ordersPct) < minPct)) {
      const due0 = !hitSku.everyNDays || (s.lastDate && Number.isFinite(now - Date.parse(s.lastDate))
        && Math.round((now - Date.parse(s.lastDate)) / 86400000) >= 2 * Number(hitSku.everyNDays));
      hitSku.lastDate = s.lastDate;
      hitSku.minedOrders = Number(s.orders);
      hitSku.skuOrders = Number(s.orders);
      if (due0 && since0 >= 6) hitSku.stoppedBuying = true;
      else delete hitSku.stoppedBuying;
      continue;
    }
    if (Number(s.orders) < minOrders || Number(s.ordersPct) < minPct) continue;
    const block = blockOf(s.name, rules);
    if (!block || rejected.has(fold(s.name))) continue;
    const hit = bySku.get(String(s.sku)) || byName.get(fold(s.name));
    if (hit) {
      if (hit.scheduleSource === "mined" && hit.qtySource === "mined" && hit.sku) keepAuto.add(String(hit.sku));
      const before = `${hit.everyNDays}|${hit.minedOrders}|${hit.medianGapDays}`;
      hit.minedOrders = Number(s.orders);
      hit.skuOrders = Number(s.orders);
      hit.medianUnitPrice = Number(s.medianUnitPrice);
      hit.lastDate = s.lastDate;
      hit.medianGapDays = s.medianGapDays ?? null;
      // Evidence they stopped buying: two full cycles gone and six orders passed
      // while past due. The flag lives on mined lines; delete it by hand to keep a
      // line anyway, and a new purchase clears it on the next run.
      const sinceOrders = Number(s.ordersSince || 0);
      const pastDue = !hit.everyNDays || (s.lastDate && Number.isFinite(now - Date.parse(s.lastDate))
        && Math.round((now - Date.parse(s.lastDate)) / 86400000) >= 2 * Number(hit.everyNDays));
      if (pastDue && sinceOrders >= 6) hit.stoppedBuying = true;
      else delete hit.stoppedBuying;
      if (hit.scheduleSource === "mined") {
        const gate = scheduleFor(s.medianGapDays, cycleDays);
        if (gate) hit.everyNDays = gate;
        else delete hit.everyNDays;
      }
      if (`${hit.everyNDays}|${hit.minedOrders}|${hit.medianGapDays}` !== before && !seenUpdated.has(String(hit.id))) {
        seenUpdated.add(String(hit.id));
        updated.push({ block, id: hit.id, name: hit.query });
      }
      continue;
    }
    if (COOKING_WORDS.some((w) => mentions(fold(s.name), w))) continue;
    if (s.lastDate) {
      const age = Math.round((now - Date.parse(s.lastDate)) / 86400000);
      if (Number.isFinite(age) && age > maxAgeDays) {
        skipped.push({ block, name: s.name, why: `last bought ${age} d ago` });
        continue;
      }
    }
    if (heads.get(block).has(headOf(s.name))) {
      skipped.push({ block, name: s.name, why: "variant of an existing line" });
      continue;
    }
    if (pantry.blocks[block].length >= maxPerBlock) continue;
    let id = slugId(s.name, s.sku);
    for (let n = 2; usedIds.has(id) && n < 10; n++) id = `${slugId(s.name, s.sku)}-${n}`;
    const entry = {
      id,
      query: cleanQuery(s.name),
      mode: "history",
      qtyPerCycle: clampQty(s.medianQty),
      minedOrders: Number(s.orders),
      medianUnitPrice: Number(s.medianUnitPrice),
      lastDate: s.lastDate,
      medianGapDays: s.medianGapDays ?? null,
      sku: String(s.sku),
      skuName: s.name,
      skuOrders: Number(s.orders),
      qtySource: "mined",
      scheduleSource: "mined",
      note: `auto: bought ${s.orders} times, median ${clampQty(s.medianQty)} pack(s)`,
    };
    const gate = scheduleFor(s.medianGapDays, cycleDays);
    if (gate) entry.everyNDays = gate;
    pantry.blocks[block].push(entry);
    keepAuto.add(String(entry.sku));
    heads.get(block).add(headOf(entry.query));
    usedIds.add(id);
    added.push({ block, id, name: entry.query });
  }
  if (opts.prune) {
    for (const block of BLOCKS) {
      const before = pantry.blocks[block].length;
      pantry.blocks[block] = pantry.blocks[block].filter((e) => {
        if (e.scheduleSource !== "mined" || e.qtySource !== "mined") return true;
        if (keepAuto.has(String(e.sku))) return true;
        pruned.push({ block, id: e.id, name: e.query });
        return false;
      });
      if (pantry.blocks[block].length !== before) heads.get(block).clear();
    }
  }
  return { pantry, added, updated, skipped, pruned };
}

function arg(name, dflt) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1] : dflt;
}

function main() {
  const dataDir = arg("data", DATA);
  const write = process.argv.includes("--write");
  const existing = readJson(`${PROFILES}/pantry.json`, {});
  const staples = readJson(`${dataDir}/staples.json`, null);
  if (!Array.isArray(staples)) throw new Error(`${dataDir}/staples.json is missing or not an array`);
  const minOrders = arg("min-orders", null);
  const minPct = arg("min-pct", null);
  const { pantry, added, updated, skipped, pruned } = buildPantry(staples, existing, {
    minOrders: minOrders === null ? undefined : Number(minOrders),
    minPct: minPct === null ? undefined : Number(minPct),
    prune: process.argv.includes("--prune"),
  });
  console.log(`pantry: ${added.length} added, ${updated.length} updated, ${pruned.length} pruned, ${skipped.length} skipped, ${staples.length} products mined`);
  for (const a of added) console.log(`  + ${a.block}/${a.id}  ${a.name}`);
  for (const u of updated) console.log(`  ~ ${u.block}/${u.id}  ${u.name}`);
  for (const p of pruned) console.log(`  - ${p.block}/${p.id}  ${p.name}`);
  for (const s of skipped.slice(0, 8)) console.log(`  . ${s.block}  ${s.name} - ${s.why}`);
  if (!write) {
    console.log(`Dry run: ${PROFILES}/pantry.json was not changed. Add --write to apply.`);
    return;
  }
  writeFileSync(`${PROFILES}/pantry.json`, JSON.stringify(pantry, null, 2) + "\n");
  console.log(`Wrote ${PROFILES}/pantry.json.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  }
}
