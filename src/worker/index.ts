import { buildApp } from "./app.ts";
import { handleSweepBatch } from "./retention/queue-consumer.ts";
import { runScheduledRetention } from "./retention/scheduled.ts";
import type { SweepMessage } from "./workflows/retention-sweep.ts";

export { SubjectDeletionWorkflow } from "./workflows/subject-deletion.ts";
export { RetentionSweepWorkflow } from "./workflows/retention-sweep.ts";

const app = buildApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
  async queue(batch, env) {
    await handleSweepBatch(batch, env);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runScheduledRetention(env).then(() => undefined));
  },
} satisfies ExportedHandler<Env, SweepMessage>;
