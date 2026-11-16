// lib.mjs — shared MCP client for the Nemlig basket planner.
// Talks to the MCP container over Streamable HTTP on host loopback or container DNS.
// Rules honoured: every network call has a timeout, every loop is bounded,
// every result is checked, the secret is never printed.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { envFile } from "./paths.mjs";
const ENV_PATH = envFile();
// Two candidate bases: container DNS (works from any container on docker_infra_net,
// including paseo where the agent runs) and host loopback (works from the host if a
// port is ever published). pickEndpoint() probes them in order, twice, then throws.
const CANDIDATE_BASES = ["http://namligmcp:3000/mcp", "http://127.0.0.1:3900/mcp"];
const HEALTH_PATH = "/healthz";
// Container identity, used by pickEndpoint to bypass stale embedded-DNS records.
// Both names belong to the install, not to the library, so the environment may set them:
// NEMLIG_CONTAINER and NEMLIG_NET. On a host that runs the server another way, the docker
// lookup simply fails, prints one warn line and the HTTP candidates decide.
const CONTAINER = process.env.NEMLIG_CONTAINER || "nemligmcp";
const NET = process.env.NEMLIG_NET || "docker_infra_net";
const PROBE_TIMEOUT_MS = 3000;
// Traffic to the shop: how many calls at once, how far apart two starts are, and how
// long a run may take. All three come from the environment, so a new family tunes them
// without editing code: NEMLIG_CONCURRENCY (1-8, default 4) and NEMLIG_MAX_MINUTES.
const CONCURRENCY_DEFAULT = 4;
const MAX_INTERVAL_MS = 120;
const PROBE_RETRIES = 2;
const PROTOCOL = "2025-06-18";
const MAX_INIT_RETRY = 3;
const CALL_TIMEOUT_MS = 60000;
const INIT_TIMEOUT_MS = 20000;

/** Parse the .env (see paths.mjs envFile) into an object. Comments and blanks are ignored. */
export function loadEnv(path = ENV_PATH) {
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Build the endpoint URL from env. Throws if the secret is missing or short. */
export function endpointFromEnv(env = loadEnv(), base = null) {
  const b = base || env.NEMLIG_MCP_URL || CANDIDATE_BASES[0];
  const secret = env.MCP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("MCP_SECRET missing or shorter than 32 chars in " + ENV_PATH);
  }
  return { url: b + "/" + secret, safeUrl: b + "/<MCP_SECRET>" };
}

/** Ask Docker for the live container IP. Used when DNS is stale (embedded DNS
 *  caches container IPs for 10 minutes, so a recreate can point at a dead IP). */
function dockerIp(container) {
  const fmt = "{{.NetworkSettings.Networks." + NET + ".IPAddress}}";
  const r = spawnSync("docker", ["inspect", "-f", fmt, container], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (r.status !== 0) {
    throw new Error("docker inspect failed: " + (r.stderr || r.error || "no output").slice(0, 120));
  }
  const ip = (r.stdout || "").trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("no IPv4 for " + container);
  return ip;
}

/** Return the first base whose /healthz answers, or a docker-resolved IP base.
 *  An explicit NEMLIG_MCP_URL is obeyed alone: no candidates, no docker lookup. It is what
 *  an offline test points at a stub on loopback, and a fallback to a live container there
 *  would send a test run to the real shop - one health probe away. */
export async function pickEndpoint(env = loadEnv()) {
  const bases = env.NEMLIG_MCP_URL ? [env.NEMLIG_MCP_URL] : CANDIDATE_BASES.slice();
  if (!env.NEMLIG_MCP_URL) {
    try {
      bases.push("http://" + dockerIp(CONTAINER) + ":3000/mcp");
    } catch (e) {
      process.stderr.write("warn: docker IP fallback unavailable: " + e.message + "\n");
    }
  }
  const failures = [];
  for (const base of bases) {
    for (let attempt = 1; attempt <= PROBE_RETRIES; attempt++) {
      try {
        const res = await fetch(base.replace(/\/mcp$/, "") + HEALTH_PATH, {
          signal: abortSignal(PROBE_TIMEOUT_MS),
        });
        if (res.ok) return base;
        failures.push(base + " HTTP " + res.status);
      } catch (e) {
        failures.push(base + " " + (e.cause ? e.cause.code || e.cause.message : e.message));
      }
    }
  }
  throw new Error("no MCP endpoint answered " + HEALTH_PATH + ": " + failures.join(" | "));
}

function abortSignal(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  t.unref();
  return c.signal;
}

/** Pull the JSON payload out of an SSE body or a plain JSON body. */
function parseBody(text, contentType) {
  if (contentType && contentType.includes("text/event-stream")) {
    const lines = text.split("\n").filter((l) => l.startsWith("data:"));
    if (lines.length === 0) throw new Error("SSE body had no data: lines");
    return JSON.parse(lines[lines.length - 1].slice(5).trim());
  }
  return JSON.parse(text);
}

/** An MCP session: one initialize, then many tool calls. */
export class Mcp {
  constructor(endpoint, limiter = null) {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextId = 0;
    this.limiter = limiter;
  }

  async rpc(method, params, { timeoutMs = CALL_TIMEOUT_MS, isNotification = false } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const body = isNotification
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", id: ++this.nextId, method, params };
    const res = await fetch(this.endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortSignal(timeoutMs),
    });
    if (!this.sessionId) this.sessionId = res.headers.get("mcp-session-id");
    if (res.status === 404) throw new Error("404 from MCP endpoint — check MCP_SECRET");
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new Error(`HTTP ${res.status} from ${method}`); // transient: the gate retries it
    }
    const text = await res.text();
    if (isNotification) return { status: res.status };
    if (!text) throw new Error(`empty response from ${method} (HTTP ${res.status})`);
    const json = parseBody(text, res.headers.get("content-type"));
    // Under a busy gate a body from another call must never be read as this one's answer.
    if (!isNotification && json.id !== undefined && json.id !== body.id) {
      throw new Error(`${method}: answer id ${json.id} does not match the request id ${body.id}`);
    }
    if (json.error) {
      throw new Error(method + " failed: " + JSON.stringify(json.error).slice(0, 300));
    }
    return json.result;
  }

  /** Handshake with a bounded number of attempts. */
  async connect() {
    let last = null;
    for (let attempt = 1; attempt <= MAX_INIT_RETRY; attempt++) {
      try {
        const init = await this.rpc("initialize", {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "nemlig-planner", version: "1.0.0" },
        }, { timeoutMs: INIT_TIMEOUT_MS });
        await this.rpc("notifications/initialized", undefined, { isNotification: true });
        return init.serverInfo;
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`MCP connect failed after ${MAX_INIT_RETRY} attempts: ${last.message}`);
  }

  async listTools() {
    const r = await this.rpc("tools/list", {});
    return r.tools;
  }

  /** Call a tool. Returns { text, json, isError } with json null when not JSON. */
  async call(name, args = {}, opts = {}) {
    const send = () => this.rpc("tools/call", { name, arguments: args }, opts);
    const r = this.limiter ? await this.limiter.run(send) : await send();
    if (r.isError && this.limiter) this.limiter.noteToolError(name, r.text);
    const text = (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { text, json, isError: !!r.isError, raw: r };
  }
}

/** Convenience: connect once and return a live Mcp. */
export async function connect(env = loadEnv(), { limiter = null } = {}) {
  const base = await pickEndpoint(env);
  const mcp = new Mcp(endpointFromEnv(env, base), limiter);
  const info = await mcp.connect();
  return { mcp, info };
}

/** Sleep helper for paced loops. Not unref'd on purpose: an unref'd timer lets
 *  Node exit before the delay elapses when nothing else is pending. */
/**
 * The current time as the family reads a clock, with the offset written out, so the string stays
 * machine-readable. A generated file that says 21:39 while the kitchen says 22:39 is the one
 * thing a log about "when did this last run" must not be.
 */
export function localStamp(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(now).reduce((a, x) => (a[x.type] = x.value, a), {});
  const wall = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
  if (!Number.isFinite(wall)) return now.toISOString();
  const off = Math.round((wall - now.getTime()) / 60000), sign = off < 0 ? "-" : "+", abs = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
    + `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Print redacted endpoint info for logs. */
export function logTarget(endpoint) {
  return endpoint.safeUrl;
}

/** A positive integer inside a fixed range, with a default when the value is absent. */
function clampInt(value, dflt, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function rand(ms) {
  return Math.floor(Math.random() * Math.max(0, ms));
}

/** A wrong secret or a wrong path will not get better by asking again. */
function fatalCallError(e) {
  return /404 from MCP endpoint|MCP_SECRET/.test(String(e && e.message || ""));
}

/**
 * One gate for every call to the shop: a bounded number in flight, a minimum spacing
 * between two starts, exponential backoff when the shop pushes back, and a breaker that
 * ends the run instead of burning a timeout after a timeout. Read traffic runs several
 * lanes; a basket write runs with concurrency 1 on purpose.
 */
export class Limiter {
  constructor(o = {}) {
    this.concurrency = clampInt(o.concurrency, CONCURRENCY_DEFAULT, 1, 8);
    this.maxConcurrency = this.concurrency;
    this.minIntervalMs = clampInt(o.minIntervalMs, MAX_INTERVAL_MS, 0, 5000);
    this.jitterMs = clampInt(o.jitterMs, 80, 0, 2000);
    this.attempts = clampInt(o.attempts, 3, 1, 5);
    this.backoffStartMs = clampInt(o.backoffStartMs, 1500, 100, 60000);
    this.backoffMaxMs = clampInt(o.backoffMaxMs, 30000, 500, 600000);
    this.maxFailures = clampInt(o.maxConsecutiveFailures, 8, 1, 100);
    // A run that asks more questions than this is not a planner run, it is a bug or a
    // scrape: stop asking the shop. Half of a 14-day plan is 40 calls, so 400 is generous.
    this.maxCalls = clampInt(o.maxCalls, 400, 1, 10000);
    this.cooldownMs = clampInt(o.halfOpenCooldownMs, 15000, 1000, 600000);
    this.deadlineAt = Number(o.deadlineAtMs) > 0 ? Number(o.deadlineAtMs) : 0;
    this.inFlight = 0;
    this.lastStart = 0;
    this.waiters = [];
    this.pumpTimer = null;
    this.failures = 0;
    this.backoffMs = 0;
    this.openUntil = 0;
    this.broken = null;      // the breaker's reason, set when it stops the run
    this.brokenAt = 0;
    this.stats = { calls: 0, retries: 0, backoffs: 0, lanes: this.concurrency, toolErrors: 0 };
  }

  /** Run one shop call through the gate, with a bounded number of attempts. */
  async run(fn) {
    this._checkDeadline();
    this._checkBudget();
    this._maybeHalfOpen();
    if (this.broken) throw new Error(this.broken);
    let last = null;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      await this._gate();
      let r;
      try {
        r = await fn();
      } catch (e) {
        this._release();
        last = e;
        if (fatalCallError(e)) throw e;
        this._fail();
        if (this.broken) throw new Error(this.broken);
        if (attempt < this.attempts) {
          this.stats.retries++;
          await sleep(this.backoffMs + rand(this.jitterMs));
        }
        continue;
      }
      this._release();
      this._succeed();
      this.stats.calls++;
      return r;
    }
    throw last;
  }

  /** A short summary for the plan output: what the gate actually did. */
  summary() {
    const s = this.stats;
    return `${s.calls} call(s), up to ${s.lanes} in flight, ${s.retries} retry(ies), ${s.backoffs} backoff(s)`
      + (s.toolErrors ? `, ${s.toolErrors} shop error(s)` : "");
  }

  /**
   * A tool-level error is an answer, so it is not retried - the request itself is wrong or
   * the shop is unhappy. Counted here so a shop that answers every call with an error stops
   * the run instead of letting each intent burn its own attempts.
   */
  noteToolError(name, text) {
    this.stats.toolErrors++;
    this._fail();
    if (this.broken) {
      this.broken = `namligmcp answered ${this.failures} calls in a row with an error (last: ${name} ${String(text || "").slice(0, 80)}) - the run stops here`;
    }
  }

  _checkBudget() {
    if (this.stats.calls >= this.maxCalls) {
      throw new Error(`this run made ${this.stats.calls} calls, the limit is ${this.maxCalls} - raise NEMLIG_MAX_CALLS if that is really intended`);
    }
  }

  /** Half-open: after the cooldown one call may try again. A success closes the breaker. */
  _maybeHalfOpen() {
    if (!this.broken || Date.now() - this.brokenAt < this.cooldownMs) return;
    process.stderr.write("warn: trying the shop again after the breaker opened\n");
    this.broken = null;
    this.failures = this.maxFailures - 1;
    this.backoffMs = Math.floor(this.backoffMs / 2);
    this.concurrency = Math.min(this.maxConcurrency, Math.max(1, this.concurrency * 2));
  }

  _checkDeadline() {
    if (this.deadlineAt && Date.now() > this.deadlineAt) {
      throw new Error(`run deadline of ${Math.round(this.deadlineAt / 60000)} min of wall clock passed after ${this.stats.calls} call(s) — raise NEMLIG_MAX_MINUTES or lower --days`);
    }
  }

  async _gate() {
    this._checkDeadline();
    for (let guard = 0; guard < 500 && Date.now() < this.openUntil; guard++) {
      await sleep(Math.min(250, Math.max(10, this.openUntil - Date.now())));
    }
    await this._slot();
  }

  _slot() {
    if (this.inFlight < this.concurrency && Date.now() - this.lastStart >= this.minIntervalMs) {
      this.inFlight++;
      this.lastStart = Date.now();
      return Promise.resolve();
    }
    // The caller must be woken by a timer, not only by a release: when no call is in
    // flight and only the spacing holds this one back, no release is coming.
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this._pump();
    });
  }

  _release() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this._pump();
  }

  /** Hand the freed place to the next caller, never two starts closer than the spacing. */
  _pump() {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (let guard = 0; guard < 1000 && this.waiters.length && this.inFlight < this.concurrency
      && Date.now() - this.lastStart >= this.minIntervalMs; guard++) {
      this.inFlight++;
      this.lastStart = Date.now();
      this.waiters.shift()();
    }
    if (this.waiters.length && this.inFlight < this.concurrency) {
      const wait = Math.max(1, this.minIntervalMs - (Date.now() - this.lastStart));
      this.pumpTimer = setTimeout(() => {
        this.pumpTimer = null;
        this._pump();
      }, wait);
    }
  }

  /** Trouble: count it, slow the whole gate down, and give it one lane until it settles. */
  _fail() {
    this.failures++;
    if (this.failures >= this.maxFailures && !this.broken) {
      this.broken = `namligmcp failed ${this.failures} calls in a row - the run stops here, fix the shop or the secret, or reuse data/product-cache.json with a fresh --days`;
      this.brokenAt = Date.now();
    }
    this.backoffMs = Math.min(this.backoffMaxMs, this.backoffMs > 0 ? this.backoffMs * 2 : this.backoffStartMs);
    this.openUntil = Date.now() + this.backoffMs;
    this.stats.backoffs++;
    this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
  }

  _succeed() {
    this.failures = 0;
    this.backoffMs = 0;
  }
}

/**
 * Connect with the gate on. Every script that reads from the shop uses this, so pacing,
 * retries, the breaker and the deadline are decided in one place. `attempts: 1` is what a
 * writer passes: a lost answer must not be asked for again.
 */
export async function connectGated(o = {}) {
  const limiter = new Limiter({ concurrency: readConcurrency(), ...o });
  const r = await connect(loadEnv(), { limiter });
  return { ...r, limiter };
}

/** Map over items with a bounded number running at once, in the order they came in. */
export async function mapPool(items, worker, { concurrency = 4 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length).fill(null);
  if (list.length === 0) return out;
  const lanes = Math.max(1, Math.min(Number(concurrency) || 1, list.length, 16));
  let next = 0;
  const runners = [];
  for (let lane = 0; lane < lanes; lane++) {
    runners.push((async () => {
      for (let guard = 0; guard < list.length; guard++) {
        const i = next++;
        if (i >= list.length) return;
        out[i] = await worker(list[i], i);
      }
    })());
  }
  await Promise.all(runners);
  return out;
}

/** Concurrency for read traffic: the environment wins over the default. */
export function readConcurrency(env = process.env) {
  return clampInt(env.NEMLIG_CONCURRENCY, CONCURRENCY_DEFAULT, 1, 8);
}

/** Flags the planner does not know: usually a typo, and it silently does nothing. */
export function unknownFlags(argv, known) {
  const out = [];
  for (const a of argv) {
    if (!String(a).startsWith("--")) continue;
    const name = String(a).slice(2);
    if (name && !known.includes(name)) out.push(name);
  }
  return out;
}

/** The same warning in every script, so a typo costs one glance and no re-plan. */
export function warnUnknownFlags(argv, known, label = "--help") {
  const unknown = unknownFlags(argv, known);
  if (unknown.length) console.log(`  warn  unknown flag(s) --${unknown.join(", --")}: this run ignores them (${label} lists what works)`);
  return unknown;
}

/**
 * How a script reports dying: one line a person can act on. The stack is for us, so it
 * stays behind --debug. Every script uses this, so an error never looks different twice.
 */
export function reportFailure(e, argv = process.argv) {
  const message = String((e && e.message) || e || "unknown error");
  const first = message.split("\n")[0].slice(0, 500);
  console.error("FAILED: " + first);
  const hint = /MCP_SECRET|healthz|deadline|stopped|limit is|not readable|REFUSED/.test(message) ? "" : " (add --debug for the stack)";
  if (hint) console.error("       " + hint.trim());
  if (argv.includes("--debug")) console.error((e && e.stack) || message);
  return first;
}
