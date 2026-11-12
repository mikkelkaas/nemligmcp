#!/usr/bin/env node
// golden-shop.mjs — a stub Namlig shop on 127.0.0.1, for the golden set only.
//
// What it is: a plain node:http server bound to 127.0.0.1 on a free port
// (listen 0, then read the port). It answers the three JSON-RPC messages lib.mjs
// sends (initialize, notifications/initialized, tools/call) and two tools:
// search_products and get_basket. Everything it serves comes from one shelf file,
// so a run touches no shop on the internet and no real Nemlig container.
//
// Endpoints:
//   GET  /healthz            -> 200 {"ok":true}   (lib.mjs probes this first)
//   POST /<anything>         -> JSON-RPC; lib.mjs posts to <base>/<MCP_SECRET>,
//                               so the path is /mcp/<secret>. Any path is accepted.
//   Anything else            -> 404
//
// Envelope the planner expects (catalog.mjs search, apply.mjs basketMap):
//   search_products -> content[0].text = {"Products":{"Products":[ ... ]}}
//   get_basket      -> content[0].text = {"Lines":[ ... ],"TotalProductsPrice":n,"MinimumOrderTotal":n}
//
// Usage from code:  const shop = await startShop("<shelf.json>"); shop.url; await shop.close();
// Usage from a shell (debugging only):  node tools/golden-shop.mjs --shelf <file>
// It prints {"port":N,"url":"http://127.0.0.1:N/mcp"} and serves until killed.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const HOST = "127.0.0.1";
const PROTOCOL = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10000;
const SERVER_TIMEOUT_MS = 60000;
const MAX_BODY_BYTES = 2000000;
const MAX_PRODUCTS = 500;

/** Read and check the shelf file: { products: [...], basket: {...} }. */
export function loadShelf(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`golden-shop: cannot read shelf ${path}: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.products)) throw new Error(`golden-shop: ${path} has no products array`);
  if (parsed.products.length === 0) throw new Error(`golden-shop: ${path} has an empty products array`);
  if (parsed.products.length > MAX_PRODUCTS) throw new Error(`golden-shop: ${path} has ${parsed.products.length} products, max ${MAX_PRODUCTS}`);
  const basket = parsed.basket && typeof parsed.basket === "object" ? parsed.basket : {};
  return {
    products: parsed.products,
    basket: {
      Lines: Array.isArray(basket.Lines) ? basket.Lines : [],
      TotalProductsPrice: Number(basket.TotalProductsPrice ?? 0),
      MinimumOrderTotal: Number(basket.MinimumOrderTotal ?? 0),
    },
  };
}

/** Lower-case, letter-and-digit-only form used for the fake search. */
function fold(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[øØ]/g, "o")
    .replace(/[æÆ]/g, "a")
    .replace(/[åÅ]/g, "a")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Meaningful words of a query or product name, short words dropped. */
function words(s) {
  // Two letters count: the Danish head noun can be as short as "æg" or "fl".
  return fold(s).split(" ").filter((w) => w.length > 1);
}

/**
 * The fake search: every product whose folded name contains the head word of the
 * query, best token overlap first, ties broken by sku so the order never moves.
 * The real gate is still match.mjs in the planner — this only decides what is on
 * the shelf page, like a shop's own search engine would.
 */
export function searchShelf(products, query, take) {
  const q = words(query);
  if (q.length === 0) return [];
  const head = q[0];
  const scored = [];
  for (const p of products.slice(0, MAX_PRODUCTS)) {
    const name = fold(p.Name);
    if (!name.includes(head)) continue;
    let hits = 0;
    for (const w of q) if (name.includes(w)) hits++;
    scored.push({ p, hits });
  }
  scored.sort((a, b) => b.hits - a.hits || String(a.p.Id).localeCompare(String(b.p.Id)));
  const limit = Math.max(1, Math.min(Number(take) || 12, MAX_PRODUCTS));
  return scored.slice(0, limit).map((s) => s.p);
}

/** A tool result in the shape Mcp.call reads: one text part holding JSON. */
function toolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false };
}

/** One JSON-RPC message in, one answer out. kind "none" means: answer with 200 and no id. */
function answer(shelf, msg) {
  const id = msg.id === undefined ? null : msg.id;
  const method = String(msg.method || "");
  if (method === "initialize") {
    return { kind: "result", id, result: { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: "golden-shop", version: "1.0.0" } } };
  }
  if (method === "notifications/initialized") return { kind: "none" };
  if (method !== "tools/call") return { kind: "error", id, error: { code: -32601, message: "method not allowed: " + method } };
  const args = (msg.params && msg.params.arguments) || {};
  const name = String((msg.params && msg.params.name) || "");
  if (name === "search_products") {
    return { kind: "result", id, result: toolResult({ Products: { Products: searchShelf(shelf.products, String(args.query || ""), args.take) } }) };
  }
  if (name === "get_basket") {
    return { kind: "result", id, result: toolResult(shelf.basket) };
  }
  return { kind: "error", id, error: { code: -32602, message: "tool not served by the golden shop: " + name } };
}

/** Read a request body with a byte cap and a timer, so a hung client cannot stall the run. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error("body read timeout")), REQUEST_TIMEOUT_MS);
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { clearTimeout(timer); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** Send one JSON response, always with content-type application/json. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** One request: /healthz, or a JSON-RPC POST. Nothing else is served. */
async function handle(shelf, stats, req, res) {
  const url = new URL(req.url || "/", "http://" + HOST);
  if (req.method === "GET" && url.pathname === "/healthz") { stats.healthz++; sendJson(res, 200, { ok: true, shelf: shelf.products.length }); return true; }
  if (req.method !== "POST") { sendJson(res, 404, { error: "not found" }); return true; }
  // Record the SHAPE of the path, never the secret that rides in it.
  const parts = url.pathname.split("/").filter(Boolean).map((x) => (x.startsWith("golden-test-secret-") ? "<secret>" : x));
  const shape = "/" + parts.slice(0, 2).join("/");
  if (stats.paths.length < 200 && !stats.paths.includes(shape)) stats.paths.push(shape);
  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (e) {
    sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "bad json: " + e.message } });
    return true;
  }
  if (!msg || typeof msg !== "object") { sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32600, message: "not a request" } }); return true; }
  const tool = String((msg.params && msg.params.name) || "");
  if (msg.method === "tools/call") { stats.toolCalls++; stats.byTool[tool] = (stats.byTool[tool] || 0) + 1; }
  const a = answer(shelf, msg);
  if (a.kind === "none") { sendJson(res, 200, { jsonrpc: "2.0" }); return true; }
  if (a.kind === "error") { sendJson(res, 200, { jsonrpc: "2.0", id: a.id, error: a.error }); return true; }
  sendJson(res, 200, { jsonrpc: "2.0", id: a.id, result: a.result });
  return true;
}

/**
 * Start the shop on a free loopback port. Returns { port, base, url, stats, close }.
 * `base` is what a child gets as NEMLIG_MCP_URL; the secret is appended by lib.mjs.
 * stats() reports what this shop served: calls, healthz probes, tool calls by name,
 * rejected non-loopback Host headers and the distinct paths it saw.
 * close() is safe to call twice and always resolves.
 */
export async function startShop(shelfPath) {
  const shelf = loadShelf(shelfPath);
  const stats = { calls: 0, healthz: 0, toolCalls: 0, rejected: 0, byTool: {}, paths: [] };
  const server = createServer((req, res) => {
    const host = String(req.headers.host || "");
    if (!/^127\.0\.0\.1:\d+$/.test(host)) { stats.rejected++; sendJson(res, 403, { error: "only loopback is served" }); return; }
    stats.calls++;
    const killer = setTimeout(() => { res.destroy(); }, REQUEST_TIMEOUT_MS);
    handle(shelf, stats, req, res).catch((e) => {
      try {
        sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32000, message: e.message } });
      } catch {
        /* the socket is gone; nothing to report to a client that left */
      }
    }).finally(() => clearTimeout(killer));
  });
  server.requestTimeout = SERVER_TIMEOUT_MS;
  server.headersTimeout = SERVER_TIMEOUT_MS + 5000;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("golden-shop: listen timed out")), 10000);
    server.once("error", (e) => { clearTimeout(timer); reject(e); });
    server.listen(0, HOST, () => { clearTimeout(timer); resolve(); });
  });
  const addr = server.address();
  if (!addr || typeof addr !== "object" || addr.address !== HOST) {
    await new Promise((r) => server.close(r));
    throw new Error("golden-shop: not bound to 127.0.0.1, bound to " + JSON.stringify(addr));
  }
  return {
    port: addr.port,
    base: `http://${HOST}:${addr.port}/mcp`,
    stats: () => ({ ...stats, byTool: { ...stats.byTool } }),
    async close() {
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Only when started as a command: a standing shop for poking at by hand. */
if (process.argv[1] && process.argv[1].endsWith("golden-shop.mjs")) {
  const shelfArg = process.argv.indexOf("--shelf");
  if (shelfArg < 0 || !process.argv[shelfArg + 1]) {
    console.error("usage: node tools/golden-shop.mjs --shelf <shelf.json>");
    process.exitCode = 2;
  } else {
    const shop = await startShop(process.argv[shelfArg + 1]);
    console.log(JSON.stringify({ port: shop.port, url: shop.base }));
  }
}
