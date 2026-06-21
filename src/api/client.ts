import { logger } from "../logger.js";
import type { Config } from "../config.js";
import { NemligHttpError } from "./errors.js";
import { parseJson, rawRequest, type RawResponse, type RequestOptions } from "./http.js";
import { Session } from "./session.js";
import { fetchSearchContext } from "./settings.js";
import type { SearchContext } from "../types/nemlig.js";

export interface CallOptions extends Omit<RequestOptions, "jar" | "headers"> {
  headers?: Record<string, string>;
  /**
   * Whether to send the cookie jar with the request. Default true (www host).
   * Set false for the search gateway (different host, bearer-only).
   */
  useCookies?: boolean;
  /** Whether the request requires a logged-in account (basket ops). */
  requireLogin?: boolean;
}

/**
 * Authenticated HTTP client. Single chokepoint that ensures the session is ready,
 * injects auth headers, and retries once on 401 (stale bearer) and 429 (rate limit).
 */
export class ApiClient {
  readonly session: Session;
  private searchContext?: SearchContext;

  constructor(config: Config) {
    this.session = new Session(config);
  }

  /** Perform an authenticated request and parse the JSON body. */
  async call<T>(url: string, opts: CallOptions = {}): Promise<T> {
    const { useCookies = true, requireLogin = false, headers, ...rest } = opts;
    if (requireLogin) this.session.requireLogin();

    const exec = async (): Promise<RawResponse> => {
      await this.session.ensureSession();
      return rawRequest(url, {
        ...rest,
        headers: { ...this.session.authHeaders(), ...headers },
        jar: useCookies ? this.session.jar : undefined,
      });
    };

    let res = await exec();

    // Retry once on a stale bearer.
    if (res.status === 401) {
      logger.warn("client: 401, refreshing bearer and retrying once", { url });
      this.session.invalidateBearer();
      res = await exec();
    }

    // Retry once on rate limiting, honoring Retry-After.
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
      logger.warn("client: 429, backing off then retrying once", { url, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      res = await exec();
    }

    return parseJson<T>(res, url);
  }

  /**
   * The context (timestamp, timeslot, zone, user id) the search gateway requires.
   * Lazily fetched from app/page settings and cached for the process lifetime —
   * these change rarely and a stale value only risks a 500 we'd surface anyway.
   */
  async getSearchContext(): Promise<SearchContext> {
    if (!this.searchContext) {
      this.searchContext = await fetchSearchContext(this);
    }
    return this.searchContext;
  }
}

export { NemligHttpError };
