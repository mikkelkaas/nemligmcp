import { BASE_URL, type Config } from "../config.js";
import { logger } from "../logger.js";
import { CookieJar } from "./cookieJar.js";
import { NemligAuthError } from "./errors.js";
import { parseJson, rawRequest } from "./http.js";
import type {
  AntiForgeryResponse,
  LoginResponse,
  TokenResponse,
} from "../types/nemlig.js";

/** Refresh the bearer this many ms before its stated expiry. */
const REFRESH_SKEW_MS = 30_000;

/**
 * Owns authentication state for the process: the cookie jar, the short-lived
 * bearer token, the XSRF token, and the cached delivery zone / user id.
 *
 * Two modes:
 *  - login (credentials present): runs the full 3-step flow.
 *  - anonymous (no credentials): runs only AntiForgery + Token to obtain a bearer
 *    for product search. Basket access throws NemligAuthError.
 */
export class Session {
  readonly jar = new CookieJar();

  private bearer?: string;
  private bearerExpiresAt = 0;
  private xsrfToken?: string;
  private loggedIn = false;

  deliveryZoneId = "";
  userId = "";

  /** Mutex so concurrent tool calls share a single in-flight auth attempt. */
  private inFlight?: Promise<void>;

  constructor(private readonly config: Config) {}

  get isLoginMode(): boolean {
    return this.config.hasCredentials;
  }

  /** True once a valid (non-expired) bearer is held. */
  private hasFreshBearer(): boolean {
    return !!this.bearer && Date.now() < this.bearerExpiresAt - REFRESH_SKEW_MS;
  }

  /**
   * Ensure the session is ready for an authenticated request. Idempotent and
   * mutex-guarded. Refreshes only the bearer when the rest of the session is intact.
   */
  async ensureSession(): Promise<void> {
    if (this.loggedIn && this.hasFreshBearer()) return;
    if (this.isLoginMode === false && this.hasFreshBearer() && this.xsrfToken) return;

    if (this.inFlight) {
      await this.inFlight;
      // Re-check after awaiting a shared attempt; it may have failed.
      if (this.hasFreshBearer()) return;
    }

    this.inFlight = this.establish();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async establish(): Promise<void> {
    // If we already logged in and only the bearer lapsed, just re-token.
    if ((this.loggedIn || (!this.isLoginMode && this.xsrfToken)) && this.xsrfToken) {
      await this.fetchToken();
      if (this.hasFreshBearer()) return;
    }

    await this.fetchAntiForgery();
    await this.fetchToken();

    if (this.isLoginMode) {
      await this.login();
    } else {
      logger.info("session: anonymous mode (no credentials; basket disabled)");
    }
  }

  /** Step 1: anti-forgery (XSRF) token + cookies. */
  private async fetchAntiForgery(): Promise<void> {
    const url = `${BASE_URL}/webapi/AntiForgery`;
    const res = await rawRequest(url, { jar: this.jar });
    const body = parseJson<AntiForgeryResponse>(res, url);
    if (!body?.Value) throw new NemligAuthError("AntiForgery returned no token");
    this.xsrfToken = body.Value;
    logger.debug("session: got XSRF token");
  }

  /** Step 2: bearer token. */
  private async fetchToken(): Promise<void> {
    const url = `${BASE_URL}/webapi/Token`;
    const res = await rawRequest(url, {
      jar: this.jar,
      headers: this.xsrfToken ? { "X-XSRF-TOKEN": this.xsrfToken } : {},
    });
    const body = parseJson<TokenResponse>(res, url);
    if (!body?.access_token) throw new NemligAuthError("Token endpoint returned no access_token");
    this.bearer = body.access_token;
    const expiresInMs = (body.expires_in ?? 300) * 1000;
    this.bearerExpiresAt = Date.now() + expiresInMs;
    logger.debug("session: got bearer token", { expiresInMs });
  }

  /** Step 3: login (login mode only). */
  private async login(): Promise<void> {
    const creds = this.config.credentials;
    if (!creds) throw new NemligAuthError("login called without credentials");

    const url = `${BASE_URL}/webapi/login`;
    const res = await rawRequest(url, {
      method: "POST",
      jar: this.jar,
      headers: this.authHeaders(),
      json: {
        Username: creds.username,
        Password: creds.password,
        CheckForExistingProducts: true,
        DoMerge: true,
        AppInstalled: false,
        SaveExistingBasket: false,
      },
    });

    if (res.status === 401 || res.status === 403) {
      throw new NemligAuthError("Login failed: invalid nemlig.com credentials");
    }
    const body = parseJson<LoginResponse>(res, url);

    this.deliveryZoneId =
      body?.DeliveryZoneId != null ? String(body.DeliveryZoneId) : this.deliveryZoneId;
    this.userId = body?.UserId != null ? String(body.UserId) : this.userId;
    this.loggedIn = true;
    logger.info("session: logged in", {
      deliveryZoneId: this.deliveryZoneId || "(unknown)",
      hasUserId: !!this.userId,
    });
  }

  /** Headers required for authenticated requests. */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.bearer) headers["Authorization"] = `Bearer ${this.bearer}`;
    if (this.xsrfToken) headers["X-XSRF-TOKEN"] = this.xsrfToken;
    return headers;
  }

  /** Force the next ensureSession() to re-fetch a bearer (used on 401 retry). */
  invalidateBearer(): void {
    this.bearerExpiresAt = 0;
  }

  /** Throw unless the session is a logged-in account (for basket operations). */
  requireLogin(): void {
    if (!this.isLoginMode) {
      throw new NemligAuthError(
        "This action requires login. Set NEMLIG_USER and NEMLIG_PASS to use basket tools.",
      );
    }
  }
}
