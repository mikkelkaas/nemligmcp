import { BASE_URL } from "../config.js";
import type { ApiClient } from "./client.js";
import type { SearchContext } from "../types/nemlig.js";

interface AppSettings {
  CombinedProductsAndSitecoreTimestamp?: string;
  [key: string]: unknown;
}

interface PageSettings {
  Settings?: {
    TimeslotUtc?: string;
    DeliveryZoneId?: number;
    UserId?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Fallback timeslot used only if the page settings don't expose a selected slot. */
const FALLBACK_TIMESLOT = "2026062008-60-600";

/**
 * Fetch the values the search gateway requires: a Sitecore/products timestamp
 * (from AppSettings) and the current timeslot / delivery zone / user id (from the
 * homepage rendered as JSON). Both work anonymously (bearer only).
 */
export async function fetchSearchContext(client: ApiClient): Promise<SearchContext> {
  const appSettings = await client.call<AppSettings>(
    `${BASE_URL}/webapi/v2/AppSettings/Website`,
  );

  const page = await client.call<PageSettings>(`${BASE_URL}/`, {
    query: { GetAsJson: 1, d: 1 },
  });

  const settings = page?.Settings ?? {};
  return {
    timestamp: appSettings?.CombinedProductsAndSitecoreTimestamp ?? "",
    timeslotUtc: settings.TimeslotUtc || FALLBACK_TIMESLOT,
    deliveryZoneId: settings.DeliveryZoneId != null ? String(settings.DeliveryZoneId) : "1",
    userId: settings.UserId ? String(settings.UserId) : "",
  };
}
