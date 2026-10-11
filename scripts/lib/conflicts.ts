// Same-named Cloudflare resources this repo has no record of (SPEC.md section 30.3.9). The Cloudflare account is shared
// with three other repos, so setup:prod never adopts a bucket, database, namespace, queue, Workflow, Worker or AI Gateway with one
// of this repo's names unless .secrets/prod-resources.json records that this repo created it; it stops and names the conflict.
import type { ProdResources } from "./prod-files.ts";

export const BUCKETS = ["pv-source-exports", "pv-derived", "pv-lake"];
export const QUEUES = ["pv-retention-sweep", "pv-retention-dlq"];
export const D1_NAME = "pv-control";
export const KV_TITLE = "pv-cache";
export const WORKER_NAME = "peoplevault";
/** Workflow names are account-wide; the first deploy creates both. */
export const WORKFLOWS = ["pv-subject-deletion", "pv-retention-sweep"];

export interface AccountResources {
  buckets: string[];
  d1: { name: string; uuid: string }[];
  kv: { id: string; title: string }[];
  queues: string[];
  /** names from `wrangler workflows list --json` (absent when not read) */
  workflows?: string[];
  workerId: string | null;
  /** an AI Gateway named peoplevault exists (P1 schema-drift triage) */
  aiGateway?: boolean;
}

export interface Conflict {
  item: string;
  fix: string;
}

export const isKvTitle = (title: string) => title === KV_TITLE || title.endsWith(KV_TITLE);

export function nameConflicts(a: AccountResources, r: ProdResources): Conflict[] {
  const out: Conflict[] = [];
  const record = (field: string) => `check who owns it; if this repo created it, record it in .secrets/prod-resources.json (${field}), otherwise rename this repo's resource`;
  const createdBuckets = new Set(r.created_buckets ?? []);
  for (const b of BUCKETS) if (a.buckets.includes(b) && !createdBuckets.has(b)) out.push({ item: `R2 bucket ${b} exists but this repo has no record of creating it`, fix: record(`"created_buckets": [..., "${b}"]`) });
  const d1 = a.d1.find((x) => x.name === D1_NAME);
  if (d1 && r.d1_id !== d1.uuid) out.push({ item: `D1 database ${D1_NAME} exists but its id is not the recorded d1_id`, fix: record(`"d1_id": "<its uuid>"`) });
  const kv = a.kv.find((n) => isKvTitle(n.title));
  if (kv && r.kv_id !== kv.id) out.push({ item: `KV namespace ${kv.title} exists but its id is not the recorded kv_id`, fix: record(`"kv_id": "<its id>"`) });
  const createdQueues = new Set(r.created_queues ?? []);
  for (const q of QUEUES) if (a.queues.includes(q) && !createdQueues.has(q)) out.push({ item: `Queue ${q} exists but this repo has no record of creating it`, fix: record(`"created_queues": [..., "${q}"]`) });
  const createdWorkflows = new Set(r.created_workflows ?? []);
  for (const w of WORKFLOWS) if ((a.workflows ?? []).includes(w) && !createdWorkflows.has(w)) out.push({ item: `Workflow ${w} exists but this repo has no record of deploying it`, fix: record(`"created_workflows": [..., "${w}"]`) });
  if (a.workerId && !r.worker_deployed) out.push({ item: `Worker ${WORKER_NAME} exists but this repo has no record of deploying it`, fix: record(`"worker_deployed": true`) });
  if (a.aiGateway && !r.ai_gateway_created) out.push({ item: `AI Gateway ${WORKER_NAME} exists but this repo has no record of creating it`, fix: record(`"ai_gateway_created": true`) });
  return out;
}
