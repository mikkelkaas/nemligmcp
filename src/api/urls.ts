import { BASE_URL, GATEWAY_URL } from "../config.js";
import { NemligError } from "./errors.js";

/** Validate before attaching any session headers or cookies. */
export function apiUrl(input: string, useCookies = false): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NemligError("Invalid Nemlig API URL");
  }
  if (
    ![BASE_URL, GATEWAY_URL].includes(url.origin) ||
    url.username || url.password || url.hash ||
    (useCookies && url.origin !== BASE_URL)
  ) {
    throw new NemligError("Unapproved Nemlig API destination");
  }
  return url;
}

/** Product tools must never double as arbitrary authenticated API requests. */
export function productPageUrl(input: string): string {
  if (input.includes("\\") || input.startsWith("//")) {
    throw new NemligError("Expected a Nemlig product page URL or path");
  }
  let url: URL;
  try {
    url = new URL(input, BASE_URL);
  } catch {
    throw new NemligError("Invalid product page URL");
  }
  apiUrl(url.href, true);
  // Nemlig's slug-id routes and the numeric-id/slug form supported by this tool.
  // Reject query strings, encoded paths, extra segments, and non-product routes.
  if (url.search || !/^\/(?:[a-z0-9][a-z0-9-]*-\d+|\d+\/[a-z0-9][a-z0-9-]*)\/?$/i.test(url.pathname)) {
    throw new NemligError("Expected a Nemlig product page URL or path");
  }
  return url.href;
}
