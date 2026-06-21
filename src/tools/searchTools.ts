import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { getProductDetails, quickSearch, searchProducts } from "../api/search.js";
import {
  getProductDetailsShape,
  quickSearchShape,
  searchProductsShape,
} from "../types/schemas.js";
import { tool } from "./helpers.js";

export function registerSearchTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "search_products",
    {
      title: "Search products",
      description:
        "Search the nemlig.com catalog. Returns products with id, name, price, unit and " +
        "availability. Use the product id with the basket tools and the product URL with " +
        "get_product_details. Works without login.",
      inputSchema: searchProductsShape,
    },
    tool("search_products", (args) => searchProducts(client, args)),
  );

  server.registerTool(
    "quick_search",
    {
      title: "Quick search (autocomplete)",
      description:
        "Fast autocomplete: suggestions and category hints for a partial query. Lighter " +
        "than search_products. Works without login.",
      inputSchema: quickSearchShape,
    },
    tool("quick_search", ({ query }) => quickSearch(client, query)),
  );

  server.registerTool(
    "get_product_details",
    {
      title: "Get product details",
      description:
        "Detailed info for a single product given its URL/path from a search result: " +
        "price, brand, description, declarations, images and availability. Works without login.",
      inputSchema: getProductDetailsShape,
    },
    tool("get_product_details", ({ productUrl }) => getProductDetails(client, productUrl)),
  );
}
