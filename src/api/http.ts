import { randomUUID } from "node:crypto";
import { DEFAULT_HEADERS } from "../config.js";
import { CookieJar } from "./cookieJar.js";
import { NemligError, NemligHttpError, NemligNetworkError } from "./errors.js";
import { apiUrl } from "./urls.js";

export interface RequestOptions {
  method?: string;
  /** Extra headers, merged over DEFAULT_HEADERS. */
  headers?: Record<string, string>;
  /** JSON body; serialized and sent with Content-Type: application/json. */
  json?: unknown;
  /** Query params appended to the URL. Undefined/null values are skipped. */
  query?: Record<string, string | number | undefined | null>;
  /** Cookie jar to read/replay and absorb Set-Cookie into. Omit for cookieless hosts. */
  jar?: CookieJar;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Raw response text (may be empty). */
  text: string;
}

function buildUrl(base: string, query?: RequestOptions["query"]): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Perform a single HTTP request with cookie-jar support and a correlation id.
 * Does NOT throw on non-2xx — callers inspect `status`. Throws NemligNetworkError
 * only on transport failures.
 */
export async function rawRequest(url: string, opts: RequestOptions = {}): Promise<RawResponse> {
  const finalUrl = buildUrl(apiUrl(url, !!opts.jar).href, opts.query);
  const headers: Record<string, string> = {
    ...DEFAULT_HEADERS,
    "X-Correlation-Id": randomUUID(),
    ...opts.headers,
  };

  let body: string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = "application/json";
  }

  if (opts.jar) {
    const cookie = opts.jar.header();
    if (cookie) headers["Cookie"] = cookie;
  }

  const method = opts.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(finalUrl, {
      method,
      headers,
      body,
      // Never forward authentication or cookies to redirect destinations.
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new NemligNetworkError("Nemlig API request failed", err);
  }

  if (opts.jar) opts.jar.storeFromResponse(response.headers);

  const isRedirect = response.status >= 300 && response.status < 400;
  if (isRedirect) {
    await response.body?.cancel();
    throw new NemligError("Nemlig API redirects are not allowed");
  }

  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

/** Parse a RawResponse as JSON, throwing NemligHttpError on non-2xx or invalid JSON. */
export function parseJson<T>(res: RawResponse, url: string): T {
  if (res.status < 200 || res.status >= 300) {
    throw new NemligHttpError(res.status, res.text.slice(0, 500), url);
  }
  if (res.text === "") return undefined as T;
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new NemligHttpError(res.status, `Invalid JSON: ${res.text.slice(0, 200)}`, url);
  }
}
