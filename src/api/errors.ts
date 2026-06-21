/** Typed errors thrown by the API layer; tool handlers map these to MCP errors. */

export class NemligError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Authentication problem (e.g. login required, bad credentials, token failure). */
export class NemligAuthError extends NemligError {}

/** Non-2xx HTTP response from the API. */
export class NemligHttpError extends NemligError {
  constructor(
    public readonly status: number,
    public readonly bodyExcerpt: string,
    public readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}: ${bodyExcerpt}`);
  }
}

/** Network/transport failure (DNS, connection, timeout). */
export class NemligNetworkError extends NemligError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
  }
}
