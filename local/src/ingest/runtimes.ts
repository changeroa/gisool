import type { RuntimeId } from "../types.js";

const EXACT: Record<string, RuntimeId> = {
  "claude-code": "claude-code",
  "codex-mcp-client": "codex",
  "gemini-cli-mcp-client": "gemini",
  "senpi-mcp-client": "omo", // verified OmO 5 client name
  opencode: "omo",
  "gjc-coding-agent": "gajae",
};

export function runtimeFromClientName(name: string | undefined | null): RuntimeId {
  if (!name) return "unknown";
  const exact = EXACT[name];
  if (exact) return exact;
  const lower = name.toLowerCase();
  if (lower.startsWith("cursor")) return "cursor";
  if (lower.includes("openclaw")) return "openclaw";
  return "unknown";
}

export const RUNTIME_IDS: readonly RuntimeId[] = ["claude-code", "codex", "gemini", "cursor", "omo", "gajae", "openclaw", "unknown"];

export function isRuntimeId(value: string): value is RuntimeId {
  return (RUNTIME_IDS as readonly string[]).includes(value);
}
