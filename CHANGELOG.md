# [1.2.0](https://github.com/mikkelkaas/nemligmcp/compare/v1.1.0...v1.2.0) (2026-11-05)


### Bug Fixes

* scope nginx error log to the MCP location and build the image in its own job ([f0e413a](https://github.com/mikkelkaas/nemligmcp/commit/f0e413a1a5b4f4cb7de19939afe65f2fb874610f))


### Features

* add opt-in Streamable HTTP transport ([822b89d](https://github.com/mikkelkaas/nemligmcp/commit/822b89d4b20427d1a897b9a781a573040b3338c4))
* Dockerfile and compose file for the HTTP transport behind a reverse proxy ([e4de0ca](https://github.com/mikkelkaas/nemligmcp/commit/e4de0ca0bc89212d6609b275d9b0795823f9a45c))
* **http:** add GET /healthz for container health checks ([7fec148](https://github.com/mikkelkaas/nemligmcp/commit/7fec1482c428a0b3bf9b6c6c0a28566745b43649))
* **http:** read MCP_SECRET, MCP_ALLOW_UNAUTHENTICATED and PORT; add --http flag ([b33ee79](https://github.com/mikkelkaas/nemligmcp/commit/b33ee791a3b4f928c8ff6395cb74d167661c946f))
* **http:** refuse unauthenticated non-loopback binds unless MCP_ALLOW_UNAUTHENTICATED=1 ([eae0356](https://github.com/mikkelkaas/nemligmcp/commit/eae035656d69103deb4ea51dfea32f866bdbdfcc))
* **http:** serve MCP at /mcp/<MCP_SECRET> when a secret is configured ([b29a622](https://github.com/mikkelkaas/nemligmcp/commit/b29a62203e0554206d92a8013ede9e4c75e3ea9e))
* Streamable HTTP transport with optional secret path for remote use ([b121c07](https://github.com/mikkelkaas/nemligmcp/commit/b121c07ddef876765af953d1767d9b488a918794))

# [1.1.0](https://github.com/mikkelkaas/nemligmcp/compare/v1.0.1...v1.1.0) (2026-11-04)


### Features

* expose delivery ETA for the featured order ([#2](https://github.com/mikkelkaas/nemligmcp/issues/2)) ([2db9270](https://github.com/mikkelkaas/nemligmcp/commit/2db927014d76afe39a84ab100d7c4de3da704b6a))

## [1.0.1](https://github.com/mikkelkaas/nemligmcp/compare/v1.0.0...v1.0.1) (2026-06-29)


### Bug Fixes

* publish via npm Trusted Publishing (OIDC) instead of a stored token ([7b2a781](https://github.com/mikkelkaas/nemligmcp/commit/7b2a7816d20f579e9fb88cb54a49a86183f93113))

# 1.0.0 (2026-06-29)


### Features

* initial public release of the nemlig.com MCP server ([87a0524](https://github.com/mikkelkaas/nemligmcp/commit/87a052458f900b2c25047178176555f5ae9de3b2))
