# nemligmcp

An [MCP](https://modelcontextprotocol.io) server for **nemlig.com** (Danish online
grocery delivery). It exposes the nemlig.com public web API to MCP clients (e.g. Claude)
as tools for **product search** and **basket management**.

> Unofficial. This talks to the same JSON endpoints the nemlig.com website uses. Use
> responsibly and at your own risk.

## Tools

| Tool | What it does |
|---|---|
| `search_products` | Full catalog search (name, price, unit, availability, product URL). |
| `quick_search` | Fast autocomplete suggestions + category hints. |
| `get_product_details` | Detailed info for one product by its URL/path from a search result. |
| `get_basket` | Show the current basket (line items + totals). |
| `add_to_basket` | Add a product at a given quantity. |
| `set_basket_quantity` | Set a product's absolute quantity (`0` removes it). |
| `remove_from_basket` | Remove a product from the basket. |

`search_products`, `quick_search` and `get_product_details` work **anonymously**. The
basket tools require login (see below).

## Setup

```bash
npm install
npm run build
```

## Authentication

Set credentials via environment variables:

- `NEMLIG_USER` — your nemlig.com email
- `NEMLIG_PASS` — your nemlig.com password

If both are omitted, the server runs in **anonymous mode**: product search works, but
basket tools return a "login required" error.

## Use with an MCP client

Add to your client's MCP config (stdio):

```json
{
  "mcpServers": {
    "nemlig": {
      "command": "node",
      "args": ["/home/mkf/projs/nemligmcp/dist/index.js"],
      "env": {
        "NEMLIG_USER": "you@example.com",
        "NEMLIG_PASS": "your-password"
      }
    }
  }
}
```

Omit `env` to run anonymously. For development without building, use
`"command": "npx", "args": ["tsx", "/home/mkf/projs/nemligmcp/src/index.ts"]`.

## Development

```bash
npm run dev        # run from source with auto-reload (tsx watch)
npm run typecheck  # tsc --noEmit
npm run inspect    # launch the MCP Inspector against the server
```

## Notes / internals

- **Transport:** stdio. The server logs only to stderr — stdout is the JSON-RPC channel.
- **Session:** a 3-step flow (anti-forgery token → bearer token → login) with transparent
  refresh of the short-lived (5 min) bearer token. Cookies are kept in-process.
- **Cookies:** handled by a minimal in-process jar using `fetch` + `Headers.getSetCookie()`
  (Node 20+). If you hit cookie edge cases, swap `src/api/cookieJar.ts` internals for
  `tough-cookie`.
- The codebase keeps the MCP server transport-agnostic (`src/server.ts`) so an HTTP
  transport can be added later without changing tool logic.
