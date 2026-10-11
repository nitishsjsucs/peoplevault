// Independent R2 probe: lists both whole buckets (not only registered prefixes) and scans every key name, every
// custom metadata value and every line of every object body. Shares no code with erasure (ADR 0003).
//
// Workers Free (SPEC.md section 30.3.1): one Workflow step decodes at most R2_PROBE_STEP_BYTES of whole objects
// (always at least one) and continues in the next step from a cursor `{ bucket, pos, digest, restarts }`. Each step
// lists its bucket again and compares the SHA-256 of the sorted keys with the digest recorded when the bucket was
// started; a changed listing rescans that bucket from pos 0 (at most 3 times, then the step throws and the request
// fails closed), so no object is ever skipped. The cursor carries indexes and a digest only, never a key.
import type { TokenMatcher } from "./tokens.ts";
import { countMatches, re2Escape, redactLocation } from "./tokens.ts";
import { r2AssetFor, type Finding, type ProbeResult } from "./findings.ts";

export interface ProbeBucket {
  name: string;
  bucket: R2Bucket;
}

export interface ProbeCursor {
  bucket: number;
  pos: number;
  digest: string | null;
  restarts: number;
}

export const PROBE_START: ProbeCursor = { bucket: 0, pos: 0, digest: null, restarts: 0 };
export const PROBE_MAX_RESTARTS = 3;

export class ProbeListingChanged extends Error {
  override name = "ProbeListingChanged";
}

interface Listed {
  key: string;
  size: number;
  meta: Record<string, string>;
}

async function listBucket(bucket: R2Bucket): Promise<Listed[]> {
  const out: Listed[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}), include: ["customMetadata"] });
    out.push(...page.objects.map((o) => ({ key: o.key, size: o.size, meta: o.customMetadata ?? {} })));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

async function sortedKeysDigest(objects: Listed[]): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(objects.map((o) => o.key).join("\n")));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

const occurrenceCache = new WeakMap<TokenMatcher[], RegExp | null>();

/** One regular expression for every token as a literal: a single pass finds an occurrence of any of them (much
 * cheaper in V8 than one indexOf per token over a large body). */
function occurrences(matchers: TokenMatcher[]): RegExp | null {
  if (!occurrenceCache.has(matchers)) {
    const tokens = [...new Set(matchers.map((m) => m.token).filter((t) => t.length > 0))];
    occurrenceCache.set(matchers, tokens.length ? new RegExp(tokens.map(re2Escape).join("|"), "g") : null);
  }
  return occurrenceCache.get(matchers)!;
}

/**
 * Lines of `text` in which some matcher matches. Every matcher needs its token inside the value (exact columns
 * compare equal, the others test `includes` first), so only lines that contain a token occurrence can match: one
 * pass finds the occurrences and only their lines are tested. The count equals testing every line, and the cost stays
 * one pass over the body however many lines hold the subject (SPEC.md section 30.3.1, Free's 10 ms of CPU).
 */
export function countMatchingLines(text: string, matchers: TokenMatcher[]): number {
  const rx = occurrences(matchers);
  if (!rx) return 0;
  let n = 0;
  rx.lastIndex = 0;
  for (let hit = rx.exec(text); hit !== null; hit = rx.exec(text)) {
    const start = text.lastIndexOf("\n", hit.index) + 1;
    const nl = text.indexOf("\n", hit.index);
    const end = nl === -1 ? text.length : nl;
    if (countMatches(null, text.slice(start, end), matchers) > 0) n++;
    if (nl === -1) break;
    rx.lastIndex = end + 1; // the rest of this line is already decided
  }
  return n;
}

async function scanObject(name: string, bucket: R2Bucket, o: Listed, matchers: TokenMatcher[], findings: Finding[], errors: ProbeResult["errors"]): Promise<void> {
  const location = `${name}/${o.key}`;
  try {
    let matches = countMatches(null, o.key, matchers);
    for (const v of Object.values(o.meta)) matches += countMatches(null, v, matchers);
    const obj = await bucket.get(o.key);
    if (obj) matches += countMatchingLines(await obj.text(), matchers);
    if (matches > 0) findings.push({ store: "r2", location: redactLocation(location, matchers), assetId: r2AssetFor(name, o.key), matches });
  } catch {
    errors.push({ store: "r2", location: redactLocation(location, matchers), error: "read_failed" });
  }
}

export interface ProbeStepResult extends ProbeResult {
  cursor: ProbeCursor;
  done: boolean;
  bytes: number;
}

/** One probe step: scans whole objects from the cursor until the byte cap, crossing into the next bucket if room. */
export async function probeR2Step(buckets: ProbeBucket[], matchers: TokenMatcher[], start: ProbeCursor, capBytes: number): Promise<ProbeStepResult> {
  const findings: Finding[] = [];
  const errors: ProbeResult["errors"] = [];
  let c = { ...start };
  let bytes = 0;
  let scanned = 0;
  while (c.bucket < buckets.length) {
    const { name, bucket } = buckets[c.bucket]!;
    const listing = await listBucket(bucket);
    const digest = await sortedKeysDigest(listing);
    if (c.digest === null) c = { ...c, digest };
    else if (c.digest !== digest) {
      if (c.restarts >= PROBE_MAX_RESTARTS) throw new ProbeListingChanged(`the listing of bucket ${c.bucket} changed more than ${PROBE_MAX_RESTARTS} times`);
      c = { ...c, pos: 0, digest, restarts: c.restarts + 1 };
    }
    while (c.pos < listing.length) {
      const o = listing[c.pos]!;
      if (scanned > 0 && bytes + o.size > capBytes) return { findings, errors, scanned, cursor: c, done: false, bytes };
      await scanObject(name, bucket, o, matchers, findings, errors);
      bytes += o.size;
      scanned++;
      c = { ...c, pos: c.pos + 1 };
    }
    c = { bucket: c.bucket + 1, pos: 0, digest: null, restarts: 0 };
  }
  return { findings, errors, scanned, cursor: c, done: true, bytes };
}

/** The whole probe in one call (tests and tools): steps until done with an unlimited byte cap. */
export async function probeR2(buckets: ProbeBucket[], matchers: TokenMatcher[]): Promise<ProbeResult> {
  const res = await probeR2Step(buckets, matchers, PROBE_START, Number.MAX_SAFE_INTEGER);
  return { findings: res.findings, errors: res.errors, scanned: res.scanned };
}
