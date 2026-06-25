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
  /** The reserved delivery slot, set by select_timeslot; `Reserved` is the key flag. */
  DeliveryTimeSlot?: {
    Id?: number;
    Date?: string;
    StartTime?: string;
    EndTime?: string;
    Reserved?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** A single bookable delivery timeslot from GetDeliveryDays. */
export interface DeliveryTimeslot {
  /** Numeric id passed to reserveTimeslot (distinct from SearchContext.timeslotUtc). */
  Id?: number;
  Date?: string;
  StartHour?: number;
  EndHour?: number;
  NumberOfHours?: number;
  DeliveryPrice?: number;
  Deadline?: string;
  /** 0 = Available, 1 = PastDeadline, 2 = SoldOut, 3 = NotActive. */
  Availability?: number;
  IsSelected?: boolean;
  [key: string]: unknown;
}

/** Response of GetDeliveryDays: slots grouped by day plus the current selection. */
export interface DeliveryDaysResponse {
  DayRangeHours?: { DayHours?: DeliveryTimeslot[]; [key: string]: unknown }[];
  SelectedTimeSlotId?: number | null;
  SelectedDeliveryTime?: string | null;
  IsTimeSlotReserved?: boolean;
  [key: string]: unknown;
}

/** Response of (Try)UpdateDeliveryTime. `IsReserved` reports whether the slot was taken. */
export interface ReserveTimeslotResponse {
  IsReserved?: boolean;
  [key: string]: unknown;
}

/** Context needed to build search requests, derived from the session. */
export interface SearchContext {
  deliveryZoneId: string;
  timeslotUtc: string;
  timestamp: string;
  userId: string;
}
