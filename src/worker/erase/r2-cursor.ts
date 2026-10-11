// Byte-capped cursor over the registered R2 parts for erasure (SPEC.md section 30.3.1). Workers Free allows 10 ms of
// CPU per Workflow step, so one step decodes at most R2_ERASE_STEP_BYTES of whole objects (always at least one) and
// hands the rest to the next step through a cursor `{ part, pos, digest, restarts }`:
//   part     index into the registered parts in policy order (the 4 export families, then the extracts)
//   pos      index into the part's sorted key listing
//   digest   SHA-256 of the newline-joined sorted keys, recorded by the step that started the part
// Each step lists its part again and compares the digest; a changed listing (an object added or removed between
// steps) restarts the part at pos 0 with the new digest, at most 3 times, then the step throws and the request fails
// closed. Erasure is idempotent, so a restart only costs time. Step outputs carry indexes, digests and counts only,
// never a key (a key can hold an identifier: eval fault 6 puts an employee id in a key name).
import type { AssetPart } from "../../shared/policy-types.ts";
import { asset } from "../assets/registry.ts";

export interface R2PartRef {
  binding: "EXPORTS" | "DERIVED";
  assetId: string;
  part: AssetPart;
  subjectColumn: "employee_id" | "analytics_id";
}

export interface ListingCursor {
  part: number;
  pos: number;
  digest: string | null;
  restarts: number;
}

export const CURSOR_START: ListingCursor = { part: 0, pos: 0, digest: null, restarts: 0 };
export const MAX_RESTARTS = 3;
/** A cursor loop longer than this is a bug (the full population takes 3 erase steps). */
export const MAX_CURSOR_STEPS = 200;

export class ListingChanged extends Error {
  override name = "ListingChanged";
}

/** The registered R2 parts in policy order: the export families of src.r2.exports, then the analytics extracts. */
export function registeredR2Parts(): R2PartRef[] {
  const exportsAsset = asset("src.r2.exports");
  const extracts = asset("drv.r2.analytics_extracts");
  return [
    ...exportsAsset.parts.map((part) => ({ binding: "EXPORTS" as const, assetId: exportsAsset.id, part, subjectColumn: "employee_id" as const })),
    ...extracts.parts.map((part) => ({ binding: "DERIVED" as const, assetId: extracts.id, part, subjectColumn: "analytics_id" as const })),
  ];
}

export async function listSorted(bucket: R2Bucket, prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    out.push(...page.objects.map((o) => ({ key: o.key, size: o.size })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export async function keysDigest(keys: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(keys.join("\n")));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CursorWalk {
  cursor: ListingCursor;
  done: boolean;
  bytes: number;
  objects: number;
}

/**
 * Visits whole objects from the cursor until the byte cap (at least one object per call), crossing into later parts
 * while the budget lasts. `visit` does the work on one object; the walk never returns a key.
 */
export async function walkParts(
  env: Pick<Env, "EXPORTS" | "DERIVED">,
  parts: R2PartRef[],
  start: ListingCursor,
  capBytes: number,
  visit: (ref: R2PartRef, key: string) => Promise<void>,
): Promise<CursorWalk> {
  let c = { ...start };
  let bytes = 0;
  let objects = 0;
  while (c.part < parts.length) {
    const ref = parts[c.part]!;
    const listing = await listSorted(env[ref.binding], ref.part.location ?? "");
    const digest = await keysDigest(listing.map((o) => o.key));
    if (c.digest === null) c = { ...c, digest };
    else if (c.digest !== digest) {
      if (c.restarts >= MAX_RESTARTS) throw new ListingChanged(`the listing of part ${c.part} changed more than ${MAX_RESTARTS} times`);
      c = { ...c, pos: 0, digest, restarts: c.restarts + 1 };
    }
    while (c.pos < listing.length) {
      const o = listing[c.pos]!;
      if (objects > 0 && bytes + o.size > capBytes) return { cursor: c, done: false, bytes, objects };
      await visit(ref, o.key);
      bytes += o.size;
      objects++;
      c = { ...c, pos: c.pos + 1 };
    }
    c = { part: c.part + 1, pos: 0, digest: null, restarts: 0 };
  }
  return { cursor: c, done: true, bytes, objects };
}
