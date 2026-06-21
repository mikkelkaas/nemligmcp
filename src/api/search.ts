import { randomUUID } from "node:crypto";
import { BASE_URL, SEARCH_URL } from "../config.js";
import type { ApiClient } from "./client.js";
import type { SearchResponse } from "../types/nemlig.js";

export interface SearchParams {
  query: string;
  take?: number;
  skip?: number;
  recipeCount?: number;
}

/** Full catalog search via the search gateway (bearer-only, cookieless host). */
export async function searchProducts(
  client: ApiClient,
  params: SearchParams,
): Promise<SearchResponse> {
  const ctx = await client.getSearchContext();
  return client.call<SearchResponse>(`${SEARCH_URL}/searchgateway/api/search`, {
    useCookies: false,
    query: {
      query: params.query,
      take: params.take ?? 20,
      skip: params.skip ?? 0,
      recipeCount: params.recipeCount ?? 3,
      timestamp: ctx.timestamp,
      timeslotUtc: ctx.timeslotUtc,
      deliveryZoneId: ctx.deliveryZoneId,
      includeFavorites: ctx.userId || undefined,
    },
  });
}

/** Fast autocomplete suggestions + category hints. */
export async function quickSearch(client: ApiClient, query: string): Promise<unknown> {
  return client.call<unknown>(`${SEARCH_URL}/searchgateway/api/quick`, {
    useCookies: false,
    query: { query, correlationId: randomUUID() },
  });
}

/**
 * Product detail page rendered as JSON. `productUrl` is the path/URL from a search
 * result (e.g. "/12345/some-product" or a full nemlig.com URL).
 */
export async function getProductDetails(client: ApiClient, productUrl: string): Promise<unknown> {
  const path = productUrl.startsWith("http")
    ? productUrl
    : `${BASE_URL}/${productUrl.replace(/^\/+/, "")}`;
  const ctx = await client.getSearchContext();
  return client.call<unknown>(path, {
    query: { GetAsJson: 1, t: ctx.timeslotUtc || undefined, d: 1 },
  });
}
