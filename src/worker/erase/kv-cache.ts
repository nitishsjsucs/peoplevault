// KV cache erasure (SPEC.md section 8.5, assets 12 and 13): one list pass, bulk gets of at most 100 keys, then
// per-key deletes of every entry that is the subject's or that mentions the subject. Dropping a cache entry is
// always safe (the next read refills it from the warehouse, and suppression stops refills of the subject).
import type { SubjectIdentifiers } from "../assets/subject.ts";
import type { EraseOutcome } from "./jsonl-objects.ts";

const BULK = 100;

async function listAll(kv: KVNamespace, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

function mentions(value: string | null, s: SubjectIdentifiers): boolean {
  if (!value) return false;
  return value.includes(s.employeeRef) || value.includes(s.analyticsId) || value.includes(s.workEmail) || value.includes(`"${s.fullName}"`);
}

/** Keys of the subject (by key name) and keys whose value mentions the subject, per cache asset. */
export async function planKvErasure(kv: KVNamespace, s: SubjectIdentifiers): Promise<{ profile: string[]; team: string[] }> {
  const out = { profile: [] as string[], team: [] as string[] };
  for (const [prefix, bucket] of [["profile:", out.profile], ["team:", out.team]] as const) {
    const keys = await listAll(kv, prefix);
    for (let i = 0; i < keys.length; i += BULK) {
      const chunk = keys.slice(i, i + BULK);
      const values = await kv.get(chunk, "text");
      for (const key of chunk) {
        const own = key.endsWith(`:${s.employeeRef}`) || key.endsWith(`:${s.analyticsId}`);
        if (own || mentions(values.get(key) ?? null, s)) bucket.push(key);
      }
    }
  }
  return out;
}

export async function eraseKvCaches(kv: KVNamespace, s: SubjectIdentifiers): Promise<EraseOutcome[]> {
  const plan = await planKvErasure(kv, s);
  for (const key of [...plan.profile, ...plan.team]) await kv.delete(key);
  return [
    { assetId: "cache.kv.profile_cards", rowsBefore: plan.profile.length, rowsErased: plan.profile.length, referencesScrubbed: 0, keysDeleted: plan.profile.length },
    { assetId: "cache.kv.team_rosters", rowsBefore: plan.team.length, rowsErased: plan.team.length, referencesScrubbed: 0, keysDeleted: plan.team.length },
  ];
}
