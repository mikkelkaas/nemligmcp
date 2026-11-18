#!/usr/bin/env node
// golden-build.mjs — builds one isolated, offline fixture home per golden case.
//
// What it writes (all under test/golden/home/, which .gitignore keeps out of the repo):
//   home/<case>/profiles/*      the committed fixtures under test/golden/fixtures/,
//                               with the case's JSON merge patch applied to family-demo.json
//   home/<case>/data/staples.json  the fixture staples, with lastDate fixed
//   home/<case>/data/golden-shelf.json  the synthetic shelf the stub shop serves
//   home/<case>/data/product-cache.json  only when the case seeds a stale cache
//   home/<case>/.env            an invented env: 40-char test secret, dummy user/pass
// The only input is test/golden/fixtures/: one invented household (family-demo.json),
// invented staples, pantry, recipe pool, dinners, exclusions and meat rules. There is no
// live-copy path and no flag for one: profiles/ and data/ are never read, so a fresh clone
// runs the whole suite and no household's real data can reach a fixture.
// Nothing here reads /opt/docker/.env or the real shop. Nothing here is a secret.
//
// The shelf is invented: 40 products with made-up Danish names, brands, skus in the
// reserved 9000001-9000040 block, prices, pack descriptions and availability flags.
// No product, name or price is taken from the family's order history or from
// data/product-cache.json.
//
// Two fixture rules make the fixture self-consistent, and both are deterministic:
//   1. data/staples.json lastDate is set to 2020-01-01, so a stock cycle is always due.
//      Without this the plan changes on its own as the calendar moves.
//   2. Every pantry line is re-pointed at a shelf product: its query, name and pinned sku
//      are set to the shelf product that matches it best (by shared words), so the fixture
//      profile speaks the shelf's invented language instead of the real product names.
//      A line whose id is listed in the case's "pinMissing" is pinned to an sku that is
//      deliberately NOT on the shelf, which is how a stale favourite sku is proved.
//
// Case file: test/golden/cases/<name>.json = { comment, argv, profilePatch, shelf }.
//   profilePatch : { "<file>.json": <JSON merge patch> }  (RFC 7386: null deletes, arrays replace)
//   shelf        : { remove:[sku], set:[{sku,...fields}], add:[product], pinMissing:[id], basket:{...} }
//                  the built shelf is checked to hold exactly 40 products.
//
// Usage:
//   node tools/golden-build.mjs                 build every case
//   node tools/golden-build.mjs normal-8d ...   build the named cases
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { norm } from "../match.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME_ROOT = join(ROOT, "test", "golden", "home");
export const CASE_DIR = join(ROOT, "test", "golden", "cases");
// The committed fixture inputs. Nothing is ever copied from profiles/ or data/: a fresh
// clone runs the whole golden suite with no family data and no live files.
const FIXTURES = join(ROOT, "test", "golden", "fixtures");
// Which fixture file lands where in a case home. staples.json is data, the rest are profiles.
const FIXTURE_STAPLES = "staples.json";
const SHELF_NAME = "data/golden-shelf.json";
const SHELF_SIZE = 40;
const MAX_PATCH_DEPTH = 8;
// Invented, fixed, and only ever written inside the ignored fixture tree.
const TEST_SECRET = "golden-test-secret-0123456789abcdef0123456789abcd";
const TEST_USER = "golden.test@example.invalid";
const TEST_PASS = "invented-not-a-real-password";

/** Every case name available under test/golden/cases, sorted. */
export function caseNames() {
  if (!existsSync(CASE_DIR)) throw new Error("no case dir: " + CASE_DIR);
  return readdirSync(CASE_DIR).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).map((f) => f.replace(/\.json$/, "")).sort();
}

/** Read and parse one JSON file, with the path in the message. */
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
}

/** Write JSON, creating the folder. Returns the path for the caller to report. */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 1));
  return path;
}

/** One JSON merge patch (RFC 7386): objects merge, null deletes, arrays replace. */
function mergePatch(target, patch, depth = 0) {
  if (depth > MAX_PATCH_DEPTH) throw new Error("merge patch nests deeper than " + MAX_PATCH_DEPTH);
  if (patch === null || Array.isArray(patch) || typeof patch !== "object") return patch;
  const base = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(base[key], value, depth + 1);
  }
  return out;
}

/**
 * The invented shelf: 42 rows, head noun first so match.mjs finds them, names and brands
 * from a made-up brand world that no real shop uses. Two of them exist only to give a
 * second product under one name (the pear and the mayonnaise), so an unavailable product
 * and a missed favourite sku can be proved against a rival. krPer is the price per kg, per l or per stk; the pack price and
 * UnitPriceCalc are computed from it, so a typo in a price cannot slip in.
 * Fields: name, brand, group, sub, qty, unit, axis (kr/kg|kr/l|kr/stk), per, sale, campaign.
 */
const SHELF_TABLE = [
  { "id": 9000001, "name": "Mælk Standardmælk 1,8%", "brand": "Nordvang", "group": "Mejeri", "sub": "Mælk", "qty": 1.5, "unit": "l", "axis": "kr/l", "per": 10.5 },
  { "id": 9000002, "name": "Mælk Højmælk 25%", "brand": "Nordvang", "group": "Mejeri", "sub": "Mælk", "qty": 0.6, "unit": "l", "axis": "kr/l", "per": 17.5, "sale": true },
  { "id": 9000003, "name": "Æg Spiseæg str. L", "brand": "Hjemlig", "group": "Mejeri", "sub": "Æg", "qty": 10, "unit": "stk", "axis": "kr/stk", "per": 3.2 },
  { "id": 9000004, "name": "Smør Havesmør", "brand": "Husbond", "group": "Mejeri", "sub": "Smør", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 78 },
  { "id": 9000005, "name": "Yoghurt Bærfrugt yoghurt 3,1%", "brand": "Kystbygden", "group": "Mejeri", "sub": "Yoghurt", "qty": 430, "unit": "ml", "axis": "kr/l", "per": 22 },
  { "id": 9000006, "name": "Havregryn Dagnat havregryn", "brand": "Mølhav", "group": "Kolonial", "sub": "Müsli", "qty": 1, "unit": "kg", "axis": "kr/kg", "per": 24 },
  { "id": 9000007, "name": "Ost Havelhavarti skåret", "brand": "Husbond", "group": "Mejeri", "sub": "Ost", "qty": 390, "unit": "g", "axis": "kr/kg", "per": 95 },
  { "id": 9000008, "name": "Rugbrød Kornvang rugbrød", "brand": "Kornvang", "group": "Brød", "sub": "Rugbrød", "qty": 600, "unit": "g", "axis": "kr/kg", "per": 32 },
  { "id": 9000009, "name": "Spegepølse Brune spegepølser", "brand": "Slagter Vænge", "group": "Kød", "sub": "Pålæg", "qty": 250, "unit": "g", "axis": "kr/kg", "per": 132 },
  { "id": 9000010, "name": "Gulerod Små gulerødder", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 300, "unit": "g", "axis": "kr/kg", "per": 26 },
  { "id": 9000011, "name": "Peberfrugt Mini peberfrugter", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 400, "unit": "g", "axis": "kr/kg", "per": 34 },
  { "id": 9000012, "name": "Agurk Lang agurk", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 1, "unit": "stk", "axis": "kr/stk", "per": 12 },
  { "id": 9000013, "name": "Tomat Tomater på vine", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 300, "unit": "g", "axis": "kr/kg", "per": 45, "sale": true },
  { "id": 9000014, "name": "Æble Røde æbler", "brand": "Sønderhave", "group": "Frugt", "sub": "Frugt", "qty": 1, "unit": "kg", "axis": "kr/kg", "per": 24 },
  { "id": 9000015, "name": "Pære Grønne pærer", "brand": "Sønderhave", "group": "Frugt", "sub": "Frugt", "qty": 1, "unit": "kg", "axis": "kr/kg", "per": 26 },
  { "id": 9000016, "name": "Makrel Makrelbiter i sauce", "brand": "Havbond", "group": "Fisk", "sub": "Konserver", "qty": 125, "unit": "g", "axis": "kr/kg", "per": 88 },
  { "id": 9000017, "name": "Mayonnaise Husets mayonnaise", "brand": "Brugsnær", "group": "Kolonial", "sub": "Dressing", "qty": 380, "unit": "g", "axis": "kr/kg", "per": 42 },
  { "id": 9000018, "name": "Pølse Kumle pølser", "brand": "Slagter Vænge", "group": "Kød", "sub": "Pølser", "qty": 400, "unit": "g", "axis": "kr/kg", "per": 92 },
  { "id": 9000019, "name": "Kartofler Brune kartofler", "brand": "Markhave", "group": "Grønt", "sub": "Kartofler", "qty": 1, "unit": "kg", "axis": "kr/kg", "per": 16, "campaign": { "MinQuantity": 5, "TotalPrice": 60, "Type": "BulkKort" } },
  { "id": 9000020, "name": "Løg Skal løg", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 18 },
  { "id": 9000021, "name": "Hvidløg Hoveder hvidløg", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 100, "unit": "g", "axis": "kr/kg", "per": 120 },
  { "id": 9000022, "name": "Citron Tykskallede citroner", "brand": "Sønderhave", "group": "Frugt", "sub": "Frugt", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 34 },
  { "id": 9000023, "name": "Spinat Friskbladet spinat", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 200, "unit": "g", "axis": "kr/kg", "per": 95 },
  { "id": 9000024, "name": "Broccoli Grove broccoli", "brand": "Markhave", "group": "Grønt", "sub": "Grønt", "qty": 300, "unit": "g", "axis": "kr/kg", "per": 42 },
  { "id": 9000025, "name": "Tomatpuré Tomatpuré på hylde", "brand": "Brugsnær", "group": "Kolonial", "sub": "Sauce", "qty": 200, "unit": "g", "axis": "kr/kg", "per": 35 },
  { "id": 9000026, "name": "Fløde Fløde til madlavning 8%", "brand": "Nordvang", "group": "Mejeri", "sub": "Fløde", "qty": 500, "unit": "ml", "axis": "kr/l", "per": 26 },
  { "id": 9000027, "name": "Ris Grødris", "brand": "Mølhav", "group": "Kolonial", "sub": "Ris", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 28, "sale": true },
  { "id": 9000028, "name": "Pasta Spaghetti med korn", "brand": "Mølhav", "group": "Kolonial", "sub": "Pasta", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 22 },
  { "id": 9000029, "name": "Alperost Fast alperost", "brand": "Alpevang", "group": "Mejeri", "sub": "Ost", "qty": 250, "unit": "g", "axis": "kr/kg", "per": 160 },
  { "id": 9000031, "name": "Oksekød Hakset okse 9%", "brand": "Slagter Vænge", "group": "Kød", "sub": "Oksekød", "qty": 500, "unit": "g", "axis": "kr/kg", "per": 105 },
  { "id": 9000032, "name": "Fisk Hvid fisk hakket", "brand": "Havbond", "group": "Fisk", "sub": "Frossen", "qty": 400, "unit": "g", "axis": "kr/kg", "per": 118 },
  { "id": 9000033, "name": "Toiletpapir Blødt toiletpapir", "brand": "Hjemstlig", "group": "Husholdning", "sub": "Papir", "qty": 8, "unit": "rl", "axis": "kr/stk", "per": 7.5 },
  { "id": 9000034, "name": "Køkkenrulle Dobbelt køkkenrulle", "brand": "Hjemstlig", "group": "Husholdning", "sub": "Papir", "qty": 2, "unit": "rl", "axis": "kr/stk", "per": 14 },
  { "id": 9000035, "name": "Servietter Fugtige servietter", "brand": "Hjemstlig", "group": "Børn", "sub": "Servietter", "qty": 72, "unit": "stk", "axis": "kr/stk", "per": 0.9 },
  { "id": 9000036, "name": "Bleer Junior bleer str. 6", "brand": "Hjemstlig", "group": "Børn", "sub": "Bleer", "qty": 44, "unit": "stk", "axis": "kr/stk", "per": 3.1 },
  { "id": 9000037, "name": "Opvask Maskin tabs til opvask", "brand": "Skærbuen", "group": "Vask", "sub": "Opvask", "qty": 30, "unit": "stk", "axis": "kr/stk", "per": 2.2 },
  { "id": 9000038, "name": "Opvaskemiddel Tæt opvaskemiddel", "brand": "Skærbuen", "group": "Vask", "sub": "Opvask", "qty": 750, "unit": "ml", "axis": "kr/l", "per": 18 },
  { "id": 9000039, "name": "Affaldsposer Affaldsposer 20 liter", "brand": "Hjemstlig", "group": "Husholdning", "sub": "Papir", "qty": 30, "unit": "stk", "axis": "kr/stk", "per": 1.4 },
  { "id": 9000040, "name": "Pære Grønne pærer store", "brand": "Sønderhave", "group": "Frugt", "sub": "Frugt", "qty": 1, "unit": "kg", "axis": "kr/kg", "per": 21 },
  { "id": 9000041, "name": "Mayonnaise Husets mayonnaise light", "brand": "Brugsnær", "group": "Kolonial", "sub": "Dressing", "qty": 380, "unit": "g", "axis": "kr/kg", "per": 36 },
];

/** Pack text as Namlig writes it, so units.mjs parsePack reads it back. */
function packText(qty, unit) {
  const amount = String(qty).replace(".", ",");
  return unit === "stk" || unit === "rl" ? `${amount} ${unit}.` : `${amount} ${unit}`;
}

/** Base amount of one pack in g or ml, or null for a piece pack. */
function baseOf(qty, unit) {
  if (unit === "kg") return qty * 1000;
  if (unit === "l") return qty * 1000;
  if (unit === "g") return qty;
  if (unit === "ml") return qty;
  return null;
}

/**
 * Turn the table into shop products: sku 9000001 up, price = pack size x krPer, and a
 * checked result — a product whose stated price per unit does not match its pack price is
 * a bug in this table, and the build stops on it.
 */
function buildShelfProducts(table = SHELF_TABLE) {
  const out = [];
  for (const [i, row] of table.entries()) {
    if (!row || typeof row !== "object") throw new Error("shelf row " + i + " is not an object");
    const sku = String(row.id || "");
    if (!/^\d{7}$/.test(sku)) throw new Error("shelf row " + i + " has no invented 7-digit id");
    const base = baseOf(row.qty, row.unit);
    const price = Number((base === null ? row.qty * row.per : (base / 1000) * row.per).toFixed(2));
    const expected = row.axis === "kr/stk" ? row.per : row.per;
    const back = base === null ? price / row.qty : (price / base) * 1000;
    if (Math.abs(back - expected) > 0.15 * expected + 0.05) {
      throw new Error(`shelf row ${sku} ${row.name}: ${price} kr per pack does not match ${row.per} ${row.axis}`);
    }
    out.push({
      Id: sku,
      Name: row.name,
      Brand: row.brand,
      Price: price,
      UnitPriceCalc: Number(row.per.toFixed(2)),
      UnitPriceLabel: row.axis,
      Description: packText(row.qty, row.unit),
      Url: "/produkt/" + sku,
      ProductMainGroupName: row.group,
      ProductSubGroupName: row.sub,
      Availability: { IsDeliveryAvailable: true, IsAvailableInStock: true },
      Labels: row.sale ? ["Prisfald"] : [],
      Favorite: false,
      DiscountItem: !!row.sale,
      Campaign: row.campaign || null,
    });
  }
  return out;
}

/** Apply a case shelf spec (remove / set / add) and keep the count at exactly 40. */
function applyShelfSpec(base, spec = {}) {
  let products = base.slice();
  const removed = new Set((spec.remove || []).map(String));
  if (removed.size > 0) products = products.filter((p) => !removed.has(String(p.Id)));
  for (const patch of spec.set || []) {
    const sku = String(patch && patch.sku || "");
    const at = products.findIndex((p) => String(p.Id) === sku);
    if (at < 0) throw new Error(`shelf set: sku ${sku} is not on the base shelf`);
    products[at] = { ...products[at], ...patch, Id: sku };
  }
  for (const extra of spec.add || []) {
    if (!extra || !extra.Name) throw new Error("shelf add: product has no Name");
    products.push({ Availability: { IsDeliveryAvailable: true, IsAvailableInStock: true }, ...extra });
  }
  if (products.length !== SHELF_SIZE) {
    throw new Error(`shelf must hold ${SHELF_SIZE} products after remove/add, got ${products.length}`);
  }
  return products;
}

/** Best shelf product for a query word set: shared words, head word worth double. */
function bestProductFor(products, query) {
  const q = norm(query).split(" ").filter((w) => w.length > 1);
  if (q.length === 0) return null;
  let best = null;
  for (const p of products) {
    const n = norm(p.Name);
    const words = n.split(" ").filter((w) => w.length > 1);
    let hits = 0;
    for (const w of q) if (n.includes(w) || words.some((x) => w.includes(x))) hits++;
    if (words.some((x) => q[0].includes(x) || x.includes(q[0]))) hits += 2;
    if (hits >= 2 && (!best || hits > best.hits)) best = { hits, product: p };
  }
  return best ? best.product : null;
}

/**
 * Fixture rule 2: point every pantry line at a shelf product. The line keeps its id,
 * mode, qtyPerCycle, unit and cycle, and takes the shelf product's name and sku, so the
 * fixture profile never carries a real product name or a real sku.
 */
function alignPantry(pantry, products, pinMissing = []) {
  const missing = new Set(pinMissing.map(String));
  let aligned = 0;
  let unpinned = 0;
  for (const items of Object.values(pantry.blocks || {})) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const hit = bestProductFor(products, String(it.query || it.name || ""));
      if (hit) {
        it.query = hit.Name;
        it.name = hit.Name;
        if (it.sku !== undefined) it.sku = hit.Id;
        aligned++;
      } else if (it.sku) {
        delete it.sku;
        unpinned++;
      }
      if (missing.has(String(it.id))) it.sku = "9099999";
    }
  }
  return { aligned, unpinned };
}

/** Fixture rule 1: one fixed lastDate, so a stock cycle is due on every run of every day. */
function normalizeStaples(staples) {
  if (!Array.isArray(staples)) throw new Error("staples.json is not a list");
  for (const s of staples) if (s && typeof s === "object") s.lastDate = "2020-01-01";
  return staples;
}

/**
 * The invented .env the child reads. Fixed text, never a real credential.
 * The URL carries port 1 (nothing listens there) until golden-run rewrites it with the
 * stub's real port through setEnvValue(). lib.mjs reads the FILE, not the environment, so
 * this line is what decides where a plan run goes: it is always loopback.
 */
function writeEnv(home) {
  const lines = [
    "# Invented by tools/golden-build.mjs for the offline golden set. Not a credential.",
    "NEMLIG_MCP_URL=http://127.0.0.1:1/mcp",
    "MCP_SECRET=" + TEST_SECRET,
    "NEMLIG_USER=" + TEST_USER,
    "NEMLIG_PASS=" + TEST_PASS,
    "NEMLIG_CONCURRENCY=1",
  ];
  writeFileSync(join(home, ".env"), lines.join("\n") + "\n");
  return join(home, ".env");
}

/** Seed a product-cache.json whose entries are 48 h old and hold a product nobody should buy. */
function seedStaleCache(home, pantry) {
  const cache = {};
  const staleAgo = 48 * 3600 * 1000;
  for (const items of Object.values(pantry.blocks || {})) {
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const q = norm(String(it && it.query || ""));
      if (!q) continue;
      cache[q + "|12"] = { ts: Date.now() - staleAgo, products: [{
        id: "9000099", name: "Foraengelig maelk hoevejs ikke paa hylden", brand: "FakeGhost", price: 1,
        unitPrice: 1, unitLabel: "kr/stk", description: "1 stk", pack: { qty: 1, unit: "stk", raw: "1 stk" },
        url: "/produkt/9000099", availability: { IsDeliveryAvailable: true, IsAvailableInStock: true },
        labels: [], favorite: false, onSale: false, saleLabels: [], campaign: null,
      }] };
    }
  }
  return writeJson(join(home, "data", "product-cache.json"), cache);
}

/** Set one key in a fixture .env, keeping the rest. Only inside the fixture home. */
export function setEnvValue(file, key, value) {
  const abs = resolve(file);
  if (!abs.startsWith(HOME_ROOT + "/")) throw new Error("refusing to edit an env outside the fixture home: " + abs);
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("bad env key: " + key);
  const lines = readFileSync(abs, "utf8").split("\n");
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(key + "=")) { lines[i] = key + "=" + value; done = true; }
  }
  if (!done) lines.push(key + "=" + value);
  writeFileSync(abs, lines.join("\n"));
  return abs;
}

/** Wipe one fixture home, refusing anything outside test/golden/home. */
function cleanHome(home) {
  const abs = resolve(home);
  if (!abs.startsWith(HOME_ROOT + "/")) throw new Error("refusing to clean outside the fixture home: " + abs);
  rmSync(abs, { recursive: true, force: true });
  mkdirSync(join(abs, "profiles"), { recursive: true });
  mkdirSync(join(abs, "data", "plans"), { recursive: true });
  return abs;
}

/**
 * Copy the committed fixtures into the case home: the invented profile, the invented
 * generated files and the invented staples. No live file is read, so a clone with no
 * profiles/ and no data/ still builds a home, and no family data can travel with it.
 */
function copyFixtureFiles(home) {
  if (!existsSync(FIXTURES)) throw new Error("no fixture dir: " + FIXTURES + " - the golden fixtures are missing from the repository");
  const names = readdirSync(FIXTURES).filter((f) => /^[a-z0-9-]+\.json$/.test(f)).sort();
  const families = names.filter((f) => /^family-.*\.json$/.test(f) && !/^family-example/i.test(f));
  if (families.length !== 1) throw new Error(`fixtures must hold exactly one family-*.json, found ${families.length}: ${families.join(", ")}`);
  const copied = [];
  for (const f of names) {
    if (f === FIXTURE_STAPLES) { copyFileSync(join(FIXTURES, f), join(home, "data", f)); copied.push("data/" + f); continue; }
    copyFileSync(join(FIXTURES, f), join(home, "profiles", f));
    copied.push("profiles/" + f);
  }
  return copied;
}

/** Names a case profilePatch may touch: the committed fixture files, and nothing else. */
function fixtureFiles() {
  return new Set(readdirSync(FIXTURES).filter((f) => /^[a-z0-9-]+\.json$/.test(f)));
}

/**
 * Build one case home. Returns { name, home, shelfFile, envFile, stats }.
 * The caller (golden-run, the test) points NEMLIG_HOME at `home`.
 */
export function buildCase(name) {
  const caseFile = join(CASE_DIR, name + ".json");
  const spec = readJson(caseFile);
  if (!Array.isArray(spec.argv)) throw new Error(`${caseFile} has no argv array`);
  const home = cleanHome(join(HOME_ROOT, name));
  const copied = copyFixtureFiles(home);
  const allowed = fixtureFiles();
  let patched = 0;
  for (const [file, patch] of Object.entries(spec.profilePatch || {})) {
    if (!allowed.has(file)) throw new Error(`${caseFile}: profilePatch key ${file} is not a fixture under ${FIXTURES}`);
    const target = join(home, "profiles", file);
    if (!existsSync(target)) throw new Error(`${caseFile}: fixture ${file} was not copied into the home`);
    writeJson(target, mergePatch(readJson(target), patch));
    patched++;
  }
  const staples = normalizeStaples(readJson(join(home, "data", "staples.json")));
  writeJson(join(home, "data", "staples.json"), staples);
  const products = applyShelfSpec(buildShelfProducts(), spec.shelf || {});
  const shelfFile = writeJson(join(home, SHELF_NAME), {
    comment: "Invented shelf for the offline golden set. Not Namlig data.",
    products,
    basket: (spec.shelf && spec.shelf.basket) || {},
  });
  const pantry = readJson(join(home, "profiles", "pantry.json"));
  const align = alignPantry(pantry, products, (spec.shelf && spec.shelf.pinMissing) || []);
  writeJson(join(home, "profiles", "pantry.json"), pantry);
  const envFile = writeEnv(home);
  const stats = { copied: copied.length, patched, products: products.length, ...align };
  if (spec.seedStaleCache === true) seedStaleCache(home, pantry);
  return { name, home, shelfFile, envFile, stats };
}

/** Command line: build every case, or the ones named. */
function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const names = wanted.length > 0 ? wanted : caseNames();
  if (names.length === 0) {
    console.error("no cases in " + CASE_DIR);
    process.exitCode = 1;
    return;
  }
  for (const name of names) {
    const built = buildCase(name);
    console.log(`built ${name.padEnd(22)} shelf ${String(built.stats.products).padStart(2)} products, `
      + `pantry ${built.stats.aligned} aligned / ${built.stats.unpinned} unpinned, profiles copied ${built.stats.copied}, patched ${built.stats.patched}`);
  }
  console.log("fixture root: " + HOME_ROOT + " (not committed)");
}

if (process.argv[1] && process.argv[1].endsWith("golden-build.mjs")) {
  try {
    main();
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exitCode = 1;
  }
}
