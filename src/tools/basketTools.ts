import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { clearBasket, getBasket, removeFromBasket, setQuantity } from "../api/basket.js";
import {
  addToBasketShape,
  clearBasketShape,
  getBasketShape,
  removeFromBasketShape,
  setBasketQuantityShape,
} from "../types/schemas.js";
import { tool } from "./helpers.js";

export function registerBasketTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "get_basket",
    {
      title: "Get basket",
      description:
        "Show the current basket: line items (product id, name, quantity, price) and totals. " +
        "Requires login (NEMLIG_USER/NEMLIG_PASS).",
      inputSchema: getBasketShape,
    },
    tool("get_basket", () => getBasket(client)),
  );

  server.registerTool(
    "add_to_basket",
    {
      title: "Add to basket",
      description:
        "Add a product to the basket at the given quantity. Returns the updated basket. " +
        "Note: quantity is the absolute amount to set for this product, not an increment. " +
        "Requires login.",
      inputSchema: addToBasketShape,
    },
    tool("add_to_basket", ({ productId, quantity }) => setQuantity(client, productId, quantity)),
  );

  server.registerTool(
    "set_basket_quantity",
    {
      title: "Set basket quantity",
      description:
        "Set a product's absolute quantity in the basket. A quantity of 0 removes it. " +
        "Returns the updated basket. Requires login.",
      inputSchema: setBasketQuantityShape,
    },
    tool("set_basket_quantity", ({ productId, quantity }) =>
      setQuantity(client, productId, quantity),
    ),
  );

  server.registerTool(
    "remove_from_basket",
    {
      title: "Remove from basket",
      description:
        "Remove a product from the basket entirely. Returns the updated basket. Requires login.",
      inputSchema: removeFromBasketShape,
    },
    tool("remove_from_basket", ({ productId }) => removeFromBasket(client, productId)),
  );

  server.registerTool(
    "clear_basket",
    {
      title: "Clear basket",
      description:
        "Remove all products from the basket at once. Returns the now-empty basket. Requires login.",
      inputSchema: clearBasketShape,
    },
    tool("clear_basket", () => clearBasket(client)),
  );
}
