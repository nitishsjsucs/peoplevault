// pv-retention-sweep consumer (SPEC.md sections 14.5 and 30.3.4): DELETION.createBatch({ instances }) (object form).
// Messages come from the retention sweep and from the cron's reconcile; each names a request already admitted, and
// the instance id when it is not the request id. Per-instance errors for ids that already exist are acked; any other
// error retries the message (after 3 retries it goes to the dead letter queue pv-retention-dlq, which Workers Free
// keeps 24 hours; the cron re-sends admitted requests that never started).
import { INSTANCE_RETENTION } from "../requests.ts";
import type { SweepMessage } from "../workflows/retention-sweep.ts";

/** Workflow instance ids: letters, digits, "-" and "_", at most 100 characters (an invalid id fails the whole batch). */
export const validInstanceId = (id: string) => id.length > 0 && id.length <= 100 && /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(id);
const ALREADY_EXISTS = /already[ _]exists?/i;

export async function handleSweepBatch(batch: MessageBatch<SweepMessage>, env: Env): Promise<void> {
  const messages: Message<SweepMessage>[] = [];
  for (const m of batch.messages) {
    if (typeof m.body?.requestId !== "string" || (m.body.instanceId !== undefined && typeof m.body.instanceId !== "string")) m.ack(); // malformed: nothing to retry
    else if (!validInstanceId(m.body.instanceId ?? m.body.requestId)) m.retry(); // never creatable: ends in the dead letter queue
    else messages.push(m);
  }
  if (messages.length === 0) return;
  let result: WorkflowBatchCreateResult;
  try {
    result = await env.DELETION.createBatch({ instances: messages.map((m) => ({ id: m.body.instanceId ?? m.body.requestId, params: { requestId: m.body.requestId }, retention: INSTANCE_RETENTION })) });
  } catch {
    for (const m of messages) m.retry();
    return;
  }
  const failed = new Map(result.errors.map((err) => [err.index, err]));
  messages.forEach((m, i) => {
    const err = failed.get(i);
    if (!err || err.code === 10405 || ALREADY_EXISTS.test(err.message)) m.ack();
    else m.retry();
  });
}
