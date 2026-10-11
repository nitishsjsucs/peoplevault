import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

export interface DeletionParams {
  requestId: string;
}

// Placeholder until the deletion workflow commit (SPEC.md section 14.1).
export class SubjectDeletionWorkflow extends WorkflowEntrypoint<Env, DeletionParams> {
  override async run(_event: WorkflowEvent<DeletionParams>, _step: WorkflowStep): Promise<unknown> {
    throw new Error("SubjectDeletionWorkflow is not implemented yet");
  }
}
