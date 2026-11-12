#!/usr/bin/env node
// doctor.mjs — one preflight for a planner that has never run on this machine.
//
// What it checks, in the order a person needs it: Node, a family profile, the mined data,
// the .env keys, the folders it writes, docker (optional), and - only with --online - the
// MCP endpoint. Every line names the command that answers it. No credential value is ever
// printed, and nothing outside the data folders is written.
//
// Usage:
//   node doctor.mjs            one line per check; exit 1 when something blocks
//   node doctor.mjs --online   also probe the server: one GET /healthz, 3 s timeout
//   node doctor.mjs --json     the same findings as one object, for an agent

import { existsSync, readdirSync, mkdirSync, accessSync, readFileSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { HOME, PROFILES, DATA, PLANS, envFile, ENV_CANDIDATES } from "./paths.mjs";

const NODE_MIN = 20;                       // upstream engines say >=20; the planner uses node:test
const ENV_KEYS = ["NEMLIG_USER", "NEMLIG_PASS", "MCP_SECRET"];
const SECRET_MIN = 32;                     // the server refuses a shorter MCP_SECRET
const DOCKER_TIMEOUT_MS = 8000;
const BLOCK = "block", WARN = "warn", OK = "ok";

/** One finding: where it is, how bad, what it means, and the command that answers it. */
function finding(where, level, what, next = null) {
  return { where, level, what, next };
}

/** The profile a family edits. The shipped template is a shape, never a family. */
function familyProfiles(dir) {
  try {
    return readdirSync(dir).filter((f) => /^family-.*\.json$/i.test(f) && !/^family-example/i.test(f));
  } catch {
    return [];
  }
}

function checkNode(out) {
  const major = Number(String(process.versions.node).split(".")[0]);
  if (Number.isFinite(major) && major >= NODE_MIN) {
    out.push(finding("node " + process.versions.node, OK, "node:test and fetch work"));
    return;
  }
  out.push(finding("node " + process.versions.node, BLOCK, "the planner needs Node " + NODE_MIN + " or newer",
    "install Node 20 or newer, then run node doctor.mjs again"));
}

function checkProfile(out) {
  const files = familyProfiles(PROFILES);
  if (files.length > 0) {
    out.push(finding("profiles/", OK, files.length + " family profile(s): " + files.join(", ")));
    return;
  }
  const mined = existsSync(DATA + "/staples.json");
  out.push(finding("profiles/family-*.json", mined ? BLOCK : WARN,
    "no family profile yet, so plan.mjs has nothing to plan from",
    mined ? "node init-family.mjs --name family-of-4 --adults 2 --children 2 --days 8"
      : "read profiles/family-EXAMPLE.json, run the miners below, then init-family.mjs"));
}

/** The evidence files, mined from one family's own orders: a new install has none. */
function checkData(out) {
  const wanted = [
    ["staples.json", true, "data/", "node mine-history.mjs"],
    ["order-lines-raw.jsonl", true, "data/", "node mine-history.mjs"],
    ["recipe-pool.json", false, "profiles/", "node pick-recipe-pool.mjs, after mine-recipes.mjs and mine-recipes-fetch.mjs"],
    ["rotation.json", false, "data/", "written by the first apply.mjs that succeeds"],
  ];
  for (const [file, needed, dir, next] of wanted) {
    const where = dir === "profiles/" ? PROFILES : DATA;
    if (existsSync(where + "/" + file)) continue;
    out.push(finding(dir + file, needed ? BLOCK : WARN,
      needed ? "the planner needs the mined history to know what this family buys" : "not built yet", next));
  }
}

function envKeys(path) {
  const keys = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0 && !line.trim().startsWith("#")) keys[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return keys;
}

/** Names and lengths only. A value never reaches the output or the log. */
function checkEnv(out) {
  const env = envFile();
  if (!existsSync(env)) {
    out.push(finding(env, BLOCK, "no .env with the shop credentials was found",
      "put NEMLIG_USER, NEMLIG_PASS and MCP_SECRET in " + env + ", or point NEMLIG_ENV at the file"));
    return;
  }
  out.push(finding(env, OK, "credential file found"));
  // The last candidate is a folder written into the code. It works, and it should not be a
  // surprise: an explicit NEMLIG_ENV says which file belongs to this install.
  if (env === ENV_CANDIDATES[ENV_CANDIDATES.length - 1] && ENV_CANDIDATES.length > 1) {
    out.push(finding(env, WARN, "found by the last candidate, a path built into paths.mjs",
      "set NEMLIG_ENV to the file this install owns, and the lookup stops guessing"));
  }
  let keys;
  try {
    keys = envKeys(env);
  } catch (e) {
    out.push(finding(env, BLOCK, "the file cannot be read: " + e.message, "check the owner and mode of " + env));
    return;
  }
  for (const key of ENV_KEYS) {
    const value = keys[key] || "";
    if (!value) {
      out.push(finding(key, BLOCK, "not set in " + env, key === "MCP_SECRET"
        ? "set it to the value the MCP server runs with (openssl rand -hex 24 gives one)"
        : "set your Nemlig login in " + env));
      continue;
    }
    if (key === "MCP_SECRET" && value.length < SECRET_MIN) {
      out.push(finding(key, BLOCK, "only " + value.length + " characters, and the server needs " + SECRET_MIN,
        "use the same long secret the MCP server was started with"));
      continue;
    }
    out.push(finding(key, OK, "set"));
  }
  if (process.env.NEMLIG_MCP_URL) out.push(finding("NEMLIG_MCP_URL", OK, "explicit endpoint, so docker is not asked"));
}

function checkWritable(out) {
  for (const dir of [DATA, PLANS, DATA + "/locks"]) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      accessSync(dir, constants.W_OK);
      out.push(finding(dir, OK, "writable"));
    } catch (e) {
      out.push(finding(dir, BLOCK, "not writable: " + e.message, "fix the owner or the mode of " + dir));
    }
  }
}

/** Docker is optional: it only resolves a container IP when container DNS is stale. */
function checkDocker(out) {
  // No --format template: the field name differs between docker CLI versions, and a
  // refused probe must not be mistaken for a host without docker.
  const r = spawnSync("docker", ["version"], { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS });
  if (r.status === 0) {
    out.push(finding("docker", OK, "the daemon answers, so the container IP fallback can work"));
    return;
  }
  out.push(finding("docker", WARN, "no docker here, so the container IP fallback is off",
    "set NEMLIG_MCP_URL to where the server runs; the client then asks docker nothing"));
}

/** One probe, only on request. */
async function checkEndpoint(out) {
  const { pickEndpoint, loadEnv } = await import("./lib.mjs");
  try {
    const base = await pickEndpoint(loadEnv());
    out.push(finding("endpoint", OK, base + " answered /healthz (the secret is never shown)"));
  } catch (e) {
    out.push(finding("endpoint", BLOCK, String(e.message).slice(0, 200),
      "start the MCP server, or set NEMLIG_MCP_URL to where it runs"));
  }
}

/** The one command that moves a new install forward, from the findings above. */
function firstCommand() {
  if (!existsSync(DATA + "/staples.json")) return "node mine-history.mjs";
  if (familyProfiles(PROFILES).length === 0) return "node init-family.mjs --name family-of-4 --adults 2 --children 2 --days 8";
  return "node plan.mjs --days 8";
}

async function main() {
  const out = [];
  checkNode(out);
  checkEnv(out);        // credentials first: every step below needs them, so say so before asking for them
  checkProfile(out);
  checkData(out);
  checkWritable(out);
  checkDocker(out);
  if (process.argv.includes("--online")) await checkEndpoint(out);

  const blocked = out.filter((f) => f.level === BLOCK);
  const next = firstCommand();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ home: HOME, node: process.versions.node, checks: out.length,
      blocked: blocked.length, next, findings: out }, null, 1));
  } else {
    console.log("preflight for " + HOME);
    for (const f of out) {
      const mark = f.level === OK ? " ok  " : f.level === WARN ? "warn " : "STOP ";
      console.log(` ${mark} ${f.where} - ${f.what}${f.next ? "\n         next: " + f.next : ""}`);
    }
    console.log(blocked.length
      ? blocked.length + " thing(s) block a first plan. Start with: " + next
      : "Nothing blocks a plan. Next: " + next);
  }
  process.exitCode = blocked.length ? 1 : 0;
}

if (import.meta.url === "file://" + process.argv[1]) main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
