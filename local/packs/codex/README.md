# Codex capture pack

`config.template.toml` is the block `gisool init` keeps between `# >>> gisool managed` and `# <<< gisool managed`
in `~/.codex/config.toml` (MCP entry and `[otel]`). No Codex hooks are installed (they need trust review).
Note: `codex exec` exports OTel events only partially.
