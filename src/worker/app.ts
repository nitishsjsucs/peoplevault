import { Hono } from "hono";
import type { VerifiedIdentity } from "./auth/access-verifier.ts";
import { devRoutes } from "./auth/dev-login.ts";
import { authenticate, requireCsrfHeader, withConfig } from "./auth/middleware.ts";
import type { Principal } from "./auth/principals.ts";
import { ConfigError, type Config } from "./env.ts";
import { health } from "./routes/health.ts";
import { me } from "./routes/me.ts";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    cfg: Config;
    identity: VerifiedIdentity;
    principal: Principal;
  };
}

export interface BuildAppOptions {
  /** Injected fetch for the remote Access JWKS (tests use recorded responses). */
  accessFetch?: typeof fetch;
}

export function buildApp(opts: BuildAppOptions = {}): Hono<AppEnv> {
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
  app.route("/", devRoutes);
  app.use("/api/v1/*", withConfig, authenticate(opts.accessFetch), requireCsrfHeader);
  app.route("/", me);
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  return app;
}
