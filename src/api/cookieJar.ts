/**
 * Minimal in-process cookie jar.
 *
 * `fetch` does not persist Set-Cookie between requests, so we read
 * `response.headers.getSetCookie()` (Node 20+/undici) and replay matching cookies
 * as a `Cookie:` header. Scope is a single origin (www.nemlig.com), so we keep a
 * flat name→value map and ignore Domain/Path nuances — sufficient for this API.
 *
 * If cookie edge cases ever arise, swap the internals here for `tough-cookie`
 * without changing callers.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  /** Absorb Set-Cookie headers from a response. */
  storeFromResponse(headers: Headers): void {
    // getSetCookie() returns each Set-Cookie header separately (unlike get()).
    const setCookies =
      typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    for (const raw of setCookies) {
      // First "name=value" segment before the first ";" is the cookie pair.
      const firstSegment = raw.split(";", 1)[0]?.trim();
      if (!firstSegment) continue;
      const eq = firstSegment.indexOf("=");
      if (eq <= 0) continue;
      const name = firstSegment.slice(0, eq).trim();
      const value = firstSegment.slice(eq + 1).trim();
      // An expired cookie (value cleared) removes it.
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(raw)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /** Build a `Cookie:` header value, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }

  clear(): void {
    this.cookies.clear();
  }
}
