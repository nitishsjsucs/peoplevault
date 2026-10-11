// Independent KV probe: lists every key in CACHE and bulk-reads every value (100 keys per call, the KV maximum).
import { anyTokenIncluded, countMatches, redactLocation, type TokenMatcher } from "./tokens.ts";
import { kvAssetFor, type Finding, type ProbeResult } from "./findings.ts";

export const KV_BULK = 100;

export async function probeKv(kv: KVNamespace, matchers: TokenMatcher[]): Promise<ProbeResult> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list(cursor ? { cursor } : {});
    keys.push(...page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const findings: Finding[] = [];
  const errors: ProbeResult["errors"] = [];
  for (let i = 0; i < keys.length; i += KV_BULK) {
    const chunk = keys.slice(i, i + KV_BULK);
    let values: Map<string, string | null>;
    try {
      values = await kv.get(chunk, "text");
    } catch {
      for (const k of chunk) errors.push({ store: "kv", location: redactLocation(k, matchers), error: "read_failed" });
      continue;
    }
    for (const key of chunk) {
      const value = values.get(key) ?? "";
      let matches = countMatches(null, key, matchers);
      if (value && anyTokenIncluded(value, matchers)) matches += countMatches(null, value, matchers);
      if (matches > 0) findings.push({ store: "kv", location: redactLocation(key, matchers), assetId: kvAssetFor(key), matches });
    }
  }
  return { findings, errors, scanned: keys.length };
}
