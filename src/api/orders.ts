import { BASE_URL, GATEWAY_URL } from "../config.js";
import type { ApiClient } from "./client.js";
import type { OrderDetails, OrderHistoryResponse } from "../types/nemlig.js";

/**
 * Past-order access.
 *
 * Two endpoints back the website's "Ordrehistorik" page:
 *  - GetBasicOrderHistory lists past orders (summaries only) for the logged-in
 *    account, newest first, with skip/take paging. Each summary carries a numeric
 *    `Id` used to fetch the full detail.
 *  - GetOrderHistory/{id} returns one order's full line items and totals. The
 *    `ProductNumber` on each line is the product id usable with the basket tools,
 *    so this composes into a reorder workflow.
 *
 * Both require a logged-in account (bearer auth via the session).
 */

export interface GetOrderHistoryParams {
  /** Offset for paging. Defaults to 0. */
  skip?: number;
  /** Page size. Defaults to the website's 10. */
  take?: number;
}

/** List past orders (summaries) for the logged-in account, newest first. */
export async function getOrderHistory(
  client: ApiClient,
  params: GetOrderHistoryParams = {},
): Promise<OrderHistoryResponse> {
  return client.call<OrderHistoryResponse>(`${BASE_URL}/webapi/order/GetBasicOrderHistory`, {
    requireLogin: true,
    query: {
      skip: params.skip ?? 0,
      take: params.take ?? 10,
    },
  });
}

/**
 * Fetch the full detail (line items + totals) of one past order by its numeric
 * `Id` (the `Id` field from getOrderHistory, NOT the OrderNumber). Requires login.
 */
export async function getOrderDetails(
  client: ApiClient,
  orderId: number,
): Promise<OrderDetails> {
  return client.call<OrderDetails>(`${BASE_URL}/webapi/v2/order/GetOrderHistory/${orderId}`, {
    requireLogin: true,
  });
}

interface DeliveryInterval {
  start: string;
  end: string;
}

interface FeaturedOrder {
  orderStatus: string;
  deliveryTime?: string | null;
  deliveryInterval?: DeliveryInterval | null;
  timeslotInterval?: DeliveryInterval | null;
}

/** Delivery information shown on the signed-in homepage. */
export async function getDeliveryEta(client: ApiClient) {
  const result = await client.call<{ order: FeaturedOrder | null }>(
    `${GATEWAY_URL}/productbff/api/web/orderHistory/orders/featured`,
    { requireLogin: true, useCookies: false },
  );
  const order = result?.order;
  if (!order || order.orderStatus === "Reorder") return { order: null };

  return {
    order: {
      status: order.orderStatus,
      estimatedArrival: order.orderStatus === "EnRoute" ? order.deliveryTime ?? null : null,
      deliveredAt: order.orderStatus === "Delivered" ? order.deliveryTime ?? null : null,
      estimatedWindow: order.deliveryInterval ?? null,
      bookedWindow: order.timeslotInterval ?? null,
    },
  };
}
