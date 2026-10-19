# Codex capture pack

`config.template.toml` is the block `gisool init` keeps between `# >>> gisool managed` and `# <<< gisool managed`
in `~/.codex/config.toml` (MCP entry and `[otel]`). No Codex hooks are installed (they need trust review).
Note: `codex exec` exports OTel events only partially.

gisool serves MCP 2026-07-28 and the legacy `initialize` handshake, so Codex connects whether or not
`features.mcp_2026_07_28` is enabled. The pack does not change that agent-wide experimental setting.
