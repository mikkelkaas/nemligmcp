import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient } from "./api/client.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import { registerAllTools } from "./tools/index.js";

/**
 * Build a fully configured MCP server. Transport-agnostic: the caller wires up
 * stdio (or, later, HTTP) and connects it.
 */
export function createServer(): McpServer {
  const config = loadConfig();
  logger.info("starting nemligmcp", {
    mode: config.hasCredentials ? "login" : "anonymous",
  });

  const client = new ApiClient(config);

  const server = new McpServer({
    name: "nemligmcp",
    version: "0.1.0",
  });

  registerAllTools(server, client);
  return server;
}
