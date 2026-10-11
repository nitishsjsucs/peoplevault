// Independent R2 probe: lists both whole buckets (not only registered prefixes) and scans every key name, every
// custom metadata value and every line of every object body. Shares no code with erasure (ADR 0003).
import type { TokenMatcher } from "./tokens.ts";
import { anyTokenIncluded, countMatches, redactLocation } from "./tokens.ts";
import { r2AssetFor, type Finding, type ProbeResult } from "./findings.ts";

export async function probeR2(buckets: { name: string; bucket: R2Bucket }[], matchers: TokenMatcher[]): Promise<ProbeResult> {
  const findings: Finding[] = [];
  const errors: ProbeResult["errors"] = [];
  let scanned = 0;
  for (const { name, bucket } of buckets) {
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}), include: ["customMetadata"] });
      for (const o of page.objects) {
        scanned++;
        const location = `${name}/${o.key}`;
        try {
          let matches = countMatches(null, o.key, matchers);
          for (const v of Object.values(o.customMetadata ?? {})) matches += countMatches(null, v, matchers);
          const obj = await bucket.get(o.key);
          if (obj) {
            const text = await obj.text();
            if (anyTokenIncluded(text, matchers)) {
              for (const line of text.split("\n")) if (line && countMatches(null, line, matchers)) matches++;
            }
          }
          if (matches > 0) findings.push({ store: "r2", location: redactLocation(location, matchers), assetId: r2AssetFor(name, o.key), matches });
        } catch {
          errors.push({ store: "r2", location: redactLocation(location, matchers), error: "read_failed" });
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return { findings, errors, scanned };
}
