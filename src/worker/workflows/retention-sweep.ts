import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export interface RetentionParams {
  asOf: string;
  maxSubjects?: number;
}

// Placeholder until the retention commit (SPEC.md section 14.5).
export class RetentionSweepWorkflow extends WorkflowEntrypoint<Env, RetentionParams> {
  override async run(_event: WorkflowEvent<RetentionParams>, _step: WorkflowStep): Promise<unknown> {
    throw new Error("RetentionSweepWorkflow is not implemented yet");
  }
}
