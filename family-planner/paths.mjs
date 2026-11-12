// paths.mjs — every path the planner touches, in one place.
//
// Why this exists: the planner used to carry /opt/docker/scripts/nemlig in 16
// files. That is one machine and one family. Every module now asks this file, so
// the folder can be moved, vendored into another repository, or installed in a
// home directory without one edit.
//
// Resolution order for the folder:
//   1. NEMLIG_HOME, when set (a cron or a container can point anywhere);
//   2. the folder this file sits in (the normal case: git clone and run).
//
// Credentials are never stored here. envFile() only finds which .env to read.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

/** The planner folder: NEMLIG_HOME, else the folder this file lives in. */
export const HOME = process.env.NEMLIG_HOME
  ? resolve(process.env.NEMLIG_HOME)
  : dirname(fileURLToPath(import.meta.url));

export const DATA = join(HOME, "data");
export const PROFILES = join(HOME, "profiles");
export const PLANS = join(DATA, "plans");
export const CACHE_PATH = join(DATA, "product-cache.json");

/**
 * The .env holding NEMLIG_USER and NEMLIG_PASS, first of these that exists:
 * NEMLIG_ENV, the planner folder, the repository root above it, and the folder
 * this project grew up in. A missing file is reported by the caller, which says
 * what it looked for.
 */
export function envFile() {
  const candidates = [
    process.env.NEMLIG_ENV,
    join(HOME, ".env"),
    join(dirname(HOME), ".env"),
    "/opt/docker/.env",
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}

/** A path inside the planner folder. */
export function inHome(...parts) {
  return join(HOME, ...parts);
}
