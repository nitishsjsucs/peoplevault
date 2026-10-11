import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { loadConfig } from "../env.ts";

export const health = new Hono<AppEnv>();

/** GET /api/health: no secrets, no counts. */
health.get("/api/health", (c) => {
  const cfg = loadConfig(c.env);
  const auditStream = cfg.auditStreamMode === "pipelines" ? "pipelines" : cfg.env === "local" ? "disabled_local" : "disabled";
  return c.json({
    ok: true,
    env: cfg.env,
    authMode: cfg.authMode,
    warehouse: cfg.warehouseMode,
    auditStream,
  });
});
