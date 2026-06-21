import { logger } from "../logger.js";
import { NemligError } from "../api/errors.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // The SDK's CallToolResult type carries an index signature; mirror it so our
  // handlers are assignable to registerTool's callback parameter.
  [key: string]: unknown;
}

function ok(data: unknown): ToolResult {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wrap a tool implementation so it always returns a valid MCP result and never
 * throws into the SDK. Typed Nemlig errors surface their message; anything else is
 * logged and reported generically.
 */
export function tool<A>(
  name: string,
  fn: (args: A) => Promise<unknown>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      if (err instanceof NemligError) {
        logger.warn(`tool ${name} failed`, { error: err.message });
        return fail(err.message);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`tool ${name} crashed`, { error: message });
      return fail(`Unexpected error: ${message}`);
    }
  };
}
