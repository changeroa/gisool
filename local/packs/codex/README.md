# Codex capture pack

`config.template.toml` is the block `gisool init` keeps between `# >>> gisool managed` and `# <<< gisool managed`
in `~/.codex/config.toml` (MCP entry and `[otel]`). No Codex hooks are installed (they need trust review).
Note: `codex exec` exports OTel events only partially.

gisool accepts MCP 2026-07-28 only. Codex builds that gate third-party HTTP MCP behind
`features.mcp_2026_07_28` need that feature enabled; `codex_apps_mcp_2026_07_28` only controls
hosted Codex Apps and does not enable gisool. The pack prints this requirement instead of changing
an agent-wide experimental feature setting or adding static per-request headers.
