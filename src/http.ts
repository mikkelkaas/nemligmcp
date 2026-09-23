import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BlockList, isIP, type AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

export interface HttpOptions {
  host: string;
  port: number;
  path?: string;
  idleTimeoutMs?: number;
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

export function httpOptionsFromEnv(): HttpOptions | undefined {
  if (process.env.MCP_TRANSPORT !== "http") return undefined;
  const port = Number(process.env.MCP_HTTP_PORT);
  if (!Number.isInteger(port) || port <= 0) throw new Error("MCP_TRANSPORT=http requires a valid MCP_HTTP_PORT");
  return { host: process.env.MCP_HTTP_HOST ?? "127.0.0.1", port };
}

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

/** True for any IPv4/IPv6 literal in 127.0.0.0/8, ::1 or ::ffff:127.0.0.0/104. */
export function isLoopbackAddress(address: string): boolean {
  const ip = address.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(ip);
  if (family === 0) return false;
  return loopback.check(ip, family === 6 ? "ipv6" : "ipv4");
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || isLoopbackAddress(name);
}

function parseHost(host: string | undefined): URL | undefined {
  if (!host || !/^[^\s/?#@\\]+$/.test(host)) return undefined;
  try {
    return new URL(`http://${host}`);
  } catch {
    return undefined;
  }
}

function parseOrigin(origin: string): URL | undefined {
  if (!/^https?:\/\/[^\s/?#@\\]+$/i.test(origin)) return undefined;
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
}

/** Rejects DNS-rebinding requests: Host and any Origin must name a loopback address, on any port. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  if (!isLoopbackHostname(parseHost(req.headers.host)?.hostname)) return false;
  const origin = req.headers.origin;
  return origin === undefined || isLoopbackHostname(parseOrigin(origin)?.hostname);
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > maxBytes) {
        req.off("data", onData).off("end", onEnd);
        chunks.length = 0;
        req.resume();
        reject(new HttpError(413, "Payload too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new HttpError(400, "Parse error", -32700));
      }
    };
    req.on("data", onData).on("end", onEnd).on("error", reject);
  });
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
  code = -32000,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

export interface HttpHandle {
  server: Server;
  close(): Promise<void>;
}

export async function serveHttp(buildServer: () => McpServer, opts: HttpOptions): Promise<HttpHandle> {
  const path = opts.path ?? "/mcp";
  const idleTimeoutMs = opts.idleTimeoutMs ?? 24 * 60 * 60 * 1000;
  const maxBodyBytes = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  const log = opts.log ?? ((msg: string) => console.error(msg));
  const sessions = new Map<string, Session>();
  let validateHost = true;
  let closing = false;

  const closeSession = (id: string): void => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    void s.transport.close().catch(() => {});
    void s.server.close().catch(() => {});
  };

  const sweeper = setInterval(
    () => {
      const cutoff = Date.now() - idleTimeoutMs;
      for (const [id, s] of sessions) if (s.lastSeen < cutoff) closeSession(id);
    },
    10 * 60 * 1000,
  ).unref();

  const sessionFor = (sessionId: string | string[] | undefined): Session | undefined =>
    typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

  const handlePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readJson(req, maxBodyBytes);
    const sessionId = req.headers["mcp-session-id"];
    const existing = sessionFor(sessionId);
    if (existing) {
      existing.lastSeen = Date.now();
      return await existing.transport.handleRequest(req, res, body);
    }
    if (sessionId !== undefined) return sendError(res, 404, "Session not found");
    const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    if (!isInit) return sendError(res, 400, "Bad Request: no valid session ID provided");
    if (closing) return sendError(res, 503, "Server is shutting down");

    const server = buildServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) closeSession(transport.sessionId);
    };
    const discard = (): void => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      discard();
      throw e;
    }
    if (!transport.sessionId || !sessions.has(transport.sessionId)) discard();
  };

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== path) return sendError(res, 404, "Not found");
      if (validateHost && !isLoopbackRequest(req)) return sendError(res, 403, "Forbidden host or origin");
      const canonicalHost = parseHost(req.headers.host)?.host;
      if (canonicalHost) req.headers.host = canonicalHost;

      if (req.method === "POST") return await handlePost(req, res);

      if (req.method === "GET" || req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"];
        const existing = sessionFor(sessionId);
        if (!existing) return sendError(res, sessionId === undefined ? 400 : 404, "Invalid or missing session ID");
        existing.lastSeen = Date.now();
        return await existing.transport.handleRequest(req, res);
      }

      res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
    } catch (e) {
      if (e instanceof HttpError) {
        return sendError(res, e.status, e.message, e.status === 413 ? { Connection: "close" } : {}, e.code);
      }
      log(`[http] request failed: ${e instanceof Error ? e.message : String(e)}`);
      sendError(res, 500, "Internal server error");
    }
  });

  const dispose = (): void => {
    closing = true;
    clearInterval(sweeper);
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    for (const id of [...sessions.keys()]) closeSession(id);
  };
  const close = (): Promise<void> => {
    dispose();
    return new Promise((resolve) => httpServer.close(() => resolve()));
  };
  function shutdown(): void {
    void close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  httpServer.once("close", dispose);

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(opts.port, opts.host, () => resolve());
    });
  } catch (e) {
    dispose();
    throw e;
  }
  const bound = httpServer.address() as AddressInfo;
  validateHost = isLoopbackAddress(bound.address);
  const shownHost = opts.host.includes(":") ? `[${opts.host}]` : opts.host;
  log(`listening on http://${shownHost}:${bound.port}${path}${validateHost ? "" : " (no Host/Origin check)"}`);
  return { server: httpServer, close };
}
