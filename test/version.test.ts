import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_HEADERS } from "../src/config.js";
import { PACKAGE_VERSION } from "../src/version.js";

const packageVersion = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

describe("PACKAGE_VERSION", () => {
  it("is the version from package.json", () => {
    assert.ok(packageVersion.length > 0);
    assert.equal(PACKAGE_VERSION, packageVersion);
  });

  it("is what the User-Agent reports", () => {
    assert.ok(DEFAULT_HEADERS["User-Agent"].startsWith(`nemligmcp/${PACKAGE_VERSION} `));
  });
});
