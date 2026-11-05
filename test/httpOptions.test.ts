import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { httpOptionsFromEnv } from "../src/http.js";

const KEYS = ["MCP_TRANSPORT", "MCP_HTTP_HOST", "MCP_HTTP_PORT", "PORT", "MCP_SECRET", "MCP_ALLOW_UNAUTHENTICATED"];

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const http = { MCP_TRANSPORT: "http" };

describe("httpOptionsFromEnv", () => {
  it("returns undefined when MCP_TRANSPORT is unset, even with MCP_SECRET set", () => {
    assert.equal(withEnv({ MCP_SECRET: "s".repeat(48) }, httpOptionsFromEnv), undefined);
  });

  it("defaults host to 127.0.0.1 and port to 3000", () => {
    const o = withEnv(http, httpOptionsFromEnv);
    assert.equal(o?.host, "127.0.0.1");
    assert.equal(o?.port, 3000);
  });

  it("prefers MCP_HTTP_PORT over PORT", () => {
    assert.equal(withEnv({ ...http, MCP_HTTP_PORT: "4000", PORT: "5000" }, httpOptionsFromEnv)?.port, 4000);
  });

  it("falls back to PORT when MCP_HTTP_PORT is unset", () => {
    assert.equal(withEnv({ ...http, PORT: "5000" }, httpOptionsFromEnv)?.port, 5000);
  });

  it("throws 'invalid port' for PORT=''", () => {
    assert.throws(() => withEnv({ ...http, PORT: "" }, httpOptionsFromEnv), /invalid port/);
  });

  it("throws 'invalid port' for MCP_HTTP_PORT=abc", () => {
    assert.throws(() => withEnv({ ...http, MCP_HTTP_PORT: "abc" }, httpOptionsFromEnv), /invalid port/);
  });

  it("passes a 48-char MCP_SECRET through trimmed", () => {
    const secret = "k".repeat(48);
    assert.equal(withEnv({ ...http, MCP_SECRET: `  ${secret}\n` }, httpOptionsFromEnv)?.secret, secret);
  });

  it("throws 'MCP_SECRET must be at least 32 characters' for a 31-char secret", () => {
    const secret = "k".repeat(31);
    assert.throws(
      () => withEnv({ ...http, MCP_SECRET: secret }, httpOptionsFromEnv),
      (e: Error) => e.message.includes("MCP_SECRET must be at least 32 characters") && !e.message.includes(secret),
    );
  });

  it("treats MCP_SECRET='' as unset", () => {
    assert.equal(withEnv({ ...http, MCP_SECRET: "" }, httpOptionsFromEnv)?.secret, undefined);
    assert.equal(withEnv({ ...http, MCP_SECRET: "   " }, httpOptionsFromEnv)?.secret, undefined);
  });

  it("sets allowUnauthenticated only when MCP_ALLOW_UNAUTHENTICATED is exactly '1'", () => {
    assert.equal(withEnv({ ...http, MCP_ALLOW_UNAUTHENTICATED: "1" }, httpOptionsFromEnv)?.allowUnauthenticated, true);
    for (const v of ["true", "0", "", " 1"]) {
      assert.equal(withEnv({ ...http, MCP_ALLOW_UNAUTHENTICATED: v }, httpOptionsFromEnv)?.allowUnauthenticated, false);
    }
    assert.equal(withEnv(http, httpOptionsFromEnv)?.allowUnauthenticated, false);
  });
});
