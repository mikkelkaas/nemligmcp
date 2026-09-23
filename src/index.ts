#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ApiClient } from "./api/client.js";
import { loadConfig } from "./config.js";
import { httpOptionsFromEnv, serveHttp } from "./http.js";
import { createServer } from "./server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const http = httpOptionsFromEnv();
  if (http) {
    const config = loadConfig();
    logger.info("starting nemligmcp", { mode: config.hasCredentials ? "login" : "anonymous" });
    // One client per process so every HTTP session shares a single nemlig login.
    const client = new ApiClient(config);
    await serveHttp(() => createServer(client), { ...http, log: (msg) => logger.info(msg) });
    return;
  }

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
