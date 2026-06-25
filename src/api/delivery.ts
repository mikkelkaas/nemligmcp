import { BASE_URL } from "../config.js";
import type { ApiClient } from "./client.js";
import type { DeliveryDaysResponse, ReserveTimeslotResponse } from "../types/nemlig.js";

/**
 * Delivery timeslot selection.
 *
 * Two endpoints back the website's timeslot picker:
 *  - GetDeliveryDays lists the bookable slots (grouped by day) for the session's
 *    delivery zone. Works anonymously (returns the default zone's slots).
 *  - (Try)UpdateDeliveryTime reserves a slot for the current basket by its numeric
 *    `timeslotId` (the `Id` field from GetDeliveryDays, NOT the `TimeslotUtc`
 *    string). Reserving touches the basket, so it requires login.
 */

export interface GetDeliveryDaysParams {
  /** ISO date (YYYY-MM-DD) of the first day to list. Omit to start from today. */
  startDate?: string;
  /** Number of days to return. Defaults to the website's 8. */
  days?: number;
  /** Whether to list slots eligible for subscription orders. */
  showForSubscriptions?: boolean;
}

/**
 * List bookable delivery days and their timeslots for the session's delivery zone.
 * Each slot carries an `Id` (used to reserve), `Date`, `StartHour`/`EndHour`,
 * `DeliveryPrice`, `Deadline` and an `Availability` code (0 = Available,
 * 1 = PastDeadline, 2 = SoldOut, 3 = NotActive). Works anonymously.
 */
export async function getDeliveryDays(
  client: ApiClient,
  params: GetDeliveryDaysParams = {},
): Promise<DeliveryDaysResponse> {
  return client.call<DeliveryDaysResponse>(`${BASE_URL}/webapi/v2/Delivery/GetDeliveryDays`, {
    query: {
      // The website literally sends "undefined" when no start date is chosen,
      // which the server reads as "start from today".
      startDate: params.startDate ?? "undefined",
      days: params.days ?? 8,
      showForSubscriptions: String(params.showForSubscriptions ?? false),
    },
  });
}

/**
 * Reserve a delivery timeslot for the current basket by its numeric id.
 *
 * `force: false` (default) calls TryUpdateDeliveryTime, which refuses the change
 * if it would alter the basket (e.g. products no longer available for the new
 * slot) and reports the diffs instead. `force: true` calls UpdateDeliveryTime,
 * which applies the change regardless. Inspect `IsReserved` on the response.
 * Requires login.
 */
export async function reserveTimeslot(
  client: ApiClient,
  timeslotId: number,
  force = false,
): Promise<ReserveTimeslotResponse> {
  const action = force ? "UpdateDeliveryTime" : "TryUpdateDeliveryTime";
  return client.call<ReserveTimeslotResponse>(`${BASE_URL}/webapi/Delivery/${action}`, {
    method: "POST",
    requireLogin: true,
    query: { timeslotId },
  });
}
