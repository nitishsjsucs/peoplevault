import { Hono } from "hono";
import { ConfigError } from "./env.ts";
import { health } from "./routes/health.ts";

export interface AppEnv {
  Bindings: Env;
}

export interface BuildAppOptions {
  // Injection points (warehouse client factory, clock) are added as the routes that need them land.
}

export function buildApp(_opts: BuildAppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof ConfigError) {
      console.error("config_error");
      return c.json({ error: "misconfigured" }, 500);
    }
    console.error("unhandled_error", err.name);
    return c.json({ error: "internal" }, 500);
  });
  app.route("/", health);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
