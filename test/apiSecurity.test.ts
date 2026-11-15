import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { ApiClient } from "../src/api/client.js";
import { CookieJar } from "../src/api/cookieJar.js";
import { rawRequest } from "../src/api/http.js";
import { getProductDetails } from "../src/api/search.js";

afterEach(() => mock.restoreAll());

describe("outbound authentication boundaries", () => {
  it("rejects unapproved destinations before making a request", async () => {
    const fetch = mock.method(globalThis, "fetch", async () => new Response("{}"));
    for (const url of [
      "https://collector.invalid/item", "http://www.nemlig.com/item",
      "http://127.0.0.1:9999/", "http://169.254.169.254/",
      "https://www.nemlig.com.evil.invalid/", "https://www.nemlig.com:8443/",
      "https://www.nemlig.com@evil.invalid/", "https://user:pass@www.nemlig.com/",
      "file:///etc/passwd", "https://www.nemlig.com/#fragment",
    ]) {
      await assert.rejects(rawRequest(url, { headers: { Authorization: "Bearer fake" } }), undefined, url);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("never sends the cookie jar to the search gateway", async () => {
    const fetch = mock.method(globalThis, "fetch", async () => new Response("{}"));
    await assert.rejects(rawRequest("https://webapi.prod.knl.nemlig.it/search", { jar: new CookieJar() }));
    assert.equal(fetch.mock.callCount(), 0);
  });

  it("preserves intended authentication for approved direct requests", async () => {
    const jar = new CookieJar();
    jar.storeFromResponse(new Headers({ "Set-Cookie": "session=fake; Path=/; Secure" }));
    const fetch = mock.method(globalThis, "fetch", async () => new Response("{}"));
    await rawRequest("https://www.nemlig.com/webapi/basket/GetBasket", {
      jar, headers: { Authorization: "Bearer fake" },
    });
    const opts = fetch.mock.calls[0].arguments[1] as RequestInit;
    assert.equal(new Headers(opts.headers).get("Authorization"), "Bearer fake");
    assert.equal(new Headers(opts.headers).get("Cookie"), "session=fake");
    assert.equal(opts.redirect, "manual");
    await rawRequest("https://webapi.prod.knl.nemlig.it/search", { headers: { Authorization: "Bearer fake" } });
    assert.equal(new Headers(fetch.mock.calls[1].arguments[1]?.headers).get("Cookie"), null);
  });

  it("does not follow external, downgrade, or same-origin redirects", async () => {
    for (const target of ["https://collector.invalid/", "http://www.nemlig.com/", "/webapi/order/GetBasicOrderHistory"]) {
      const fetch = mock.method(globalThis, "fetch", async () => new Response(null, {
        status: 302, headers: { Location: target },
      }));
      await assert.rejects(rawRequest("https://www.nemlig.com/product-123", {
        jar: new CookieJar(), headers: { Authorization: "Bearer fake" },
      }), /redirects are not allowed/);
      assert.equal(fetch.mock.callCount(), 1);
      fetch.mock.restore();
    }
  });
});

describe("product page restrictions", () => {
  it("rejects malicious URLs and non-product API routes before session setup", async () => {
    let touched = false;
    const client = { getSearchContext: async () => { touched = true; throw new Error("should not run"); } } as unknown as ApiClient;
    for (const url of [
      "https://collector.invalid/product-123", "//collector.invalid/product-123",
      "http://www.nemlig.com/product-123", "https://www.nemlig.com:8443/product-123",
      "/webapi/basket/ClearBasket", "/webapi/order/GetBasicOrderHistory",
      "/product-123?redirect=https://collector.invalid", "/product-123#fragment",
      "/product-123/extra", "/%77ebapi/product-123", "/product-123\\extra",
    ]) await assert.rejects(getProductDetails(client, url), undefined, url);
    assert.equal(touched, false);
  });

  it("allows product paths and same-origin absolute product URLs", async () => {
    for (const input of ["delemaelk-0-4-oeko-5601131", "/oekologisk-letmaelk-5012345", "/5012345/oekologisk-letmaelk", "https://www.nemlig.com/product-123"]) {
      let requested = "";
      const client = {
        getSearchContext: async () => ({ timeslotUtc: "fake" }),
        call: async (url: string) => { requested = url; return { ok: true }; },
      } as unknown as ApiClient;
      assert.deepEqual(await getProductDetails(client, input), { ok: true });
      assert.equal(new URL(requested).origin, "https://www.nemlig.com");
    }
  });
});
