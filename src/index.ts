#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("nemligmcp connected on stdio");
}

main().catch((err) => {
  logger.error("fatal: failed to start nemligmcp", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
