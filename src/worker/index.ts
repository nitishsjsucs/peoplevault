import { buildApp } from "./app.ts";

export { SubjectDeletionWorkflow } from "./workflows/subject-deletion.ts";
export { RetentionSweepWorkflow } from "./workflows/retention-sweep.ts";

const app = buildApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
