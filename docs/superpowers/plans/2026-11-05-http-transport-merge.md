# HTTP Transport Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge PR #1's stateful Streamable HTTP transport and add a secret-path mode, an explicit opt-out for open non-loopback binds, a health endpoint and Docker packaging, so the same transport serves a trusted LAN and a public endpoint behind Nginx Proxy Manager.

**Architecture:** PR #1's `serveHttp(buildServer, opts)` in `src/http.ts` stays the single HTTP server. New behaviour enters through two optional `HttpOptions` fields (`secret`, `allowUnauthenticated`) that `httpOptionsFromEnv()` fills from `MCP_SECRET` and `MCP_ALLOW_UNAUTHENTICATED`, plus a `/healthz` short-circuit at the top of the request handler. stdio is untouched.

**Tech Stack:** Node 22, TypeScript, `@modelcontextprotocol/sdk` 1.29.0 (locked), `node:test` via `tsx`, Docker Compose, Nginx Proxy Manager API.

**Spec:** `docs/superpowers/specs/2026-11-05-http-transport-merge-design.md`

## Global Constraints

- No new runtime dependencies.
- stdio behaviour and the `npx -y nemligmcp` config must not change; `MCP_TRANSPORT` unset means stdio.
- `MCP_SECRET` must be at least 32 characters; shorter values refuse to start.
- The secret must never appear in app logs or nginx logs; the listen log line prints `/mcp/<MCP_SECRET>` literally.
- A non-loopback bind with no secret refuses to start unless `MCP_ALLOW_UNAUTHENTICATED=1`.
- PR #1's commit `822b89d` must be reachable from `master` after the merge (merge, not cherry-pick).
- All commits use Conventional Commits; the final merge to master is `feat:`.
- The working tree's stateless `src/http.ts` is dropped, not merged.

## Review Focus

Inputs the spec implies but no PR #1 test covers, most likely to bite first. Each has its pinning test in the task named.

1. `MCP_SECRET` set but `MCP_TRANSPORT` unset: must still be stdio, not a silent HTTP start. Task 2.
2. `MCP_SECRET` set on a loopback bind: Host/Origin guard must still apply to the secret path. Task 4.
3. `GET /healthz` with a hostile Host header on a loopback bind: must answer 200, since Docker and uptime probes send arbitrary Host values. Task 3.
4. Request to bare `/mcp` while a secret is configured: must be a bare 404 with an empty body, not a JSON-RPC error that reveals an MCP server exists. Task 4.
5. `PORT` set to a non-integer (for example an empty string from a compose file): must fail at startup with a clear message rather than listen on NaN. Task 2.

---

### Task 1: Branch and merge PR #1

**Files:**
- Create: branch `http-transport` from `master`, merged with `origin/pr-1` (`822b89d`)
- Stash: `README.md`, `src/index.ts`, `src/server.ts`, `src/http.ts`, `Dockerfile`, `compose.yaml`, `.dockerignore`

**Interfaces:**
- Produces: PR #1's `src/http.ts` exports `serveHttp(buildServer: () => McpServer, opts: HttpOptions): Promise<HttpHandle>`, `httpOptionsFromEnv(): HttpOptions | undefined`, `isLoopbackAddress(address: string): boolean`, `interface HttpOptions { host: string; port: number; path?: string; idleTimeoutMs?: number; maxBodyBytes?: number; log?: (msg: string) => void }`, `interface HttpHandle { server: Server; close(): Promise<void> }`. `src/server.ts` exports `createServer(sharedClient?: ApiClient): McpServer`. Tests live in `test/http.test.ts` with helpers `start(host, build?)`, `send(server, method, headers, body?)`, `open(...)`, `hostOf(server, name?)`, `portOf(server)`, `stop(server)`, `rpcMessages(reply)`, constants `INIT`, `MCP_HEADERS`, `MAX_BODY`.

- [ ] **Step 1: Stash the uncommitted working tree, including the untracked files**

```bash
cd /home/mkf/projs/nemligmcp
git stash push -u -m "stateless http (pre-merge)" -- README.md src/index.ts src/server.ts src/http.ts Dockerfile compose.yaml .dockerignore
git status --short   # expect only ?? .codex/ and ?? docs/
```

- [ ] **Step 2: Commit the design doc and this plan on master**

```bash
git add docs/superpowers
git commit -m "docs: design and plan for merged HTTP transport"
```

- [ ] **Step 3: Create the branch and merge PR #1**

```bash
git fetch origin refs/pull/1/head:refs/remotes/origin/pr-1
git switch -c http-transport master
git merge --no-ff origin/pr-1 -m "merge: PR #1 opt-in Streamable HTTP transport"
```

Expected: clean merge, no conflict markers (`git diff --check` prints nothing).

- [ ] **Step 4: Verify PR #1 passes as merged**

Run: `npm ci && npm run typecheck && npm test`
Expected: typecheck silent; `# pass 18`, `# fail 0`.

---

### Task 2: Config surface: secret, opt-out, port fallback, `--http`

**Files:**
- Modify: `src/http.ts` (`HttpOptions`, `httpOptionsFromEnv`)
- Modify: `src/index.ts` (`--http` alias)
- Modify: `package.json` (`test` script glob)
- Create: `test/httpOptions.test.ts`

**Interfaces:**
- Produces: `HttpOptions` gains `secret?: string` and `allowUnauthenticated?: boolean`. `httpOptionsFromEnv()` reads `MCP_TRANSPORT`, `MCP_HTTP_HOST` (default `"127.0.0.1"`), `MCP_HTTP_PORT` then `PORT` then `3000`, `MCP_SECRET`, `MCP_ALLOW_UNAUTHENTICATED`. Throws `Error` with message containing `MCP_SECRET must be at least 32 characters` when the secret is non-empty and shorter than 32 (after trim), and `invalid port` when the chosen port is not a positive integer.

- [ ] **Step 1: Write the failing tests**

`test/httpOptions.test.ts`, each case saving and restoring `process.env` around the call:

```ts
describe("httpOptionsFromEnv", () => {
  it("returns undefined when MCP_TRANSPORT is unset, even with MCP_SECRET set");   // Review Focus 1
  it("defaults host to 127.0.0.1 and port to 3000");
  it("prefers MCP_HTTP_PORT over PORT");
  it("falls back to PORT when MCP_HTTP_PORT is unset");
  it("throws 'invalid port' for PORT=''");                                          // Review Focus 5
  it("throws 'invalid port' for MCP_HTTP_PORT=abc");
  it("passes a 48-char MCP_SECRET through trimmed");
  it("throws 'MCP_SECRET must be at least 32 characters' for a 31-char secret");
  it("treats MCP_SECRET='' as unset");
  it("sets allowUnauthenticated only when MCP_ALLOW_UNAUTHENTICATED is exactly '1'");
});
```

- [ ] **Step 2: Change the test script and run it to verify it fails**

`package.json`: `"test": "node --import tsx --test test/*.test.ts"`.
Run: `npm test`
Expected: the new file fails (`secret` / `allowUnauthenticated` undefined, `PORT` ignored); the 18 existing tests still pass.

- [ ] **Step 3: Implement in `src/http.ts`**

Extend `HttpOptions` and rewrite `httpOptionsFromEnv()` per the Interfaces block. Port resolution: `process.env.MCP_HTTP_PORT ?? process.env.PORT ?? "3000"`, then `Number(...)`, reject unless `Number.isInteger(port) && port > 0`.

- [ ] **Step 4: Add the `--http` alias in `src/index.ts`**

Before `httpOptionsFromEnv()`: `if (process.argv.includes("--http")) process.env.MCP_TRANSPORT = "http";`

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: `# pass 28`, `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/http.ts src/index.ts package.json test/httpOptions.test.ts
git commit -m "feat(http): read MCP_SECRET, MCP_ALLOW_UNAUTHENTICATED and PORT; add --http flag"
```

---

### Task 3: `GET /healthz`

**Files:**
- Modify: `src/http.ts` (request handler in `serveHttp`)
- Modify: `test/http.test.ts`

**Interfaces:**
- Produces: `GET /healthz` (and `HEAD`) answers `200`, `Content-Type: text/plain`, body `ok`, before the path check and before the Host/Origin guard. Other methods on `/healthz` fall through to the normal 404.

- [ ] **Step 1: Write the failing tests**

New `describe("healthz")` in `test/http.test.ts`, server started with `start("127.0.0.1")`:

```ts
it("answers 200 ok on a loopback bind", ...)                  // GET, Host: hostOf(server) → status 200, body "ok"
it("ignores a hostile Host header", ...)                      // GET, Host: "evil.com" → status 200   (Review Focus 3)
it("is not affected by a configured secret", ...)             // start with { secret: "s".repeat(32) }: GET /healthz → 200
it("still 404s POST /healthz", ...)                           // POST → 404
```

`start()` needs an optional third parameter `extra: Partial<HttpOptions> = {}` spread into the `serveHttp` opts; add it here, later tasks use it too.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the four new cases fail with 404 or 403.

- [ ] **Step 3: Implement**

First statement inside the `createServer(async (req, res) => { try {` block in `serveHttp`: if `url.pathname === "/healthz"` and method is `GET` or `HEAD`, `res.writeHead(200, { "Content-Type": "text/plain" }).end("ok")` and return.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat(http): add GET /healthz for container health checks"
```

---

### Task 4: Secret path mode

**Files:**
- Modify: `src/http.ts` (`serveHttp` path check and listen log line)
- Modify: `test/http.test.ts`

**Interfaces:**
- Produces: with `opts.secret` set, the endpoint is `` `${opts.path ?? "/mcp"}/${opts.secret}` ``; `/mcp`, a wrong secret, and any other path answer a bare `404` with empty body. The comparison uses `timingSafeEqual` on equal-length buffers. A single trailing slash is tolerated in both modes. The listen log reads `listening on http://<host>:<port>/mcp/<MCP_SECRET>` when a secret is set. Without a secret, behaviour is PR #1's except that a non-matching path is now also a bare 404 (builder's call: one code path).

- [ ] **Step 1: Write the failing tests**

New `describe("secret path")` in `test/http.test.ts`. `SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef"` (48 chars). Add a `path` parameter to `send`/`open` (default `"/mcp"`).

```ts
it("initializes at /mcp/<secret>", ...)                                    // POST INIT → 200
it("accepts a trailing slash", ...)                                        // POST /mcp/<secret>/ → 200
it("returns a bare 404 for /mcp", ...)                                     // status 404, body ""   (Review Focus 4)
it("returns a bare 404 for a wrong secret of the same length", ...)        // SECRET with last char changed → 404, body ""
it("returns a bare 404 for a wrong secret of a different length", ...)
it("keeps the Host guard on a loopback bind", ...)                         // Host: "evil.com" at the secret path → 403   (Review Focus 2)
it("serves tools/list through a session at the secret path", ...)          // init, notifications/initialized (202), tools/list (200, includes search_products), all at /mcp/<secret>, built with createServer({} as ApiClient)
it("logs the listen line without the secret", ...)                         // capture log; assert line ends with "/mcp/<MCP_SECRET>" and does not include SECRET
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: secret-path cases fail with 404 on the secret path; log case fails.

- [ ] **Step 3: Implement**

In `serveHttp`: compute `const basePath = opts.path ?? "/mcp"`. Add a local `function pathMatches(pathname: string): boolean` that strips one trailing slash, and then: no secret → `=== basePath`; secret → must start with `basePath + "/"` and the remainder, as a `Buffer`, has the secret's byte length and passes `timingSafeEqual`. Replace `if (url.pathname !== path) return sendError(res, 404, "Not found")` with `if (!pathMatches(url.pathname)) return void res.writeHead(404).end()`. Change the listen log to append `/mcp/<MCP_SECRET>` when `opts.secret` is set. Import `timingSafeEqual` from `node:crypto`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat(http): serve MCP at /mcp/<MCP_SECRET> when a secret is configured"
```

---

### Task 5: Refuse open non-loopback binds unless opted in

**Files:**
- Modify: `src/http.ts` (`serveHttp`, after `listen`)
- Modify: `test/http.test.ts` (existing "non-loopback bind" case, new cases)

**Interfaces:**
- Produces: after `listen()`, when `!isLoopbackAddress(bound.address) && !opts.secret && !opts.allowUnauthenticated`, `serveHttp` disposes, closes the listener and rejects with `Error("refusing to serve MCP without authentication on non-loopback <host>:<port>; set MCP_SECRET or MCP_ALLOW_UNAUTHENTICATED=1")`. When `allowUnauthenticated` is used, the listen log line is followed by a second line `warning: MCP is reachable without authentication on <host>:<port>`.

- [ ] **Step 1: Update and write the failing tests**

In the existing `describe("non-loopback bind")`, change `start("0.0.0.0")` to `start("0.0.0.0", undefined, { allowUnauthenticated: true })`. Add:

```ts
it("refuses 0.0.0.0 without a secret or opt-out", ...)   // assert.rejects(start("0.0.0.0"), /MCP_ALLOW_UNAUTHENTICATED/); then assert the port is free (a second start on the same port succeeds) and process.listenerCount("SIGTERM") is back to baseline
it("accepts 0.0.0.0 with a secret and no opt-out", ...)  // start("0.0.0.0", undefined, { secret: SECRET }) resolves; POST INIT at the secret path → 200
it("logs a warning when opted in", ...)                   // capture log; one line contains "without authentication"
```

Note: `start()` currently swallows `EADDRNOTAVAIL`/`ENOTFOUND`/`EAFNOSUPPORT`; the refusal error has no `code`, so it propagates.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: "refuses 0.0.0.0" fails (server starts); the warning test fails.

- [ ] **Step 3: Implement**

In `serveHttp`, directly after `validateHost = isLoopbackAddress(bound.address)`: if the refusal condition holds, call `dispose()`, `await new Promise(r => httpServer.close(r))`, and throw the error. Otherwise log the listen line, then the warning line when `!validateHost && !opts.secret`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run typecheck && npm test`
Expected: all pass, including PR #1's "removes signal handlers when listening fails".

- [ ] **Step 5: Commit**

```bash
git add src/http.ts test/http.test.ts
git commit -m "feat(http): refuse unauthenticated non-loopback binds unless MCP_ALLOW_UNAUTHENTICATED=1"
```

---

### Task 6: Docker packaging

**Files:**
- Create: `Dockerfile`, `compose.yaml`, `.dockerignore` (restored from the Task 1 stash, then edited)

**Interfaces:**
- Produces: image `ghcr.io/mikkelkaas/nemligmcp` that starts HTTP on `0.0.0.0:3000`, health-checked on `/healthz`, expecting `MCP_SECRET`, `NEMLIG_USER`, `NEMLIG_PASS` from `.env`. `compose.yaml` service `nemligmcp` uses `image: ghcr.io/mikkelkaas/nemligmcp:latest` and has no `build`.

- [ ] **Step 1: Restore the three files from the stash's untracked tree**

```bash
git checkout 'stash@{0}^3' -- Dockerfile compose.yaml .dockerignore
```

- [ ] **Step 2: Edit `Dockerfile` env**

Runtime stage `ENV NODE_ENV=production MCP_TRANSPORT=http MCP_HTTP_HOST=0.0.0.0 PORT=3000` and `LABEL org.opencontainers.image.source=https://github.com/mikkelkaas/nemligmcp`. Keep `USER node`, `EXPOSE 3000`, the `wget` health check on `/healthz`, `CMD ["node", "dist/index.js"]`. Build stage must run `npm ci --ignore-scripts` (the `prepare` script would otherwise build before `src` is copied).

- [ ] **Step 3: Edit `compose.yaml`**

Replace `build: .` and `image: nemligmcp:local` with `image: ghcr.io/mikkelkaas/nemligmcp:latest`. Remove `MCP_TRANSPORT`/`PORT` from `environment` (the image sets them). Keep `env_file: .env`, `container_name: nemligmcp`, `init: true`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, network `npm_default` via `${PROXY_NETWORK:-npm_default}`, no published port. Update the header comment: the image is pulled from ghcr; build locally with `docker build -t ghcr.io/mikkelkaas/nemligmcp:latest .` if wanted.

- [ ] **Step 4: Verify the image locally if Docker is available**

```bash
docker build -t nemligmcp:test . && \
docker run --rm -d --name nemligmcp-test -p 127.0.0.1:3999:3000 -e MCP_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef nemligmcp:test && \
sleep 2 && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/healthz && \
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3999/mcp && \
docker rm -f nemligmcp-test
```

Expected: `200` then `404`. If Docker is not available locally, this is verified in Task 9 on alpha instead; say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile compose.yaml .dockerignore
git commit -m "feat: Dockerfile and compose file for the HTTP transport behind a reverse proxy"
```

---

### Task 7: Build and push the image from the release workflow

**Files:**
- Modify: `.github/workflows/publish.yml`
- Modify: `.releaserc.json`
- Modify: `package.json`, `package-lock.json` (dev dependency `@semantic-release/exec`)

**Interfaces:**
- Consumes: the `Dockerfile` from Task 6.
- Produces: on a release, images `ghcr.io/mikkelkaas/nemligmcp:latest`, `:<version>`, `:<major>` for `linux/amd64,linux/arm64`. The `Release` step has `id: release` and outputs `released` (`"true"`) and `version` (for example `1.2.0`).

- [ ] **Step 1: Add the exec plugin**

Run: `npm install --save-dev @semantic-release/exec`
In `.releaserc.json`, insert before `@semantic-release/github`:

```json
["@semantic-release/exec", {
  "publishCmd": "echo \"released=true\" >> \"$GITHUB_OUTPUT\" && echo \"version=${nextRelease.version}\" >> \"$GITHUB_OUTPUT\""
}]
```

- [ ] **Step 2: Extend the workflow**

In `publish.yml`: add `packages: write` under `permissions`; give the `Release` step `id: release`; keep PR #1's `Test` step before `Build`. Append, each guarded with `if: steps.release.outputs.released == 'true'`:

1. `docker/setup-qemu-action@v3`
2. `docker/setup-buildx-action@v3`
3. `docker/login-action@v3` with `registry: ghcr.io`, `username: ${{ github.actor }}`, `password: ${{ secrets.GITHUB_TOKEN }}`
4. `docker/build-push-action@v6` with `context: .`, `push: true`, `platforms: linux/amd64,linux/arm64`, and tags `ghcr.io/mikkelkaas/nemligmcp:latest`, `ghcr.io/mikkelkaas/nemligmcp:${{ steps.release.outputs.version }}`, and the major derived in a preceding `run` step (`echo "major=${VERSION%%.*}" >> "$GITHUB_OUTPUT"`).

- [ ] **Step 3: Validate the workflow file**

Run: `npx --yes @action-validator/cli .github/workflows/publish.yml 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"`
Expected: no errors. Also run `npx semantic-release --dry-run --no-ci` and confirm the output contains `Loaded plugin "publish" from "@semantic-release/exec"` before it stops with the message that the branch `http-transport` is not configured for release (nothing is published in dry-run).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml .releaserc.json package.json package-lock.json
git commit -m "ci: build and push the container image to ghcr.io on release"
```

---

### Task 8: README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the env table from the spec's "Configuration surface" and the stashed remote-mode section (`git show 'stash@{0}:README.md'`).

- [ ] **Step 1: Restructure the HTTP documentation**

Under a `## Streamable HTTP` heading: a short intro (stdio is default), then the env table from the spec, then three subsections: **Local shared process** (PR #1's text, now mentioning the opt-out for LAN binds), **Remote single-user endpoint** (the stashed "Remote (HTTP) mode" text, updated to `MCP_SECRET` + `--http`, the session note replaced), **Docker behind Nginx Proxy Manager** (image `ghcr.io/mikkelkaas/nemligmcp`, built on every release for amd64 and arm64, `docker compose pull && docker compose up -d`) with the advanced config block from the spec (`access_log off; error_log ... crit; proxy_buffering off; proxy_read_timeout 86400s;`) and the "Connecting clients" bullets for claude.ai and ChatGPT. Update the "Notes / internals" transport bullet to describe one transport with sessions. Mention `npm test`.

- [ ] **Step 2: Check the README renders and references are right**

Run: `grep -n 'MCP_SECRET\|MCP_ALLOW_UNAUTHENTICATED\|MCP_HTTP_PORT\|/healthz' README.md`
Expected: every variable from the spec table appears at least once; no mention of "stateless".

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document local and remote HTTP modes, Docker and client setup"
```

---

### Task 9: Deploy the branch to alpha and verify before merging

**Files:**
- Remote: `alpha:~/docker/nemligmcp/` (plain copy, not a clone), NPM proxy host 41

**Interfaces:**
- Consumes: `~/.local/bin/npm-token` for the NPM API; alpha's existing `.env` (48-char `MCP_SECRET`).

- [ ] **Step 1: Back up the running image**

```bash
ssh alpha 'docker tag nemligmcp:local nemligmcp:stateless-backup && docker images nemligmcp'
```

- [ ] **Step 2: Copy the branch tree, build the image under the ghcr tag, and restart**

```bash
cd /home/mkf/projs/nemligmcp
rsync -a --delete --exclude .git --exclude .env --exclude node_modules --exclude dist --exclude .claude --exclude .codex ./ alpha:docker/nemligmcp/
ssh alpha 'cd ~/docker/nemligmcp && docker build -t ghcr.io/mikkelkaas/nemligmcp:latest . && docker compose up -d && sleep 5 && docker ps --filter name=nemligmcp --format "{{.Status}}" && docker logs --since 2m nemligmcp'
```

Expected: status `Up ... (healthy)`; logs show the listen line ending in `/mcp/<MCP_SECRET>` and no secret value.

- [ ] **Step 3: Verify through the public URL**

```bash
ssh alpha 'S=$(grep ^MCP_SECRET= ~/docker/nemligmcp/.env | cut -d= -f2-); \
curl -s -o /dev/null -w "healthz %{http_code}\n" https://nemlig.kaasfrich.dk/healthz; \
curl -s -o /dev/null -w "bare mcp %{http_code}\n" -X POST https://nemlig.kaasfrich.dk/mcp; \
curl -s -o /dev/null -w "wrong %{http_code}\n" -X POST https://nemlig.kaasfrich.dk/mcp/nope; \
curl -s -D - -o /dev/null -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-03-26\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"0\"}}}" \
  "https://nemlig.kaasfrich.dk/mcp/$S" | grep -i "^HTTP\|mcp-session-id"'
```

Expected: `healthz 200`, `bare mcp 404`, `wrong 404`, `HTTP/2 200` with an `mcp-session-id` header. Never print the secret.

- [ ] **Step 4: Patch NPM host 41**

PUT to `localhost:81/api/nginx/proxy-hosts/41` with the existing body changed to `ssl_forced: true` and `advanced_config` equal to the spec's four-line block (`access_log off;`, `error_log /data/logs/proxy-host-41_error.log crit;`, `proxy_buffering off;`, `proxy_read_timeout 86400s;`). Re-run Step 3; additionally `curl -s -o /dev/null -w '%{http_code}' http://nemlig.kaasfrich.dk/healthz` must be `301`.

- [ ] **Step 5: Hand to the maintainer for the client check**

Ask the maintainer to reconnect the connector in claude.ai and in ChatGPT (same URL as before, "No authentication") and run one `search_products` call from each. Wait for the result. If either fails: `ssh alpha 'cd ~/docker/nemligmcp && docker compose down && docker tag nemligmcp:stateless-backup ghcr.io/mikkelkaas/nemligmcp:latest && docker compose up -d'`, revert the NPM patch's read timeout only if it caused the failure, and report back. Do not continue to Task 10.

---

### Task 10: Merge to master, release, publish the image, and comment on PR #1

**Files:**
- Branch `master`; GitHub PR #1

- [ ] **Step 1: Final checks on the branch**

Run: `npm run typecheck && npm test && npm run build && git status --short`
Expected: all pass; working tree clean.

- [ ] **Step 2: Merge and push**

```bash
git switch master && git pull --ff-only
git merge --no-ff http-transport -m "feat: Streamable HTTP transport with optional secret path for remote use

Merges PR #1's stateful Streamable HTTP transport and adds MCP_SECRET,
MCP_ALLOW_UNAUTHENTICATED, GET /healthz, PORT fallback, --http, Docker
packaging and docs for claude.ai/ChatGPT.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin master
```

- [ ] **Step 3: Confirm the release**

Run: `gh run watch` on the publish workflow, then `gh release view v1.2.0` and `npm view nemligmcp version`.
Expected: release `v1.2.0` exists; npm shows `1.2.0`; the workflow log shows the image push with three tags. Confirm `gh pr view 1 --json state` is `MERGED`.

- [ ] **Step 4: Make the package public and switch alpha to the released image**

Ask the maintainer to open `https://github.com/users/mikkelkaas/packages/container/nemligmcp/settings` and change visibility to Public (not available through the API). Then:

```bash
ssh alpha 'cd ~/docker/nemligmcp && docker compose pull && docker compose up -d && docker inspect -f "{{.Config.Image}} {{index .Config.Labels \"org.opencontainers.image.source\"}}" nemligmcp && docker image rm nemligmcp:stateless-backup'
```

Re-run Task 9 Step 3's curl checks. Expected: same results; the container now runs the pulled image.

- [ ] **Step 5: Comment on PR #1**

Post the note the maintainer approved (in the conversation, filed under "note to post on his PR") with `<commit/1.2.0>` replaced by the v1.2.0 release link, via `gh pr comment 1 --body-file <file>`. The PR is already marked merged by GitHub; do not close it manually.

- [ ] **Step 6: Drop the stash**

```bash
git stash drop 'stash@{0}'
```
