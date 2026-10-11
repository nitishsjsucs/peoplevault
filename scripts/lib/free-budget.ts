// The Workers Free usage budget (SPEC.md sections 30.1 and 30.4). One Cloudflare account and one Google Cloud project
// serve four repos and every Free allowance is per account, so this repo plans for a 25% share of each allowance on
// its worst-case day: the first setup:prod and seed:prod, authz:prod, the production eval plus 4 more completed
// deletions to reach the daily cap, a retention sweep, 24 hourly executor runs, one audit export, three doctor runs
// and a privacy console session, all on one UTC day. Pure TypeScript (no Node imports): the budget test, the doctor and the worker tests read it.

/** Verified Free plan facts (SPEC.md section 30.1), with the page each was read on (2026-10-10; F21 on 2026-10-11, and
 * "Requests to static assets are free and unlimited" on https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). */
export const FACTS = {
  F1: { what: "Workers requests per day per account", value: 100_000, source: "https://developers.cloudflare.com/workers/platform/limits/" },
  F2: { what: "CPU ms per HTTP request, Cron Trigger and Workflow step", value: 10, source: "https://developers.cloudflare.com/workers/platform/limits/" },
  F4: { what: "subrequests per invocation: external / to Cloudflare services", value: [50, 1000], source: "https://developers.cloudflare.com/workers/platform/limits/" },
  F5: { what: "environment variables per Worker; script size MiB", value: [64, 64], source: "https://developers.cloudflare.com/workers/platform/limits/" },
  F6: { what: "Cron Triggers per account", value: 5, source: "https://developers.cloudflare.com/workers/platform/limits/" },
  F7: { what: "Workers Logs events per day", value: 200_000, source: "https://developers.cloudflare.com/workers/observability/logs/workers-logs/" },
  F8: { what: "Workflow steps per day; concurrent instances; storage GB-month; retention days", value: [3000, 100, 1, 3], source: "https://developers.cloudflare.com/workflows/reference/limits/" },
  F10: { what: "Queue operations per day (retention fixed at 24 h)", value: 10_000, source: "https://developers.cloudflare.com/queues/platform/pricing/" },
  F12: { what: "D1 rows read and written per day; queries per invocation; Time Travel days", value: [5_000_000, 100_000, 50, 7], source: "https://developers.cloudflare.com/d1/platform/limits/" },
  F13: { what: "KV reads, writes, deletes, lists per day", value: [100_000, 1000, 1000, 1000], source: "https://developers.cloudflare.com/kv/platform/pricing/" },
  F14: { what: "R2 Class A and Class B operations per month; storage GB-month", value: [1_000_000, 10_000_000, 10], source: "https://developers.cloudflare.com/r2/pricing/" },
  F15: { what: "Basin Catalog operations per month", value: 1_000_000, source: "https://developers.cloudflare.com/basin-catalog/platform/pricing/" },
  F16: { what: "Basin Pipelines", value: "Workers Paid only", source: "https://developers.cloudflare.com/basin-pipelines/platform/pricing/" },
  F17: { what: "Workers AI neurons per day", value: 10_000, source: "https://developers.cloudflare.com/workers-ai/platform/pricing/" },
  F18: { what: "AI Gateways per account", value: 10, source: "https://developers.cloudflare.com/ai-gateway/reference/limits/" },
  F19: { what: "Zero Trust Free seats; service tokens", value: [50, 50], source: "https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/" },
  F20: { what: "BigQuery free tier: query TiB and storage GiB per month", value: [1, 10], source: "https://cloud.google.com/bigquery/pricing" },
  F21: { what: "Static assets: files per Worker version on Free; MiB per file (asset requests are free and unlimited)", value: [20_000, 25], source: "https://developers.cloudflare.com/workers/platform/limits/" },
} as const;

export const SHARE = 0.25;

/** Steps of one deletion instance (asserted against the Workflow itself by test/worker/ops.budget.test.ts). */
export const STEPS = { completedDeletion: 30, failedVerification: 23, held: 3, sweepWorstCase: 9 } as const;

/** Unit costs of one completed deletion at the full population (SPEC.md section 30.4). */
export const PER_DELETION = {
  d1RowsRead: 9000, // 3 D1 probes over about 2,900 rows each, plus about 300 for other queries
  d1RowsWritten: 150, // index entries counted as extra rows (conservative)
  kvReads: 200, // 2 bulk passes over at most 100 cache keys, counted per key (conservative)
  kvDeletes: 4,
  kvLists: 3,
  r2ClassA: 52, // 18 lists, up to 34 puts
  r2ClassB: 94 + 50, // gets, plus about 50 lake reads by the Python verifiers
  basinOps: 20,
  cloudflareCalls: 394, // KV, R2 and D1 calls per instance (design budget 900; Free allows 1,000)
} as const;

/** Per-invocation ceilings of the redesign (SPEC.md sections 30.3.1 and 30.3.2). */
export const PER_INVOCATION = {
  largestStepCpuMsOnMac: 1.83, // erase step at the 4 MiB cap, measured by `npm run bench:cpu`
  edgeFactor: 3,
  cpuTargetMs: 7.5, // 25% under the 10 ms limit
  d1StatementsPerStep: 40,
  externalFetchesPerDataRequest: 34, // 1 JWKS + 2 token + 1 query + 20 polls + 10 pages
  cloudflareCallsPerInstanceBudget: 900,
} as const;

export interface Caps {
  /** DAILY_DELETION_STARTS of the production template */
  dailyDeletionStarts: number;
  /** RETENTION_DAILY_MAX of the production template */
  retentionDailyMax: number;
  /** max_retries of the queue consumer */
  queueMaxRetries: number;
  /** Cron Triggers of the production template */
  cronTriggers: number;
  /** AI_DAILY_NEURONS of the production template (P1 schema-drift triage) */
  aiDailyNeurons: number;
}

export interface BudgetRow {
  resource: string;
  period: "day" | "month" | "account";
  allowance: number;
  share: number;
  usage: number;
  derivation: string;
}

/** Queue operations of one message: write, a read per delivery attempt, delete, and a dead-letter write. */
export const queueOpsPerMessage = (maxRetries: number) => 1 + (1 + maxRetries) + 1 + 1;

/** Workers requests on the worst-case day (SPEC.md section 30.4, row by row). */
export const REQUESTS_WORST_DAY = { seed: 33, authzProd: 170, prodEval: 1160, executorYml: 40, auditExportAndVerify: 15, doctor: 30, workflowQueueCron: 20, console: 300, driftEval: 125 } as const;

/** D1 rows a console session reads on that day: a full chain check (each event once), report, request and audit pages. */
export const CONSOLE_D1_ROWS_READ = 10_000;

export function worstCaseDay(c: Caps): BudgetRow[] {
  const d = c.dailyDeletionStarts;
  const row = (resource: string, period: BudgetRow["period"], allowance: number, usage: number, derivation: string): BudgetRow => ({ resource, period, allowance, share: allowance * SHARE, usage, derivation });
  const monthlyDeletions = 30 * d;
  return [
    row("Workflow steps", "day", 3000, d * STEPS.completedDeletion + STEPS.sweepWorstCase, `${d} completed deletions x ${STEPS.completedDeletion} steps + a ${STEPS.sweepWorstCase}-step sweep`),
    row("Workers requests", "day", 100_000, Object.values(REQUESTS_WORST_DAY).reduce((a, b) => a + b, 0), "seed, authz:prod, production eval, executor.yml, audit export and windows, doctor, Workflow, queue and cron invocations, 300 console API calls (static assets do not invoke the Worker), a day of the drift eval"),
    row("D1 rows read", "day", 5_000_000, d * PER_DELETION.d1RowsRead + 35_000 + 10_000 + 6000 + 5000 + 1200 + 3000 + CONSOLE_D1_ROWS_READ, `${d} x ${PER_DELETION.d1RowsRead} + oracle, seed checks, status polls, doctor, sweep, routes and appends, console`),
    row("D1 rows written", "day", 100_000, 9000 + d * PER_DELETION.d1RowsWritten + 1000 * 3 + 512 + 200, `seed 9,000 + ${d} x ${PER_DELETION.d1RowsWritten} + 1,000 audit events x 3 + residual and task updates`),
    row("KV reads", "day", 100_000, d * PER_DELETION.kvReads + 300 + 100, `${d} x ${PER_DELETION.kvReads} + route gets + oracle`),
    row("KV writes", "day", 1000, 23 + 23 + 60 + 3, "two warm-ups of 23 entries, authz:prod cache fills, planted faults"),
    row("KV deletes", "day", 1000, d * PER_DELETION.kvDeletes + 3, `${d} x ${PER_DELETION.kvDeletes} + fault cleanups`),
    row("KV lists", "day", 1000, d * PER_DELETION.kvLists + 10, `${d} x ${PER_DELETION.kvLists} + assets route, doctor, oracle`),
    row("Queue operations", "day", 10_000, (c.retentionDailyMax + d) * queueOpsPerMessage(c.queueMaxRetries), `(${c.retentionDailyMax} retention messages + up to ${d} reconcile re-sends) x ${queueOpsPerMessage(c.queueMaxRetries)} operations`),
    row("Workflow concurrency", "account", 100, d, `at most ${d} running deletions`),
    row("Workflow storage MB", "month", 1000, (d * 150 * 3) / 1000, `${d} instances x 150 KB x 3 days`),
    row("Cron Triggers", "account", 5, c.cronTriggers, "the daily reconcile and sweep"),
    row("Workers Logs events", "day", 200_000, 2000, "5 console call sites, at most one line per invocation"),
    row("R2 Class A operations", "month", 1_000_000, monthlyDeletions * PER_DELETION.r2ClassA + 1000, `${monthlyDeletions} deletions x ${PER_DELETION.r2ClassA} + seed puts, lake commits, audit exports`),
    row("R2 Class B operations", "month", 10_000_000, monthlyDeletions * PER_DELETION.r2ClassB, `${monthlyDeletions} deletions x ${PER_DELETION.r2ClassB}`),
    row("R2 storage MB", "month", 10_000, 50, "exports 9.7 MB, extracts 1.3 MB, lake and audit copy under 40 MB"),
    row("Basin Catalog operations", "month", 1_000_000, monthlyDeletions * PER_DELETION.basinOps + 1400, `${monthlyDeletions} deletions x ${PER_DELETION.basinOps} + exports and doctor`),
    row("Workers AI neurons (P1)", "day", 10_000, c.aiDailyNeurons, "the AI_DAILY_NEURONS cap, enforced by the D1 neuron meter before every call"),
    row("AI Gateways (P1)", "account", 10, 1, "one gateway, no stored logs"),
    row("Access seats", "account", 50, 5, "owner and 4 persona plus-addresses"),
    row("Access service tokens", "account", 50, 5, "pv-executor and 4 persona tokens"),
    row("BigQuery queries GiB", "month", 1024, 30, "about 30 GB in the eval month; every query byte-capped"),
    row("BigQuery storage GiB", "month", 10, 0.05, "about 50 MB"),
  ];
}

/** D1 rows read on a capped day when each completed deletion probes `scannedRows` rows three times. */
export function projectedD1RowsRead(scannedRows: number, dailyDeletionStarts: number): number {
  return dailyDeletionStarts * (3 * scannedRows + 300) + 35_000 + 10_000 + 6000 + 5000 + 1200 + 3000 + CONSOLE_D1_ROWS_READ;
}
