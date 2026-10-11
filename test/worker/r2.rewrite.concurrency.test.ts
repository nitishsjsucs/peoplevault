import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { transformRows } from "../../src/worker/erase/jsonl-objects.ts";
import { rewriteObject } from "../../src/worker/storage/r2-rewrite.ts";

const KEY = "exports/hris/employees/dt=2026-01-05/employees.jsonl";
const ids = Array.from({ length: 11 }, (_, i) => `E2${String(i).padStart(4, "0")}`);
const body = ids.map((id) => JSON.stringify({ employee_id: id, manager_employee_id: null })).join("\n") + "\n";
const remover = (id: string) => (text: string) => transformRows(text, "jsonl", { remove: (r) => r.employee_id === id, refColumns: [], refValue: null });

describe("compare-and-swap R2 rewrites", () => {
  it("10 concurrent subject removals over one shared object leave all 10 subjects absent", async () => {
    await env.EXPORTS.put(KEY, body);
    const results = await Promise.all(ids.slice(0, 10).map((id) => rewriteObject(env.EXPORTS, KEY, remover(id))));
    const text = await (await env.EXPORTS.get(KEY))!.text();
    for (const id of ids.slice(0, 10)) expect(text).not.toContain(id);
    expect(text).toContain(ids[10]);
    expect(results.every((r) => r.changed && r.rowsRemoved === 1)).toBe(true);
    expect(results.reduce((n, r) => n + r.attempts, 0)).toBeGreaterThanOrEqual(10);
  });

  it("a stale etag never overwrites", async () => {
    await env.EXPORTS.put(KEY, "a\n");
    const stale = (await env.EXPORTS.head(KEY))!.etag;
    await env.EXPORTS.put(KEY, "b\n");
    const res = await env.EXPORTS.put(KEY, "c\n", { onlyIf: { etagMatches: stale } });
    expect(res).toBeNull();
    expect(await (await env.EXPORTS.get(KEY))!.text()).toBe("b\n");
  });

  it("retention minimization racing a deletion keeps both effects", async () => {
    await env.EXPORTS.put(KEY, body);
    const held = new Set([ids[0], ids[1]]);
    const minimize = (text: string) => transformRows(text, "jsonl", { remove: (r) => !held.has(String(r.employee_id)), refColumns: [], refValue: null });
    // a deletion of a held subject's colleague and a minimization race; then a deletion of a held subject is impossible
    await Promise.all([rewriteObject(env.EXPORTS, KEY, minimize), rewriteObject(env.EXPORTS, KEY, remover(ids[5]!)), rewriteObject(env.EXPORTS, KEY, remover(ids[6]!))]);
    const lines = (await (await env.EXPORTS.get(KEY))!.text()).trim().split("\n").map((l) => JSON.parse(l).employee_id);
    expect(lines.sort()).toEqual([ids[0], ids[1]].sort());
  });

  it("a null transform deletes the object conditionally", async () => {
    await env.EXPORTS.put(KEY, body);
    const res = await rewriteObject(env.EXPORTS, KEY, () => ({ body: null, rowsRemoved: 11, refsScrubbed: 0 }));
    expect(res).toMatchObject({ changed: true, deleted: true });
    expect(await env.EXPORTS.get(KEY)).toBeNull();
  });
});
