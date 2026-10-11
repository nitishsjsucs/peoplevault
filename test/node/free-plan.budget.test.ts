// The Workers Free usage budget (SPEC.md sections 18.5 and 30.4): with the caps of the production template, the
// worst-case day stays within this repo's 25% share of every per-account allowance, so raising a cap past the share
// fails here. The step counts are the Workflow's own (test/worker/ops.budget.test.ts asserts the same numbers).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FACTS, PER_DELETION, PER_INVOCATION, SHARE, STEPS, projectedD1RowsRead, queueOpsPerMessage, worstCaseDay, type Caps } from "../../scripts/lib/free-budget.ts";
import { TEMPLATE } from "../../scripts/lib/prod-files.ts";

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

const template = JSON.parse(stripJsonc(readFileSync(TEMPLATE, "utf8"))) as {
  vars: Record<string, string>;
  triggers: { crons: string[] };
  queues: { consumers: { max_retries: number }[] };
};

const caps: Caps = {
  dailyDeletionStarts: Number(template.vars.DAILY_DELETION_STARTS),
  retentionDailyMax: Number(template.vars.RETENTION_DAILY_MAX),
  queueMaxRetries: template.queues.consumers[0]!.max_retries,
  cronTriggers: template.triggers.crons.length,
  aiDailyNeurons: 2000,
};

describe("Workers Free budget: the worst-case day within a 25% share of every per-account allowance", () => {
  const rows = worstCaseDay(caps);

  for (const r of rows) {
    it(`${r.resource}: ${r.usage} of a ${r.share} share (${r.allowance} per ${r.period})`, () => {
      expect(r.usage, r.derivation).toBeLessThanOrEqual(r.share);
    });
  }

  it("the caps come from the production template", () => {
    expect(caps).toEqual({ dailyDeletionStarts: 16, retentionDailyMax: 8, queueMaxRetries: 3, cronTriggers: 1, aiDailyNeurons: 2000 });
    expect(SHARE).toBe(0.25);
  });

  it("DAILY_DELETION_STARTS x steps per completed deletion + the sweep stays within 750 steps", () => {
    expect(caps.dailyDeletionStarts * STEPS.completedDeletion + STEPS.sweepWorstCase).toBeLessThanOrEqual(750);
    expect(caps.dailyDeletionStarts * STEPS.completedDeletion + STEPS.sweepWorstCase).toBe(489);
  });

  it("queue operations: (RETENTION_DAILY_MAX + DAILY_DELETION_STARTS) x 7 within 2,500, with the consumer's 3 retries counted", () => {
    expect(queueOpsPerMessage(caps.queueMaxRetries)).toBe(7);
    expect((caps.retentionDailyMax + caps.dailyDeletionStarts) * queueOpsPerMessage(caps.queueMaxRetries)).toBeLessThanOrEqual(2500);
  });

  it("raising a cap past the share fails: 26 starts a day would exceed the step share", () => {
    const over = worstCaseDay({ ...caps, dailyDeletionStarts: 26 }).find((r) => r.resource === "Workflow steps")!;
    expect(over.usage).toBeGreaterThan(over.share);
  });

  it("per invocation: CPU at 3 times the Mac measurement under 7.5 ms, at most 40 of 50 D1 queries, 34 of 50 external fetches, 900 of 1,000 calls", () => {
    expect(PER_INVOCATION.largestStepCpuMsOnMac * PER_INVOCATION.edgeFactor).toBeLessThanOrEqual(PER_INVOCATION.cpuTargetMs);
    expect(PER_INVOCATION.cpuTargetMs).toBeLessThan(FACTS.F2.value);
    expect(PER_INVOCATION.d1StatementsPerStep).toBeLessThan(FACTS.F12.value[2]);
    expect(PER_INVOCATION.externalFetchesPerDataRequest).toBeLessThanOrEqual(FACTS.F4.value[0]);
    expect(PER_DELETION.cloudflareCalls).toBeLessThanOrEqual(PER_INVOCATION.cloudflareCallsPerInstanceBudget);
    expect(PER_INVOCATION.cloudflareCallsPerInstanceBudget).toBeLessThan(FACTS.F4.value[1]);
  });

  it("projects D1 rows read from the rows a probe scans (the doctor's line)", () => {
    expect(projectedD1RowsRead(2900, 16)).toBe(16 * (3 * 2900 + 300) + 60_200 + 10_000);
    expect(projectedD1RowsRead(2900, 16)).toBeLessThanOrEqual(FACTS.F12.value[0] * SHARE);
  });
});
