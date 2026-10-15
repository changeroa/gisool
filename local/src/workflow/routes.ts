import type { Express, Request, Response } from "express";
import { z } from "zod";
import { deny } from "../api/security.js";
import type { Store, WorkflowSpecRow } from "../types.js";
import { workflowSpecSchema } from "./spec.js";

export type WorkflowRouteDeps = { store: Store; log: (msg: string) => void };

const flowBodySchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  tabId: z.string().min(1).max(128).optional(),
  spec: z.strictObject({ name: z.string().min(1).max(64), version: z.number().int().positive().max(1_000_000).optional() }),
  label: z.string().max(200).optional(),
});

const stepBodySchema = z.strictObject({
  paneId: z.string().min(1).max(128),
  stepId: z.string().min(1).max(64),
});

function handle(log: (msg: string) => void, fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (error) {
      log(`${req.method} ${req.path} failed: ${(error as Error).stack ?? String(error)}`);
      deny(res, 500, "internal_error");
    }
  };
}

/** Replies 400 with the failing paths and returns undefined, so each route can `if (!body) return;`. */
function parseBody<S extends z.ZodType>(res: Response, schema: S, body: unknown): z.infer<S> | undefined {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data as z.infer<S>;
  deny(res, 400, "bad_request", {
    message: "request body does not match the schema",
    issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
  });
  return undefined;
}

function specView(row: WorkflowSpecRow) {
  return { id: row.id, name: row.name, version: row.version, digest: row.digest, createdMs: row.createdMs, steps: row.spec.steps };
}

export function registerWorkflowRoutes(app: Express, deps: WorkflowRouteDeps): void {
  const { store, log } = deps;

  app.post("/api/workflows", handle(log, (req, res) => {
    const spec = parseBody(res, workflowSpecSchema, req.body);
    if (!spec) return;
    const { row, created } = store.putWorkflowSpec(spec);
    res.status(created ? 201 : 200).json({ id: row.id, name: row.name, version: row.version, digest: row.digest, createdMs: row.createdMs, created });
  }));

  app.get("/api/workflows", handle(log, (_req, res) => {
    res.json(store.workflowSpecs().map(specView));
  }));

  app.get("/api/workflows/:name/versions", handle(log, (req, res) => {
    const name = String(req.params.name);
    const versions = store.workflowSpecVersions(name);
    if (versions.length === 0) return deny(res, 404, "spec_not_found", { message: `no workflow spec named ${name}` });
    res.json(versions.map(specView));
  }));

  app.post("/api/flows", handle(log, (req, res) => {
    const body = parseBody(res, flowBodySchema, req.body);
    if (!body) return;
    const spec = store.workflowSpec(body.spec.name, body.spec.version);
    if (!spec) {
      return deny(res, 404, "spec_not_found", { message: `no workflow spec ${body.spec.name}${body.spec.version !== undefined ? ` version ${body.spec.version}` : ""}` });
    }
    const result = store.createFlow({
      workspaceId: body.workspaceId, specId: spec.id,
      ...(body.tabId !== undefined ? { tabId: body.tabId } : {}),
      ...(body.label !== undefined ? { label: body.label } : {}),
    });
    if (!result.created) {
      return deny(res, 409, "flow_already_open", { flowId: result.conflict.id, message: `flow ${result.conflict.id} is still open for this workspace and tab` });
    }
    const flow = result.flow;
    res.status(201).json({
      id: flow.id, workspaceId: flow.workspaceId, tabId: flow.tabId ?? null, label: flow.label ?? null,
      spec: { id: spec.id, name: spec.name, version: spec.version }, registeredMs: flow.registeredMs,
    });
  }));

  app.post("/api/flows/:id/steps", handle(log, (req, res) => {
    const flow = store.getFlow(String(req.params.id));
    if (!flow) return deny(res, 404, "flow_not_found");
    const body = parseBody(res, stepBodySchema, req.body);
    if (!body) return;
    const steps = flow.spec?.spec.steps.map((s) => s.id) ?? [];
    if (!steps.includes(body.stepId)) return deny(res, 400, "unknown_step", { message: `step ${body.stepId} is not in the flow's spec`, steps });
    const { created } = store.mapFlowStep(flow.id, body.paneId, body.stepId);
    res.status(created ? 201 : 200).json({ flowId: flow.id, paneId: body.paneId, stepId: body.stepId, created });
  }));

  app.post("/api/flows/:id/end", handle(log, (req, res) => {
    const id = String(req.params.id);
    const ended = store.endFlow(id);
    if (!ended) return deny(res, 404, "flow_not_found");
    res.json({ id, endedMs: ended.endedMs, alreadyEnded: ended.alreadyEnded });
  }));
}
