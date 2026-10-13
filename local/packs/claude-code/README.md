# Claude Code capture pack

Template merged into `~/.claude/settings.json` by `gisool init`: OTel log export (`env`) plus
`PostToolUse` / `UserPromptExpansion` hooks that run `packs/hook-post.mjs`. `~/.claude.json` is never edited;
the MCP server is registered with `claude mcp add --scope user` (or printed as a manual step).
