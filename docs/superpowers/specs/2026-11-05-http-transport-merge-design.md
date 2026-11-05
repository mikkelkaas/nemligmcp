# HTTP transport: merge PR #1 with the remote single-user mode

Date: 2026-11-05
Status: approved design, not yet implemented

## Intent

nemligmcp currently speaks MCP over stdio only. Two independent HTTP
implementations exist:

- **PR #1** (`streamable-http` branch, by Mikkel Eskildsen, opened
  2026-09-23): a stateful Streamable HTTP server for sharing one process and
  one nemlig.com login between several *local* MCP clients. Loopback bind by
  default, Host/Origin guard against DNS rebinding, no authentication of its
  own, session management, body limit, graceful shutdown, node:test suite.
- **Uncommitted work in the maintainer's tree** (`src/http.ts`, Dockerfile,
  compose.yaml, README section): a stateless server at `POST /mcp/<secret>`
  meant to run on a VPS behind Nginx Proxy Manager so claude.ai, ChatGPT and
  mobile apps can use it. This is already deployed at
  `https://nemlig.kaasfrich.dk` and works.

The goal is **one HTTP transport that serves both cases**: an unauthenticated
server on a trusted machine or LAN, and a single-user endpoint on the public
internet. PR #1's stateful transport is the base. The maintainer's stateless
`src/http.ts` is dropped; its secret-path access control, health endpoint,
packaging and docs are layered on top of PR #1's code.

## Why this shape

- Web clients (claude.ai custom connectors, ChatGPT developer-mode connectors)
  offer only "no authentication" or full OAuth 2.1. Neither can send a static
  header. A secret in the URL path is therefore the only practical access
  control short of running an OAuth server. The secret must be checked in the
  app, not only in the reverse proxy, so the container is not open to every
  other container on the shared Docker network.
- PR #1's stateful sessions are fine for the remote case: after a container
  restart a client gets 404 "Session not found" on its old session, and
  spec-compliant clients (claude.ai, ChatGPT, MCP Inspector) re-initialize
  transparently. There is no reason to replace that code with the stateless
  variant.
- A non-loopback bind without a secret must be an explicit choice. On PR #1's
  code a plain `MCP_HTTP_HOST=0.0.0.0` silently turns off the only guard it
  has; on a VPS that exposes the maintainer's basket and orders to the world.

## Goals

1. stdio remains the default transport, unchanged. `MCP_TRANSPORT` unset means
   stdio exactly as today.
2. `MCP_TRANSPORT=http` starts PR #1's server with PR #1's semantics
   (sessions, Host/Origin guard on loopback binds, 4 MB body limit with 413,
   idle sweep, SIGTERM/SIGINT shutdown).
3. `MCP_SECRET` set: the MCP endpoint is `/mcp/<secret>` instead of `/mcp`.
   Any other path, including `/mcp` and a wrong secret, answers 404 with an
   empty body (not a JSON-RPC error, so the response does not advertise what
   lives there). Comparison is constant-time. The secret must be at least 32
   characters; shorter values refuse to start. Works on any bind address.
4. Non-loopback bind without `MCP_SECRET`: refuse to start with a clear error
   unless `MCP_ALLOW_UNAUTHENTICATED=1` is set. Loopback binds need neither a
   secret nor the opt-out (PR #1's local case, unchanged).
5. `GET /healthz` returns `200 ok` in every HTTP mode, outside the secret path
   and outside the Host/Origin guard, for Docker health checks.
6. Packaging for the remote case ships in the repo: Dockerfile, compose.yaml,
   .dockerignore, and README instructions for Nginx Proxy Manager, claude.ai
   and ChatGPT.
7. PR #1's test suite keeps passing and gains cases for the secret path, the
   opt-out, and healthz. `npm test` runs in CI before build, as PR #1 added.
8. PR #1's commit is preserved in history (merge, not cherry-pick or
   reimplementation), and the contributor is told on the PR what was taken
   and where it landed.
9. GitHub Actions builds the container image and pushes it to
   `ghcr.io/mikkelkaas/nemligmcp` whenever semantic-release cuts a release,
   tagged `latest`, the full version and the major (`1.2.0`, `1`), for
   `linux/amd64` and `linux/arm64`. `compose.yaml` references that image so
   the server deploys by pulling, not building. The package is public; the
   maintainer flips visibility once in GitHub's package settings after the
   first push, since new packages default to private.

## Non-goals

- OAuth / OIDC. Authelia on the server is not involved; forward-auth must not
  be put in front of the endpoint since MCP clients cannot follow a browser
  login redirect.
- Multi-user: one process still means one nemlig.com login shared by all
  sessions. The secret identifies the deployment, not a user.
- Keeping two HTTP transports or a stateless mode.
- Rate limiting, request logging, or metrics.

## Anti-goals (would make this a failure even if it works)

- Breaking the published stdio behaviour or the `npx -y nemligmcp` config in
  any way.
- Making PR #1's local case need a secret, or need anything beyond at most one
  extra env var for the LAN case.
- An open server reachable on a non-loopback address without the operator
  having opted in by name.
- Logging the secret anywhere (app logs, nginx access log).

## Constraints

- Node 20+, TypeScript, `@modelcontextprotocol/sdk` as already pinned. No new
  runtime dependencies. One new dev dependency, `@semantic-release/exec`, to
  pass the released version from semantic-release to the image build step.
- Keep PR #1's file layout: `src/http.ts` (`serveHttp`, `httpOptionsFromEnv`,
  `HttpOptions`), `test/http.test.ts`, `src/server.ts` taking an optional
  shared `ApiClient`.
- Releases are semantic-release from Conventional Commits on `master`. The
  merged work lands as `feat:` so it releases as 1.2.0.
- Deployment target is the maintainer's server `alpha`: `~/docker/nemligmcp`,
  container `nemligmcp` on the external `npm_default` network, NPM proxy host
  id 41 for `nemlig.kaasfrich.dk` forwarding to `http://nemligmcp:3000`. The
  existing `.env` there already has `MCP_SECRET`, `NEMLIG_USER`, `NEMLIG_PASS`.

## Decisions already made

### Configuration surface (final)

| Variable | Meaning | Default |
|---|---|---|
| `MCP_TRANSPORT` | `http` to serve HTTP, anything else / unset is stdio | unset |
| `--http` (CLI flag) | Alias for `MCP_TRANSPORT=http`; kept because the README already documents it | |
| `MCP_HTTP_HOST` | Bind address | `127.0.0.1` |
| `MCP_HTTP_PORT` | Port. PR #1 required it; now falls back to `PORT`, then `3000` | `3000` |
| `MCP_SECRET` | If set, endpoint is `/mcp/<secret>`; min 32 chars | unset |
| `MCP_ALLOW_UNAUTHENTICATED` | `1` to allow a non-loopback bind with no secret | unset |

Startup decision table (HTTP mode):

| Bind | `MCP_SECRET` | `MCP_ALLOW_UNAUTHENTICATED` | Result |
|---|---|---|---|
| loopback | unset | any | serve `/mcp`, Host/Origin guard on |
| loopback | set | any | serve `/mcp/<secret>`, Host/Origin guard on |
| non-loopback | set | any | serve `/mcp/<secret>`, no Host/Origin guard |
| non-loopback | unset | `1` | serve `/mcp`, no guard, log a warning that the server is open |
| non-loopback | unset | unset | refuse to start, error names both ways out |

"Loopback" uses PR #1's `isLoopbackAddress` on the actually bound address,
as PR #1 already does for `validateHost`.

### Request handling order

1. `GET /healthz` is answered first, before path, host and session checks.
2. Path check: exact match against `/mcp` or `/mcp/<secret>`. A trailing
   slash is tolerated. Mismatch is a bare 404.
3. Then PR #1's existing flow: Host/Origin guard (when enabled), method
   dispatch, sessions.

Clients therefore use `https://host/mcp/<secret>` for POST, GET (SSE) and
DELETE alike; the secret is part of the single endpoint URL.

### Docker and proxy

- Dockerfile: multi-stage node:22-alpine, `npm ci`, runs as `node`, sets
  `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=0.0.0.0`, `PORT=3000`, health check on
  `/healthz`. No `MCP_SECRET` baked in; it comes from `.env`.
- Dockerfile carries `LABEL org.opencontainers.image.source=https://github.com/mikkelkaas/nemligmcp`
  so ghcr links the package to the repository.
- compose.yaml: `image: ghcr.io/mikkelkaas/nemligmcp:latest`, no `build`
  (no published port, joins `npm_default`, read-only root, cap_drop ALL,
  no-new-privileges, `init: true` so SIGTERM reaches node and PR #1's
  graceful shutdown runs). For the pre-merge check the image is built on
  alpha by hand under that same tag.
- Release workflow: after `npx semantic-release`, a step guarded by
  "a release happened" logs in to ghcr with `GITHUB_TOKEN`
  (`packages: write`), sets up QEMU and buildx, and builds and pushes the
  multi-arch image. The build runs from the workspace after semantic-release
  has updated `package.json`, so the image reports the released version.
  The version and the "released" flag reach the step through
  `@semantic-release/exec`'s `publishCmd` writing to `$GITHUB_OUTPUT`.
- NPM proxy host advanced config becomes:

  ```nginx
  access_log off;
  location = /mcp { return 404; }
  location /mcp/ {
      error_log /dev/null crit;
      proxy_buffering off;
      proxy_read_timeout 86400s;
      include conf.d/include/proxy.conf;
  }
  ```

  The read timeout is raised because PR #1 holds a standalone SSE stream per
  session that nginx would otherwise cut every 5 minutes; clients reconnect,
  so 300s is not broken, only noisy. The MCP location discards its
  error log (`error_log /dev/null crit;`) because nginx writes the full request
  line, secret included, on upstream errors; NPM already emits a server-level
  `error_log`, so a second server-level line would only add a logger, while a
  location-level one replaces the inherited one. The block keeps
  `include conf.d/include/proxy.conf` (NPM's proxy headers and `proxy_pass`);
  NPM's default `location /` stays, since only a bare `location /` replaces it. Force-SSL is turned on for host 41 as part of deployment.

### Process

1. Stash the uncommitted working tree (it conflicts with PR #1 and its
   useful parts are re-added by hand in step 2). `git switch -c
   http-transport master`; `git merge origin/pr-1`, where `origin/pr-1` is
   fetched from `refs/pull/1/head` (commit `822b89d`), since PR #1 comes from
   the fork `mikkelke/nemligmcp` and has no branch on origin. The merge is
   clean against committed master. The maintainer's `src/http.ts` is not
   carried over; README gets both the PR's local section and the
   maintainer's remote section.
2. Implement goals 3 to 7 as further commits on that branch, tests first.
3. Verify on alpha *before* merging to master: tag the running image
   (`docker tag nemligmcp:local nemligmcp:stateless-backup`) so the old
   deployment can be restored with one `docker compose up -d`, copy the
   branch tree to `~/docker/nemligmcp` (rsync, excluding `.git`, `.env`,
   `node_modules`, `dist`, `.claude`; the directory is a plain copy today,
   not a clone), build the image there under the ghcr tag, `docker compose
   up -d`, then check healthz, wrong-secret 404 and `tools/list` through
   `https://nemlig.kaasfrich.dk/mcp/<secret>`.
   The maintainer then reconnects claude.ai and ChatGPT and runs one tool
   call from each. If that fails, the merge is held, the backup image is
   restored, and the failure is brought back to the maintainer; nothing
   ships to npm in that state.
4. Patch NPM host 41: `ssl_forced: true` and the advanced config above.
5. Merge to `master` with a `feat:` message; semantic-release publishes
   1.2.0. GitHub marks PR #1 merged automatically once `822b89d` is
   reachable from master.
6. The maintainer makes the new ghcr package public. Then on alpha
   `docker compose pull && docker compose up -d` replaces the hand-built
   image with the released one; from then on the server directory only needs
   `compose.yaml` and `.env`, and redeploys are a pull.
7. Comment on PR #1: what was merged, what was added on top and why, the
   release on master.

## Left to the builder

- Exact wording of error messages and the startup log lines (the log line
  must never include the secret).
- How `--http` is parsed alongside `httpOptionsFromEnv` (simplest: treat the
  flag as setting `MCP_TRANSPORT=http` before reading env).
- Internal structure of the secret-path check inside `serveHttp` (an
  `HttpOptions.secret` field is the obvious route; `httpOptionsFromEnv`
  populates it).
- Test layout within `test/http.test.ts` (new `describe` blocks vs. a second
  file).
- Whether the README keeps PR #1's "local shared process" section and the
  maintainer's "remote mode" section as two subsections or one; both
  scenarios must be documented with their env vars.
- Order of commits on the branch.
