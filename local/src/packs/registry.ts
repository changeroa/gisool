import type { RuntimeId, RuntimePack } from "../types.js";
import { claudeCodePack } from "./claude-code.js";
import { codexPack } from "./codex.js";
import { cursorPack } from "./cursor.js";
import { gajaePack } from "./gajae.js";
import { geminiPack } from "./gemini.js";
import { omoPack } from "./omo.js";
import { openclawPack } from "./openclaw.js";

/** Every runtime pack gisool ships, in the order init plans and doctor reports them. */
export const PACKS: readonly RuntimePack[] = [claudeCodePack, codexPack, geminiPack, cursorPack, omoPack, gajaePack, openclawPack];

export const PACK_IDS: readonly RuntimeId[] = PACKS.map((p) => p.id);

export function getPack(id: string): RuntimePack | undefined {
  return PACKS.find((p) => p.id === id);
}
