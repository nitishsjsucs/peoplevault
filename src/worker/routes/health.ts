import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { loadConfig } from "../env.ts";

export const health = new Hono<AppEnv>();

/** GET /api/health: no secrets, no counts. The audit copy is pulled by `pv audit export` (SPEC.md section 30.3.3). */
health.get("/api/health", (c) => {
  const cfg = loadConfig(c.env);
  return c.json({
    ok: true,
    env: cfg.env,
    authMode: cfg.authMode,
    warehouse: cfg.warehouseMode,
    auditCopy: "executor_export",
  });
});
