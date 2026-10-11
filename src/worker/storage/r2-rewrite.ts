// Compare-and-swap rewrites of R2 objects (SPEC.md section 9.1). get (body + etag), pure transform, then
// put(onlyIf: { etagMatches }). A null result means another writer changed the object in between: re-read and retry
// with full-jitter backoff (25 to 400 ms, at most 25 attempts, then throw so the Workflow step retry takes over).
// A null transform body deletes the object, conditionally: an empty body is written with the evaluated etag first.
// Without this, concurrent deletions rewriting the same object lose each other's removals.

export interface TransformResult {
  body: string | null;
  rowsRemoved: number;
  refsScrubbed: number;
}

export interface RewriteResult {
  key: string;
  changed: boolean;
  deleted: boolean;
  attempts: number;
  rowsRemoved: number;
  refsScrubbed: number;
}

export class RewriteConflictError extends Error {
  override name = "RewriteConflictError";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (attempt: number) => Math.floor(Math.random() * Math.min(400, 25 * 2 ** attempt)) + 1;

export async function rewriteObject(
  bucket: R2Bucket,
  key: string,
  transform: (body: string, meta: Record<string, string>) => TransformResult,
  opts: { maxAttempts?: number; metadata?: Record<string, string> } = {},
): Promise<RewriteResult> {
  const max = opts.maxAttempts ?? 25;
  for (let attempt = 1; attempt <= max; attempt++) {
    const obj = await bucket.get(key);
    if (!obj) return { key, changed: false, deleted: false, attempts: attempt, rowsRemoved: 0, refsScrubbed: 0 };
    const text = await obj.text();
    const meta = obj.customMetadata ?? {};
    const out = transform(text, meta);
    if (out.rowsRemoved === 0 && out.refsScrubbed === 0 && out.body !== null) {
      return { key, changed: false, deleted: false, attempts: attempt, rowsRemoved: 0, refsScrubbed: 0 };
    }
    const customMetadata = { ...meta, ...(opts.metadata ?? {}), pv_rows_removed: String(Number(meta.pv_rows_removed ?? 0) + out.rowsRemoved) };
    const put = await bucket.put(key, out.body ?? "", {
      onlyIf: { etagMatches: obj.etag },
      customMetadata,
      ...(obj.httpMetadata ? { httpMetadata: obj.httpMetadata } : {}),
    });
    if (put !== null) {
      if (out.body === null) await bucket.delete(key);
      return { key, changed: true, deleted: out.body === null, attempts: attempt, rowsRemoved: out.rowsRemoved, refsScrubbed: out.refsScrubbed };
    }
    await sleep(jitter(attempt));
  }
  throw new RewriteConflictError(`rewrite of an object did not converge after ${max} attempts`);
}
