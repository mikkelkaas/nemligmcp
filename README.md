# nemligmcp

An [MCP](https://modelcontextprotocol.io) server for **nemlig.com** (Danish online
grocery delivery). It exposes the nemlig.com public web API to MCP clients (e.g. Claude)
as tools for **product search**, **basket management** and **order history**.

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
| `get_timeslots` | List bookable delivery timeslots for the coming days (id, date, hours, price, deadline, availability). |
| `select_timeslot` | Reserve a delivery timeslot for the basket by its numeric id. |
| `get_order_history` | List past orders (newest first, paged): id, order number, date, totals, delivery info, status. |
| `get_order_details` | Full line items + totals for one past order by its numeric id. |

`search_products`, `quick_search`, `get_product_details` and `get_timeslots` work
**anonymously**. The basket tools, `select_timeslot` and the order-history tools
require login (see below).

The order tools chain into a **reorder** flow: `get_order_history` → `get_order_details`
→ `add_to_basket` for each line (a line's `ProductNumber` is the basket product id).

After `select_timeslot`, the reserved slot shows up on `get_basket` (delivery
time/spot), so you can confirm it took.

## Example prompts

Once connected to an MCP client like Claude, you can ask things like:

**Search & products**
- "Search nemlig for organic bananas and show me the cheapest options."
- "What's the unit price on the oat milk you found?"
- "Find gluten-free pasta under 25 kr."

**Basket**
- "Add 2 of the økologisk letmælk to my basket."
- "What's in my basket right now and what's the total?"
- "Change the bananas to 3 and remove the chips."
- "Empty my basket."

**Delivery**
- "What delivery slots are available this weekend?"
- "Book the cheapest slot on Saturday."

**Order history & reordering**
- "Show me my last 5 orders with totals."
- "What did I buy in my most recent order?"
- "Reorder everything from my last delivery."
- "Add the wienerpølser and danskvand from my previous order back to the basket."

## Install

The easiest way is via `npx` — no clone or build needed, it always fetches the
latest published version:

```bash
npx -y nemligmcp
```

(See [Use with an MCP client](#use-with-an-mcp-client) below for wiring it into Claude etc.)

### From source

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

Add to your client's MCP config (stdio). Using the published package via `npx`:

```json
{
  "mcpServers": {
    "nemlig": {
      "command": "npx",
      "args": ["-y", "nemligmcp"],
      "env": {
        "NEMLIG_USER": "you@example.com",
        "NEMLIG_PASS": "your-password"
      }
    }
  }
}
```

Omit `env` to run anonymously. To run from a local build instead, use
`"command": "node", "args": ["/path/to/nemligmcp/dist/index.js"]`, or for
development without building, `"command": "npx", "args": ["tsx", "/path/to/nemligmcp/src/index.ts"]`.

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
