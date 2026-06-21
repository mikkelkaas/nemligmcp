/**
 * Response shapes for the nemlig.com web API.
 *
 * The real responses are large and not fully documented; we type the fields we
 * actually rely on and keep an index signature so the full payload passes through
 * untouched. Tool handlers return the raw JSON, so these types are mostly for the
 * internal API layer's safety, not an exhaustive contract.
 */

export interface AntiForgeryResponse {
  Header: string;
  Value: string;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  [key: string]: unknown;
}

/** Login response — field names confirmed during implementation (see DeliveryZoneId/UserId). */
export interface LoginResponse {
  DeliveryZoneId?: number;
  UserId?: string;
  RedirectUrl?: string;
  [key: string]: unknown;
}

/** A single product as returned by the search gateway. */
export interface SearchProduct {
  Id?: string;
  Name?: string;
  Url?: string;
  Price?: number;
  UnitPrice?: string;
  Availability?: unknown;
  [key: string]: unknown;
}

export interface SearchResponse {
  Products?: { Products?: SearchProduct[]; NumFound?: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface BasketLine {
  Id?: string;
  ProductId?: string;
  Name?: string;
  Quantity?: number;
  Price?: number;
  [key: string]: unknown;
}

export interface Basket {
  Id?: string;
  Lines?: BasketLine[];
  TotalProductsPrice?: number;
  [key: string]: unknown;
}

/** Context needed to build search requests, derived from the session. */
export interface SearchContext {
  deliveryZoneId: string;
  timeslotUtc: string;
  timestamp: string;
  userId: string;
}
