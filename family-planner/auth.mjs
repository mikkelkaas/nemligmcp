// auth.mjs — a logged-in Namlig web session for the two endpoints the MCP does not
// expose (recipe cards and the delivery-zone probe). It mirrors the three-step flow
// that nemligmcp uses internally, so both talk to the same API with the same account.
//
//   GET  /webapi/AntiForgery   -> XSRF token + cookies
//   GET  /webapi/Token         -> short-lived bearer token
//   POST /webapi/login         -> account cookies, DeliveryZoneId, UserId
//
// Credentials come from the same .env the MCP container reads (NEMLIG_USER,
// NEMLIG_PASS). Nothing here prints a credential or a token.
import { randomUUID } from "node:crypto";
import { loadEnv } from "./lib.mjs";

const BASE_URL = "https://www.nemlig.com";
const CLIENT_VERSION = "11.201.0";
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 4;

/** Browser-like headers the API expects. A real browser UA triggers the waiting room. */
function baseHeaders() {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "da-DK,da;q=0.9,en;q=0.8",
    "User-Agent": "nemlig-family-planner/1.0 (+https://github.com/mikkelkaas/nemligmcp)",
    "Device-Size": "desktop",
    Platform: "web",
    Version: CLIENT_VERSION,
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL,
  };
}

/** Minimal cookie jar: name -> value, fed from every Set-Cookie we see. */
function createJar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    storeFromResponse(headers) {
      const raw = typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [headers.get("set-cookie")].filter(Boolean);
      for (const line of raw) {
        const pair = String(line).split(";")[0];
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    has(name) {
      return cookies.has(name);
    },
  };
}

/** One HTTP call with cookies, JSON body and a hard timeout. Never throws on status. */
async function request(url, { method = "GET", json = undefined, jar = null, auth = null } = {}) {
  const headers = { ...baseHeaders(), "X-Correlation-Id": randomUUID() };
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth?.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (auth?.xsrf) headers["X-XSRF-TOKEN"] = auth.xsrf;
  if (jar) {
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let response;
  let current = url;
  try {
    for (let hop = 0; ; hop++) {
      response = await fetch(current, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        redirect: "manual",
        signal: ctrl.signal,
      });
      if (jar) jar.storeFromResponse(response.headers);
      const location = response.headers.get("location");
      const redirect = response.status >= 300 && response.status < 400 && location && method === "GET";
      if (redirect && hop < MAX_REDIRECTS) {
        current = new URL(location, current).toString();
        continue;
      }
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let body;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

function needJson(res, url) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${url} returned HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
  if (res.body === undefined) throw new Error(`${url} returned no body`);
  return res.body;
}

/**
 * Log in and return a session. The session can call any /webapi/ endpoint with
 * `session.post(path, body)` or `session.get(path)`, both authenticated.
 */
export async function login(env = loadEnv()) {
  const username = env.NEMLIG_USER;
  const password = env.NEMLIG_PASS;
  if (!username || !password) {
    throw new Error("NEMLIG_USER / NEMLIG_PASS missing from the .env the MCP container reads");
  }
  const jar = createJar();

  const antiForgery = needJson(await request(`${BASE_URL}/webapi/AntiForgery`, { jar }), "AntiForgery");
  const xsrf = antiForgery.Value || antiForgery.value || antiForgery.token;
  if (!xsrf) throw new Error("AntiForgery returned no token");

  const token = needJson(
    await request(`${BASE_URL}/webapi/Token`, { jar, auth: { xsrf } }),
    "Token",
  );
  const bearer = token.access_token || token.Access_Token || token.Access_token;
  if (!bearer) throw new Error("Token endpoint returned no access_token");

  const auth = { bearer, xsrf };
  const logged = await request(`${BASE_URL}/webapi/login`, {
    method: "POST",
    jar,
    auth,
    json: {
      Username: username,
      Password: password,
      CheckForExistingProducts: true,
      DoMerge: true,
      AppInstalled: false,
      SaveExistingBasket: false,
    },
  });
  if (logged.status === 401 || logged.status === 403) {
    throw new Error("Login failed: invalid nemlig.com credentials in the .env");
  }
  const account = logged.body ?? {};

  return {
    deliveryZoneId: account.DeliveryZoneId == null ? null : String(account.DeliveryZoneId),
    userId: account.UserId == null ? null : String(account.UserId),
    /** GET a /webapi/ path. */
    get: (path) => request(`${BASE_URL}${path}`, { jar, auth }),
    /** POST a JSON body to a /webapi/ path. */
    post: (path, json) => request(`${BASE_URL}${path}`, { method: "POST", jar, auth, json }),
    /** GET an absolute URL on the shop's API gateway, with the same session and token. */
    getUrl: (url) => request(url, { jar, auth }),
  };
}
