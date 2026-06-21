import { z } from "zod";

/** Base host for auth, basket and product-detail pages. */
export const BASE_URL = "https://www.nemlig.com";

/** Search gateway host (bearer-only, no cookies). */
export const SEARCH_URL = "https://webapi.prod.knl.nemlig.it";

/**
 * Headers sent on (almost) every request. The nemlig.com API expects a
 * browser-like client; `X-Correlation-Id` is added per-request in the client.
 */
export const DEFAULT_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
  // A non-browser User-Agent. A browser-like UA causes nemlig.com to route the
  // homepage through its Queue-it virtual waiting-room (302 -> nemlig.queue-it.net),
  // which breaks the JSON page-settings fetch. A plain identifier bypasses it.
  "User-Agent": "nemligmcp/0.1.0 (+https://github.com/nemlig/nemligmcp)",
  "Device-Size": "desktop",
  Platform: "web",
  // The nemlig.com client version string; some endpoints (notably the search
  // gateway) reject requests without it.
  Version: "11.201.0",
  Referer: `${BASE_URL}/`,
  Origin: BASE_URL,
};

// Treat empty/whitespace-only values as "not provided" so an env var set to ""
// means anonymous mode rather than a validation error.
const optionalNonEmpty = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  NEMLIG_USER: optionalNonEmpty,
  NEMLIG_PASS: optionalNonEmpty,
});

export interface Credentials {
  username: string;
  password: string;
}

export interface Config {
  /** Present only when both username and password are provided. */
  credentials?: Credentials;
  /** Convenience flag: true when credentials are available (login mode). */
  hasCredentials: boolean;
}

/** Parse and validate configuration from the process environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.parse({
    NEMLIG_USER: env.NEMLIG_USER,
    NEMLIG_PASS: env.NEMLIG_PASS,
  });

  if (parsed.NEMLIG_USER && parsed.NEMLIG_PASS) {
    return {
      credentials: { username: parsed.NEMLIG_USER, password: parsed.NEMLIG_PASS },
      hasCredentials: true,
    };
  }

  return { hasCredentials: false };
}
