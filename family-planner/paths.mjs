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
import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, closeSync } from "node:fs";

/** The planner folder: NEMLIG_HOME, else the folder this file lives in. */
export const HOME = process.env.NEMLIG_HOME
  ? resolve(process.env.NEMLIG_HOME)
  : dirname(fileURLToPath(import.meta.url));

export const DATA = join(HOME, "data");
export const PROFILES = join(HOME, "profiles");
export const PLANS = join(DATA, "plans");
export const CACHE_PATH = join(DATA, "product-cache.json");

/**
 * The .env holding NEMLIG_USER and NEMLIG_PASS, first of these that exists: NEMLIG_ENV,
 * the planner folder, then the repository root above it (where .env.example is copied).
 * No path here belongs to one machine: an install that keeps its credentials elsewhere
 * sets NEMLIG_ENV. A missing file is reported by the caller, which says what it looked for.
 */
/** The places envFile() looks, in order. Exported so a caller can name them. */
export const ENV_CANDIDATES = [
  process.env.NEMLIG_ENV,
  join(HOME, ".env"),
  join(dirname(HOME), ".env"),
].filter(Boolean);

export function envFile() {
  for (const p of ENV_CANDIDATES) if (existsSync(p)) return p;
  return ENV_CANDIDATES[0];
}

/**
 * Write a JSON file so a crash cannot leave a half-written state behind: the bytes go
 * to a sibling temp file first, then one rename replaces the old file.
 */
export function writeJsonAtomic(path, value, indent = 1) {
  const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  if (dir) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, indent));
  renameSync(tmp, path);
  return path;
}

/**
 * Run `fn` while holding a lock, so two runs never write the same state at once.
 * The lock is a file created with O_EXCL. A lock older than maxAgeMs is taken over:
 * that is a run that died without cleaning up, not a run that is still working.
 */
export async function withLock(name, fn, { maxAgeMs = 20 * 60 * 1000, dir = join(DATA, "locks") } = {}) {
  if (!/^[a-z0-9-]{1,32}$/.test(String(name))) throw new Error("lock name must be a-z 0-9 dash: " + name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name + ".lock");
  let fd = -1;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!staleLock(file, maxAgeMs)) throw new Error(`another run holds the ${name} lock (${file}) - if none is running, delete that file`);
      unlinkSync(file);
      continue;
    }
  }
  if (fd < 0) throw new Error(`could not take the ${name} lock after 2 attempts: ${file}`);
  closeSync(fd);
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* the lock is gone already; nothing to undo */
    }
  }
}

/** True when the lock file is older than the age a live run can explain. */
function staleLock(file, maxAgeMs) {
  try {
    return Date.now() - statSync(file).mtimeMs > maxAgeMs;
  } catch {
    return true;
  }
}

/** A path inside the planner folder. */
export function inHome(...parts) {
  return join(HOME, ...parts);
}
