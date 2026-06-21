import { BASE_URL } from "../config.js";
import type { ApiClient } from "./client.js";
import type { Basket } from "../types/nemlig.js";

/**
 * All basket mutations go through a single endpoint: AddToBasket sets the
 * *absolute* quantity for a product (quantity 0 removes the line) and returns the
 * full updated basket. There is no separate Remove or ChangeQuantity endpoint, so
 * add / set / remove are all thin wrappers over `setQuantity`.
 */

/** Read the current basket. Requires login. */
export async function getBasket(client: ApiClient): Promise<Basket> {
  return client.call<Basket>(`${BASE_URL}/webapi/basket/GetBasket`, {
    requireLogin: true,
  });
}

/**
 * Set a product's absolute quantity in the basket (0 removes it). Returns the
 * updated basket from the AddToBasket response — no follow-up GetBasket needed.
 */
export async function setQuantity(
  client: ApiClient,
  productId: string,
  quantity: number,
): Promise<Basket> {
  return client.call<Basket>(`${BASE_URL}/webapi/basket/AddToBasket`, {
    method: "POST",
    requireLogin: true,
    json: {
      ProductId: productId,
      quantity,
      AffectPartialQuantity: false,
      disableQuantityValidation: false,
    },
  });
}

/** Remove a product entirely (quantity 0). */
export async function removeFromBasket(client: ApiClient, productId: string): Promise<Basket> {
  return setQuantity(client, productId, 0);
}

/** Empty the basket entirely. Returns the now-empty basket. */
export async function clearBasket(client: ApiClient): Promise<Basket> {
  return client.call<Basket>(`${BASE_URL}/webapi/basket/ClearBasket`, {
    method: "POST",
    requireLogin: true,
  });
}
