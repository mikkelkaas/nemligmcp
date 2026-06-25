import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { registerSearchTools } from "./searchTools.js";
import { registerBasketTools } from "./basketTools.js";
import { registerDeliveryTools } from "./deliveryTools.js";
import { registerOrderTools } from "./orderTools.js";

export function registerAllTools(server: McpServer, client: ApiClient): void {
  registerSearchTools(server, client);
  registerBasketTools(server, client);
  registerDeliveryTools(server, client);
  registerOrderTools(server, client);
}
