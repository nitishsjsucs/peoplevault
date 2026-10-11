// GitHub side of the P1 executor.yml job (SPEC.md sections 20 and 22): which repository secrets the job reads, where
// each value comes from, and the doctor checks of the workflow's state and freshness. Secret values are never printed;
// setup records only a SHA-256 of each value it uploaded (`github_secrets` in .secrets/prod-resources.json) so a
// rotated value (for example a rotated Access service token) is uploaded again and an unchanged one is not.
import { createHash } from "node:crypto";
import type { ProdResources } from "./prod-files.ts";
import type { RunResult } from "./run.ts";

export const EXECUTOR_WORKFLOW = "executor.yml";
export const EXECUTOR_KEY_SECRET = "PV_GCP_EXECUTOR_KEY";
/** A successful scheduled run is expected every hour; older than this means the schedule stopped. */
export const MAX_RUN_AGE_HOURS = 26;

/** Repository secrets read by executor.yml, except the peoplevault-executor key (created by `pv setup actions-key`). */
export const GITHUB_SECRET_SOURCES: Record<string, (env: Record<string, string>, res: ProdResources) => string | undefined> = {
  PV_BASE_URL: (e) => e.PV_BASE_URL,
  PV_CF_ACCESS_CLIENT_ID: (e) => e.PV_CF_ACCESS_CLIENT_ID_EXECUTOR,
  PV_CF_ACCESS_CLIENT_SECRET: (e) => e.PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR,
  PV_GCP_PROJECT: (e) => e.PV_GCP_PROJECT,
  PV_R2_CATALOG_TOKEN: (e) => e.PV_R2_CATALOG_TOKEN,
  PV_CATALOG_URI: (e) => e.PV_CATALOG_URI,
  PV_CATALOG_WAREHOUSE: (e) => e.PV_CATALOG_WAREHOUSE,
  PV_POLICY_TAGS_JSON: (_e, r) => (r.policy_tags && Object.keys(r.policy_tags).length ? JSON.stringify(r.policy_tags) : undefined),
};
export const GITHUB_SECRETS = [...Object.keys(GITHUB_SECRET_SOURCES), EXECUTOR_KEY_SECRET];

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** OWNER/NAME from PV_GITHUB_REPO or the origin remote (https or ssh form); null when neither names a GitHub repo. */
export function githubRepo(env: Record<string, string | undefined>, originUrl: string): string | null {
  const explicit = env.PV_GITHUB_REPO?.trim();
  if (explicit) return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(explicit) ? explicit : null;
  const m = originUrl.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface GithubState {
  authed: boolean;
  repo: string | null;
  secrets: string[];
  variables: Record<string, string>;
  /** executor.yml state on GitHub (active, disabled_inactivity, disabled_manually, ...), or null when not found */
  workflowState: string | null;
  /** ISO time of the last successful executor.yml run, or null */
  lastSuccess: string | null;
}

function json<T>(text: string, fallback: T): T {
  const i = text.search(/[[{]/);
  if (i < 0) return fallback;
  try {
    return JSON.parse(text.slice(i)) as T;
  } catch {
    return fallback;
  }
}

export async function readGithubState(run: (cmd: string, args: string[]) => Promise<RunResult>, env: Record<string, string | undefined>): Promise<GithubState> {
  const repo = githubRepo(env, (await run("git", ["remote", "get-url", "origin"])).stdout);
  const s: GithubState = { authed: (await run("gh", ["auth", "status"])).code === 0, repo, secrets: [], variables: {}, workflowState: null, lastSuccess: null };
  if (!s.authed || !repo) return s;
  s.secrets = json<{ name: string }[]>((await run("gh", ["secret", "list", "--app", "actions", "--repo", repo, "--json", "name"])).stdout, []).map((x) => x.name);
  s.variables = Object.fromEntries(json<{ name: string; value: string }[]>((await run("gh", ["variable", "list", "--repo", repo, "--json", "name,value"])).stdout, []).map((v) => [v.name, v.value]));
  const wf = await run("gh", ["api", `repos/${repo}/actions/workflows/${EXECUTOR_WORKFLOW}`]);
  s.workflowState = wf.code === 0 ? (json<{ state?: string }>(wf.stdout, {}).state ?? null) : null;
  if (s.workflowState) {
    const runs = json<{ workflow_runs?: { updated_at?: string; created_at?: string }[] }>((await run("gh", ["api", `repos/${repo}/actions/workflows/${EXECUTOR_WORKFLOW}/runs?status=success&per_page=1`])).stdout, {});
    const last = runs.workflow_runs?.[0];
    s.lastSuccess = last?.updated_at ?? last?.created_at ?? null;
  }
  return s;
}
