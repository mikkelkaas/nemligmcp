import { createRequire } from "node:module";

/**
 * The version from package.json, read at runtime so that the value is right
 * both for the published package/image (set by semantic-release) and for a
 * source checkout. Works from src/ and dist/ alike: both sit one level below
 * package.json.
 */
export const PACKAGE_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string })
  .version;
