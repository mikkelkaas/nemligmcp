import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { getOrderDetails, getOrderHistory } from "../api/orders.js";
import { getOrderDetailsShape, getOrderHistoryShape } from "../types/schemas.js";
import { tool } from "./helpers.js";

export function registerOrderTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "get_order_history",
    {
      title: "Get order history",
      description:
        "List the account's past orders (newest first), with skip/take paging. Each order has a " +
        "numeric `Id` (pass to get_order_details), an `OrderNumber`, `OrderDate`, `Total`/`SubTotal`, " +
        "delivery address and time, and `Status`/`DeliveryStatus` codes. Requires login " +
        "(NEMLIG_USER/NEMLIG_PASS).",
      inputSchema: getOrderHistoryShape,
    },
    tool("get_order_history", ({ skip, take }) => getOrderHistory(client, { skip, take })),
  );

  server.registerTool(
    "get_order_details",
    {
      title: "Get order details",
      description:
        "Fetch the full line items and totals of one past order by its numeric `Id` (from " +
        "get_order_history). Each line has a `ProductNumber` (usable as productId with add_to_basket, " +
        "so you can reorder past items), `ProductName`, `Quantity`, `Description` and `Amount`. " +
        "Requires login.",
      inputSchema: getOrderDetailsShape,
    },
    tool("get_order_details", ({ orderId }) => getOrderDetails(client, orderId)),
  );
}
