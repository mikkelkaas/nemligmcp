// lib.mjs — shared MCP client for the Nemlig basket planner.
// Talks to the namelymcp container over Streamable HTTP on host loopback.
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
const CONTAINER = "nemligmcp";
const NET = "docker_infra_net";
const PROBE_TIMEOUT_MS = 3000;
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

/** Return the first base whose /healthz answers, or a docker-resolved IP base. */
export async function pickEndpoint(env = loadEnv()) {
  const bases = env.NEMLIG_MCP_URL ? [env.NEMLIG_MCP_URL] : CANDIDATE_BASES.slice();
  try {
    bases.push("http://" + dockerIp(CONTAINER) + ":3000/mcp");
  } catch (e) {
    process.stderr.write("warn: docker IP fallback unavailable: " + e.message + "\n");
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
  throw new Error("no namelymcp endpoint answered " + HEALTH_PATH + ": " + failures.join(" | "));
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
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextId = 0;
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
    const text = await res.text();
    if (isNotification) return { status: res.status };
    if (!text) throw new Error(`empty response from ${method} (HTTP ${res.status})`);
    const json = parseBody(text, res.headers.get("content-type"));
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
    const r = await this.rpc("tools/call", { name, arguments: args }, opts);
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
export async function connect(env = loadEnv()) {
  const base = await pickEndpoint(env);
  const mcp = new Mcp(endpointFromEnv(env, base));
  const info = await mcp.connect();
  return { mcp, info };
}

/** Sleep helper for paced loops. Not unref'd on purpose: an unref'd timer lets
 *  Node exit before the delay elapses when nothing else is pending. */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Print redacted endpoint info for logs. */
export function logTarget(endpoint) {
  return endpoint.safeUrl;
}
