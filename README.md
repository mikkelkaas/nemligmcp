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
| `get_delivery_eta` | Check the homepage delivery status, estimated arrival and booked window. Requires login. |
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

## Streamable HTTP

stdio is the default. To serve several clients from one process (sharing a single
nemlig login), or to reach the server from claude.ai, ChatGPT and your phone, start it
with the Streamable HTTP transport. The same transport covers a trusted LAN (no secret)
and a public endpoint behind a reverse proxy (secret URL path). Each client gets its own
MCP session; all sessions share one nemlig login.

| Variable | Meaning | Default |
|---|---|---|
| `MCP_TRANSPORT` | `http` to serve HTTP; unset means stdio | unset |
| `--http` (CLI flag) | Alias for `MCP_TRANSPORT=http` | |
| `MCP_HTTP_HOST` | Bind address | `127.0.0.1` |
| `MCP_HTTP_PORT` | Port; falls back to `PORT`, then `3000` | `3000` |
| `MCP_SECRET` | If set, the endpoint is `/mcp/<secret>`; at least 32 characters | unset |
| `MCP_ALLOW_UNAUTHENTICATED` | `1` to allow a non-loopback bind with no secret | unset |

What happens at startup:

| Bind | `MCP_SECRET` | `MCP_ALLOW_UNAUTHENTICATED` | Result |
|---|---|---|---|
| loopback | unset | any | serves `/mcp`, Host/Origin guard on |
| loopback | set | any | serves `/mcp/<secret>`, Host/Origin guard on |
| non-loopback | set | any | serves `/mcp/<secret>` |
| non-loopback | unset | `1` | serves `/mcp`, logs a warning that the server is open |
| non-loopback | unset | unset | refuses to start |

`GET /healthz` returns `ok` in every mode. With a secret, every other path, including
bare `/mcp`, returns `404`.

### Local shared process

```bash
MCP_TRANSPORT=http npx -y nemligmcp
```

It listens on `http://127.0.0.1:3000/mcp` (change the port with `MCP_HTTP_PORT`). On a
loopback bind, requests whose `Host` or `Origin` is not localhost are rejected to block
DNS-rebinding attacks, and no secret is needed. To share it on a trusted LAN, set
`MCP_HTTP_HOST=0.0.0.0` and either `MCP_SECRET` or `MCP_ALLOW_UNAUTHENTICATED=1`;
without one of them the server refuses to start.

### Remote single-user endpoint

Web and mobile clients can't spawn a local process; they need a remote MCP server over
HTTPS. Run it with a secret path:

```bash
MCP_SECRET=$(openssl rand -hex 24) MCP_HTTP_HOST=0.0.0.0 \
  NEMLIG_USER=... NEMLIG_PASS=... npx -y nemligmcp --http
```

- MCP is served at `/mcp/<MCP_SECRET>` for POST, GET (SSE) and DELETE alike.
- The secret path is the **only** access control, and it guards your basket, orders
  and address. Use at least 32 random characters, serve it over HTTPS only, and keep
  it out of logs on the reverse proxy. The server itself never logs the secret.
- The secret is matched against the raw URL path, so it must consist of URL-safe
  characters (letters, digits, `-`, `_`, `.`, `~`). `openssl rand -hex 24` does.

### Docker behind Nginx Proxy Manager

The image `ghcr.io/mikkelkaas/nemligmcp` is built on every release for amd64 and arm64
(tags `latest`, the full version and the major version). `compose.yaml` pulls it and
joins the external `npm_default` network without publishing a host port. Put
`MCP_SECRET`, `NEMLIG_USER` and `NEMLIG_PASS` in `.env`, then:

```bash
docker compose pull && docker compose up -d
```

Add an NPM proxy host forwarding to `http://nemligmcp:3000` with SSL forced and this
advanced config:

```nginx
access_log off;
error_log /data/logs/proxy-host-<id>_error.log crit;
proxy_buffering off;
proxy_read_timeout 86400s;
```

- `access_log off` and an error log at `crit` keep the secret URL out of nginx's logs.
- `proxy_buffering off` and the long `proxy_read_timeout` keep the SSE stream flowing
  and open.

Don't put forward-auth (e.g. Authelia) in front of it: MCP clients can't follow a
browser login redirect.

### Connecting clients

- **Claude:** claude.ai → Settings → Connectors → *Add custom connector* → paste
  `https://your-host/mcp/<MCP_SECRET>`. It then also shows up in the mobile apps.
- **ChatGPT:** Settings → Apps & Connectors → Advanced → enable *Developer mode*,
  then create a connector with the same URL and authentication *No authentication*.

## Development

```bash
npm run dev        # run from source with auto-reload (tsx watch)
npm run typecheck  # tsc --noEmit
npm test           # run the test suite
npm run inspect    # launch the MCP Inspector against the server
```

## Releasing (maintainers)

Releases are fully automated from **[Conventional Commits](https://www.conventionalcommits.org)**
by [semantic-release](https://semantic-release.gitbook.io) (`.github/workflows/publish.yml`).
You never bump the version or tag by hand — just write commit messages in this form:

| Commit prefix | Example | Resulting release |
|---|---|---|
| `fix:` | `fix: handle empty basket` | patch (`0.1.0` → `0.1.1`) |
| `feat:` | `feat: add favorites tool` | minor (`0.1.0` → `0.2.0`) |
| `feat!:` / `BREAKING CHANGE:` in body | `feat!: drop Node 18` | major (`0.1.0` → `1.0.0`) |
| `chore:`, `docs:`, `refactor:`, `test:`, … | `docs: fix typo` | no release |

On every push to `master`, semantic-release looks at the commits since the last
release, picks the next version, updates `CHANGELOG.md` + `package.json`, tags the
commit, creates a GitHub Release, and publishes to npm (with provenance). Pushes
with no release-worthy commits are a no-op.

The `package.json` `version` is intentionally `0.0.0-development` — the real
version is managed by semantic-release at release time.

Required repo secret: `NPM_TOKEN` (Settings → Secrets and variables → Actions).
`GITHUB_TOKEN` is provided automatically by Actions.

## Notes / internals

- **Transport:** stdio by default; one Streamable HTTP transport (`MCP_TRANSPORT=http` or `--http`) with per-client sessions, serving either a trusted LAN or a secret-path public endpoint. The server logs only to stderr — stdout is the JSON-RPC channel in stdio mode.
- **Session:** a 3-step flow (anti-forgery token → bearer token → login) with transparent
  refresh of the short-lived (5 min) bearer token. Cookies are kept in-process.
- **Cookies:** handled by a minimal in-process jar using `fetch` + `Headers.getSetCookie()`
  (Node 20+). If you hit cookie edge cases, swap `src/api/cookieJar.ts` internals for
  `tough-cookie`.
- The codebase keeps the MCP server transport-agnostic (`src/server.ts`); `src/http.ts`
  builds one server per HTTP session on top of a shared `ApiClient`.
