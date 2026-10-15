import { createHash } from "node:crypto";
import { z } from "zod";

/** Workflow and step ids are slugs: a letter or digit, then letters, digits, ".", "_" or "-". */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const slug = (max: number) =>
  z.string().min(1).max(max).regex(SLUG, "must start with a letter or digit and use only letters, digits, '.', '_' or '-'");

export const MAX_STEPS = 50;
export const MAX_SKILLS_PER_STEP = 10;
export const MAX_NAME_LENGTH = 128;

export const workflowStepSchema = z.strictObject({
  id: slug(64),
  skills: z.array(z.string().min(1).max(MAX_NAME_LENGTH)).max(MAX_SKILLS_PER_STEP),
  /** true: every intended skill is expected in the same step; false: any one of them satisfies it. */
  together: z.boolean().default(false),
  // The plan sets no element count for expectTools; the request body limit is the bound.
  expectTools: z.array(z.string().min(1).max(MAX_NAME_LENGTH)).default([]),
  doneWhen: z.string().max(500).optional(),
});

export const workflowSpecSchema = z.strictObject({
  name: slug(64),
  steps: z.array(workflowStepSchema).min(1).max(MAX_STEPS),
}).refine((spec) => new Set(spec.steps.map((s) => s.id)).size === spec.steps.length, {
  message: "step ids must be unique",
  path: ["steps"],
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowSpec = z.infer<typeof workflowSpecSchema>;

/** Object keys sorted recursively so key order in the request body never changes the digest. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** Digest of the parsed spec (defaults applied), so a body that only differs in key order or omitted defaults is the same version. */
export function specDigest(spec: WorkflowSpec): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex")}`;
}
