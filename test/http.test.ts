import assert from "node:assert/strict";
import { request, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../src/api/client.js";
import { isLoopbackAddress, serveHttp, type HttpHandle as Server, type HttpOptions } from "../src/http.js";
import { createServer } from "../src/server.js";

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
const MCP_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const MAX_BODY = 64 * 1024;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Pending {
  req: ClientRequest;
  reply: Promise<Reply>;
}

function open(server: Server, method: string, headers: Record<string, string>, path = "/mcp"): Pending {
  const { address, port } = server.server.address() as AddressInfo;
  const req = request({ host: address, port, method, path, headers, agent: false });
  const reply = new Promise<Reply>((resolve, reject) => {
    req.setTimeout(3000, () => req.destroy(new Error(`${method} timed out`)));
    req.on("error", reject);
    req.on("response", (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("response aborted")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
  });
  return { req, reply };
}

async function send(
  server: Server,
  method: string,
  headers: Record<string, string>,
  body?: string,
  path = "/mcp",
): Promise<Reply> {
  const p = open(server, method, headers, path);
  p.req.end(body);
  try {
    return await p.reply;
  } finally {
    p.req.destroy();
  }
}

function rpcMessages(r: Reply): Array<Record<string, unknown>> {
  const type = String(r.headers["content-type"] ?? "");
  if (type.startsWith("application/json")) return [JSON.parse(r.body)].flat();
  return r.body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));
}

async function start(
  host: string,
  build: () => McpServer = () => new McpServer({ name: "test", version: "0" }),
  extra: Partial<HttpOptions> = {},
): Promise<Server | undefined> {
  try {
    return await serveHttp(build, {
      host,
      port: 0,
      maxBodyBytes: MAX_BODY,
      log: () => {},
      ...extra,
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EADDRNOTAVAIL" || code === "ENOTFOUND" || code === "EAFNOSUPPORT") return undefined;
    throw e;
  }
}

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const stop = (server: Server): Promise<void> => server.close();
const portOf = (server: Server): number => (server.server.address() as AddressInfo).port;
const hostOf = (server: Server, name = "localhost"): string => `${name}:${portOf(server)}`;

describe("isLoopbackAddress", () => {
  it("classifies loopback literals", () => {
    for (const a of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
      assert.ok(isLoopbackAddress(a), a);
    }
    for (const a of ["0.0.0.0", "::", "10.0.0.1", "localhost", "::ffff:10.0.0.1", "127.0.0.1.nip.io"]) {
      assert.ok(!isLoopbackAddress(a), a);
    }
  });
});

describe("healthz", () => {
  const get = (server: Server, method: string, host: string) => send(server, method, { Host: host }, undefined, "/healthz");

  it("answers 200 ok on a loopback bind", async () => {
    const server = (await start("127.0.0.1"))!;
    try {
      const r = await get(server, "GET", hostOf(server));
      assert.equal(r.status, 200);
      assert.equal(r.body, "ok");
      assert.match(String(r.headers["content-type"]), /^text\/plain/);
    } finally {
      await stop(server);
    }
  });

  it("ignores a hostile Host header", async () => {
    const server = (await start("127.0.0.1"))!;
    try {
      assert.equal((await get(server, "GET", "evil.com")).status, 200);
    } finally {
      await stop(server);
    }
  });

  it("is not affected by a configured secret", async () => {
    const server = (await start("127.0.0.1", undefined, { secret: "s".repeat(32) }))!;
    try {
      assert.equal((await get(server, "GET", hostOf(server))).status, 200);
    } finally {
      await stop(server);
    }
  });

  it("still 404s POST /healthz", async () => {
    const server = (await start("127.0.0.1"))!;
    try {
      assert.equal((await get(server, "POST", hostOf(server))).status, 404);
    } finally {
      await stop(server);
    }
  });
});

describe("loopback bind", () => {
  let server: Server;
  before(async () => {
    server = (await start("127.0.0.1"))!;
  });
  after(() => stop(server));

  const post = (headers: Record<string, string>, body = INIT) =>
    send(server, "POST", { ...MCP_HEADERS, ...headers }, body);

  it("rejects hostile Host headers", async () => {
    for (const host of [
      hostOf(server, "localhost.evil.com"),
      hostOf(server, "127.0.0.1.nip.io"),
      hostOf(server, "evil.com"),
      "LOCALHOST.EVIL.COM",
      "localhost@evil.com",
      "evil.com@localhost",
    ]) {
      assert.equal((await post({ Host: host })).status, 403, host);
    }
  });

  it("rejects hostile, null or malformed Origin", async () => {
    for (const origin of [
      "null",
      "http://evil.com",
      "http://localhost.evil.com:1234",
      "http://user@localhost",
      "http://localhost/path",
      "file://localhost",
    ]) {
      assert.equal((await post({ Host: hostOf(server), Origin: origin })).status, 403, origin);
    }
  });

  it("initializes for every loopback Host spelling, on any port, with or without Origin", async () => {
    for (const host of [
      hostOf(server),
      "localhost:1",
      "LOCALHOST:1",
      "localhost.",
      "127.0.0.1",
      "127.1.2.3:1",
      "[::1]:1",
      "[0:0:0:0:0:0:0:1]:1",
      "[::ffff:127.0.0.1]:1",
    ]) {
      const r = await post({ Host: host });
      assert.equal(r.status, 200, `${host} ${r.body}`);
    }
    assert.equal((await post({ Host: hostOf(server), Origin: "http://LocalHost:5173" })).status, 200);
  });

  it("accepts a body at the limit and rejects one byte more", async () => {
    const atLimit = " ".repeat(MAX_BODY - INIT.length) + INIT;
    assert.equal((await post({ Host: hostOf(server) }, atLimit)).status, 200);
    assert.equal((await post({ Host: hostOf(server) }, " " + atLimit)).status, 413);
  });

  it("answers malformed JSON with a JSON-RPC parse error", async () => {
    const r = await post({ Host: hostOf(server) }, "{");
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error.code, -32700);
  });

  it("returns 413 while an oversized chunked upload is still streaming", async () => {
    const p = open(server, "POST", { ...MCP_HEADERS, Host: hostOf(server) });
    try {
      p.req.write("x".repeat(MAX_BODY + 1));
      const r = await p.reply;
      assert.equal(r.status, 413);
      assert.ok(!p.req.writableEnded);
    } finally {
      p.req.destroy();
    }
  });

  it("returns 404 for a POST whose session was deleted while its body was in flight", async () => {
    const init = await post({ Host: hostOf(server) });
    const id = init.headers["mcp-session-id"] as string;
    const session = { Host: hostOf(server), "mcp-session-id": id, "mcp-protocol-version": "2025-03-26" };
    const p = open(server, "POST", { ...MCP_HEADERS, ...session });
    try {
      await new Promise<void>((resolve) => p.req.write('{"jsonrpc":"2.0","id":2,', () => resolve()));
      await sleep(100);
      assert.equal((await send(server, "DELETE", session)).status, 200);
      p.req.end('"method":"tools/list"}');
      assert.equal((await p.reply).status, 404);
    } finally {
      p.req.destroy();
    }
  });
});

describe("sessions", () => {
  it("serves tools/list to two concurrent sessions", async () => {
    const server = (await start("127.0.0.1", () => createServer({} as ApiClient)))!;
    try {
      const post = (headers: Record<string, string>, body: string) =>
        send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server), ...headers }, body);
      const inits = await Promise.all([post({}, INIT), post({}, INIT)]);
      const ids = inits.map((r) => {
        assert.equal(r.status, 200, r.body);
        const [msg] = rpcMessages(r);
        assert.equal(msg.id, 1);
        assert.ok(msg.result, r.body);
        return r.headers["mcp-session-id"] as string;
      });
      assert.notEqual(ids[0], ids[1]);

      const lists = await Promise.all(
        ids.map(async (id, i) => {
          const session = { "mcp-session-id": id, "mcp-protocol-version": "2025-03-26" };
          const ack = await post(session, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
          assert.equal(ack.status, 202, ack.body);
          return post(session, JSON.stringify({ jsonrpc: "2.0", id: 10 + i, method: "tools/list" }));
        }),
      );
      lists.forEach((r, i) => {
        assert.equal(r.status, 200, r.body);
        const [msg] = rpcMessages(r);
        assert.equal(msg.id, 10 + i);
        assert.equal(msg.error, undefined, r.body);
        const tools = (msg.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
        assert.ok(tools.includes("search_products"), tools.join(","));
      });
    } finally {
      await stop(server);
    }
  });
});

describe("loopback alias binds keep the guard", () => {
  for (const host of ["localhost", "LOCALHOST", "localhost.", "127.0.0.2", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
    it(host, async (t) => {
      const server = await start(host);
      if (!server) return t.skip(`cannot bind ${host}`);
      try {
        const r = await send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server, "evil.com") }, INIT);
        assert.equal(r.status, 403);
      } finally {
        await stop(server);
      }
    });
  }
});

describe("non-loopback bind", () => {
  it("does not check Host", async () => {
    const server = (await start("0.0.0.0", undefined, { allowUnauthenticated: true }))!;
    try {
      assert.equal((await send(server, "POST", { ...MCP_HEADERS, Host: "evil.com" }, INIT)).status, 200);
    } finally {
      await stop(server);
    }
  });

  it("refuses 0.0.0.0 without a secret or opt-out", async () => {
    const before = process.listenerCount("SIGTERM");
    await assert.rejects(start("0.0.0.0"), /MCP_ALLOW_UNAUTHENTICATED/);
    assert.equal(process.listenerCount("SIGTERM"), before);
  });

  it("accepts 0.0.0.0 with a secret and no opt-out", async () => {
    const server = (await start("0.0.0.0", undefined, { secret: SECRET }))!;
    try {
      assert.equal((await send(server, "POST", MCP_HEADERS, INIT, `/mcp/${SECRET}`)).status, 200);
    } finally {
      await stop(server);
    }
  });

  it("logs a warning when opted in", async () => {
    const lines: string[] = [];
    const server = (await start("0.0.0.0", undefined, { allowUnauthenticated: true, log: (m) => lines.push(m) }))!;
    try {
      assert.equal(lines.filter((l) => l.includes("without authentication")).length, 1);
    } finally {
      await stop(server);
    }
  });
});

describe("lifecycle", () => {
  it("removes signal handlers when listening fails", async () => {
    const baseline = process.listenerCount("SIGTERM");
    const server = (await start("127.0.0.1"))!;
    try {
      await assert.rejects(
        serveHttp(() => new McpServer({ name: "t", version: "0" }), {
          host: "127.0.0.1",
          port: portOf(server),
          log: () => {},
        }),
      );
      assert.equal(process.listenerCount("SIGTERM"), baseline + 1);
    } finally {
      await stop(server);
    }
    assert.equal(process.listenerCount("SIGTERM"), baseline);
  });

  it("close() ends open SSE streams and releases the listener", { timeout: 5000 }, async () => {
    const baseline = process.listenerCount("SIGTERM");
    const server = (await start("127.0.0.1"))!;
    const init = await send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server) }, INIT);
    const session = {
      Host: hostOf(server),
      Accept: "text/event-stream",
      "mcp-session-id": init.headers["mcp-session-id"] as string,
      "mcp-protocol-version": "2025-03-26",
    };
    const sse = open(server, "GET", session);
    sse.req.end();
    const opened = await new Promise<number>((resolve) =>
      sse.req.on("response", (res) => resolve(res.statusCode ?? 0)),
    );
    assert.equal(opened, 200);
    try {
      await server.close();
      await sse.reply;
      assert.equal(process.listenerCount("SIGTERM"), baseline);
    } finally {
      sse.req.destroy();
    }
  });
});

describe("secret path", () => {
  const at = `/mcp/${SECRET}`;
  const withSecret = async (fn: (server: Server) => Promise<void>, build?: () => McpServer): Promise<void> => {
    const server = (await start("127.0.0.1", build, { secret: SECRET }))!;
    try {
      await fn(server);
    } finally {
      await stop(server);
    }
  };
  const post = (server: Server, path: string, headers: Record<string, string> = {}, body = INIT) =>
    send(server, "POST", { ...MCP_HEADERS, Host: hostOf(server), ...headers }, body, path);

  it("initializes at /mcp/<secret>", () =>
    withSecret(async (server) => {
      const r = await post(server, at);
      assert.equal(r.status, 200, r.body);
    }));

  it("accepts a trailing slash", () =>
    withSecret(async (server) => {
      const r = await post(server, `${at}/`);
      assert.equal(r.status, 200, r.body);
    }));

  it("returns a bare 404 for /mcp", () =>
    withSecret(async (server) => {
      const r = await post(server, "/mcp");
      assert.equal(r.status, 404);
      assert.equal(r.body, "");
    }));

  it("returns a bare 404 for a wrong secret of the same length", () =>
    withSecret(async (server) => {
      const r = await post(server, `/mcp/${SECRET.slice(0, -1)}0`);
      assert.equal(r.status, 404);
      assert.equal(r.body, "");
    }));

  it("returns a bare 404 for a wrong secret of a different length", () =>
    withSecret(async (server) => {
      const r = await post(server, `/mcp/${SECRET}x`);
      assert.equal(r.status, 404);
      assert.equal(r.body, "");
    }));

  it("keeps the Host guard on a loopback bind", () =>
    withSecret(async (server) => {
      const r = await post(server, at, { Host: hostOf(server, "evil.com") });
      assert.equal(r.status, 403);
    }));

  it("serves tools/list through a session at the secret path", () =>
    withSecret(async (server) => {
      const init = await post(server, at);
      assert.equal(init.status, 200, init.body);
      const session = { "mcp-session-id": init.headers["mcp-session-id"] as string, "mcp-protocol-version": "2025-03-26" };
      const ack = await post(server, at, session, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
      assert.equal(ack.status, 202, ack.body);
      const list = await post(server, at, session, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
      assert.equal(list.status, 200, list.body);
      const [msg] = rpcMessages(list);
      const tools = (msg.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
      assert.ok(tools.includes("search_products"), tools.join(","));
    }, () => createServer({} as ApiClient)));

  it("logs the listen line without the secret", async () => {
    const lines: string[] = [];
    const server = (await start("127.0.0.1", undefined, { secret: SECRET, log: (m) => lines.push(m) }))!;
    try {
      const line = lines.find((l) => l.startsWith("listening on"))!;
      assert.ok(line.endsWith("/mcp/<MCP_SECRET>"), line);
      assert.ok(!lines.some((l) => l.includes(SECRET)));
    } finally {
      await stop(server);
    }
  });
});
