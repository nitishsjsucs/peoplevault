// KV cache of purpose-filtered profiles and team rosters (SPEC.md sections 9.5 and 14.6). Values hold only the
// purpose-filtered view plus the scope facts needed to re-check row scope on a hit (the org unit for
// employee_relations, the manager's employee_ref for team_management). Every write sets expirationTtl 3600.
import { POLICY } from "../policy/compiled.ts";

export const KV_TTL_SECONDS = POLICY.retention.kv_ttl_seconds;

export interface CachedProfile {
  v: 1;
  profile: Record<string, unknown>;
  scope: { org_unit?: string; manager_ref?: string };
}

export interface RosterEntry {
  employee_ref: string;
  full_name: string;
  job_title: string;
}

export const profileKey = (purpose: string, ref: string) => `profile:${purpose}:${ref}`;
export const teamKey = (managerRef: string) => `team:${managerRef}`;

export async function getProfile(kv: KVNamespace, purpose: string, ref: string): Promise<CachedProfile | null> {
  return kv.get<CachedProfile>(profileKey(purpose, ref), "json");
}

export async function putProfile(kv: KVNamespace, purpose: string, ref: string, value: CachedProfile): Promise<void> {
  await kv.put(profileKey(purpose, ref), JSON.stringify(value), { expirationTtl: KV_TTL_SECONDS });
}

export async function getRoster(kv: KVNamespace, managerRef: string): Promise<RosterEntry[] | null> {
  return kv.get<RosterEntry[]>(teamKey(managerRef), "json");
}

export async function putRoster(kv: KVNamespace, managerRef: string, roster: RosterEntry[]): Promise<void> {
  await kv.put(teamKey(managerRef), JSON.stringify(roster), { expirationTtl: KV_TTL_SECONDS });
}
