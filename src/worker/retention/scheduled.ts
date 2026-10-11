// Cron 0 3 * * * -> RETENTION.create({ id: "retention-<as_of>" }); "already exists" is ignored (SPEC.md 14.5).
import { loadConfig } from "../env.ts";
import { utcToday } from "./rules.ts";

export async function runScheduledRetention(env: Env, now = new Date()): Promise<string | null> {
  const cfg = loadConfig(env);
  const asOf = cfg.retentionAsOf ?? utcToday(now);
  const id = `retention-${asOf}`;
  try {
    await env.RETENTION.create({ id, params: { asOf } });
    return id;
  } catch (e) {
    if (/already[ _]exists?/i.test(String(e))) return null;
    throw e;
  }
}
