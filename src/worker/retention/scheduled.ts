// Cron 0 3 * * * (the only Cron Trigger; SPEC.md sections 14.5 and 30.3.4). First the reconcile: deferred requests
// and requests admitted more than 6 hours ago without an instance are re-admitted, oldest first, up to today's
// remaining admission cap, and sent through the queue. Then, only when RETENTION_CRON=on, RETENTION.create({ id:
// "retention-<as_of>" }); "already exists" is ignored. RETENTION_CRON stays off in production until the production
// eval result is committed (its truth assumes no sweep ran).
import { reconcileReceived } from "../admission.ts";
import { loadConfig } from "../env.ts";
import { utcToday } from "./rules.ts";

export interface ScheduledOutcome {
  reconciled: number;
  more: boolean;
  retentionRun: string | null;
}

export async function runScheduledRetention(env: Env, now = new Date()): Promise<ScheduledOutcome> {
  const cfg = loadConfig(env);
  const rec = await reconcileReceived(env, cfg.dailyDeletionStarts, now);
  if (rec.admitted.length > 0) console.log("reconcile_admitted", rec.admitted.length);
  if (cfg.retentionCron !== "on") return { reconciled: rec.admitted.length, more: rec.more, retentionRun: null };
  const asOf = cfg.retentionAsOf ?? utcToday(now);
  const id = `retention-${asOf}`;
  try {
    await env.RETENTION.create({ id, params: { asOf } });
    return { reconciled: rec.admitted.length, more: rec.more, retentionRun: id };
  } catch (e) {
    if (/already[ _]exists?/i.test(String(e))) return { reconciled: rec.admitted.length, more: rec.more, retentionRun: null };
    throw e;
  }
}
