// The line prefilter (SPEC.md sections 18.5 and 30.3.1): the prefiltered transform is byte-identical to the revision 2
// transform (kept verbatim below as the reference) for deletion of every fixture-world subject (managers, reviewers,
// a held-reference conflict) over objects of all four export formats and the extracts, and for retention
// minimization; and JSON parsing happens only on lines that contain the subject's id. The same equality over every
// object of the full generated population is checked by `npm run bench:cpu` before it measures anything.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deletionRule, transformRows, type RowRule } from "../../src/worker/erase/jsonl-objects.ts";
import { activeHeldRefs } from "../../src/worker/holds/holds.ts";
import { POLICY } from "../../src/worker/policy/compiled.ts";
import { seedObjects, seedWorld, type WorldIdentity } from "../fixtures/seed.ts";

// ---- revision 2 transform (commit 38), the reference ---------------------------------------------------------------
function splitCsvLineRev2(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
const csvCellRev2 = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function transformRowsRev2(body: string, format: "jsonl" | "csv", rule: RowRule) {
  let rowsRemoved = 0;
  let refsScrubbed = 0;
  if (format === "csv") {
    const lines = body.split("\n");
    const header = splitCsvLineRev2(lines[0] ?? "");
    const kept = [lines[0] ?? ""];
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const cells = splitCsvLineRev2(line);
      const row = Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
      if (rule.remove(row)) {
        rowsRemoved++;
        continue;
      }
      let changed = false;
      for (const col of rule.protect?.(row) ? [] : rule.refColumns) {
        if (rule.refValue !== null && row[col] === rule.refValue) {
          row[col] = "REDACTED";
          refsScrubbed++;
          changed = true;
        }
      }
      kept.push(changed ? header.map((h) => csvCellRev2(String(row[h] ?? ""))).join(",") : line);
    }
    return { body: kept.join("\n") + "\n", rowsRemoved, refsScrubbed };
  }
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    if (rule.remove(row)) {
      rowsRemoved++;
      continue;
    }
    let changed = false;
    for (const col of rule.protect?.(row) ? [] : rule.refColumns) {
      if (rule.refValue !== null && row[col] === rule.refValue) {
        row[col] = "REDACTED";
        refsScrubbed++;
        changed = true;
      }
    }
    out.push(changed ? JSON.stringify(row) : line);
  }
  return { body: out.length ? out.join("\n") + "\n" : "", rowsRemoved, refsScrubbed };
}
// ---------------------------------------------------------------------------------------------------------------------

interface Obj {
  key: string;
  body: string;
  format: "jsonl" | "csv";
  part: (typeof POLICY.assets)[number]["parts"][number];
  column: "employee_id" | "analytics_id";
}

let objects: Obj[] = [];
let world: WorldIdentity[] = [];
let heldIds = new Set<string>();

beforeAll(async () => {
  await seedWorld();
  await seedObjects();
  world = (await env.DB.prepare("SELECT * FROM identity_map ORDER BY employee_id").all<WorldIdentity>()).results;
  const refs = await activeHeldRefs(env.DB);
  heldIds = new Set(world.filter((w) => refs.has(w.subject_ref)).map((w) => w.employee_id));
  // a held-reference conflict: a held subject's own row references a manager who is erased below
  const held = world.find((w) => heldIds.has(w.employee_id) && w.manager_employee_id)!;
  const manager = world.find((w) => w.employee_id === held.manager_employee_id)!;
  expect(manager).toBeTruthy();
  const exportsAsset = POLICY.assets.find((a) => a.id === "src.r2.exports")!;
  const extracts = POLICY.assets.find((a) => a.id === "drv.r2.analytics_extracts")!;
  for (const part of exportsAsset.parts) {
    const list = await env.EXPORTS.list({ prefix: part.location! });
    for (const o of list.objects) objects.push({ key: o.key, body: await (await env.EXPORTS.get(o.key))!.text(), format: part.format!, part, column: "employee_id" });
  }
  for (const o of (await env.DERIVED.list({ prefix: extracts.parts[0]!.location! })).objects) {
    objects.push({ key: o.key, body: await (await env.DERIVED.get(o.key))!.text(), format: "jsonl", part: extracts.parts[0]!, column: "analytics_id" });
  }
  expect(objects.map((o) => o.part.name).sort()).toEqual(["attrition", "hris", "leave", "payroll", "performance"]);
});

afterEach(() => vi.restoreAllMocks());

describe("line prefilter", () => {
  it("deletion: byte-identical to revision 2 for every subject of the world, including managers, reviewers and held rows", () => {
    let removed = 0;
    let scrubbed = 0;
    let protectedRefs = 0;
    for (const w of world) {
      for (const o of objects) {
        const value = o.column === "employee_id" ? w.employee_id : w.analytics_id;
        const protect = o.column === "employee_id" ? heldIds : new Set<string>();
        const rule = deletionRule(o.part, o.column, value, protect);
        const { prefilter: _p, ...reference } = rule;
        const got = transformRows(o.body, o.format, rule);
        const want = transformRowsRev2(o.body, o.format, reference);
        expect(got, `${w.employee_id} in ${o.part.name}`).toEqual(want);
        removed += got.rowsRemoved;
        scrubbed += got.refsScrubbed;
        if (o.part.name === "hris") protectedRefs += o.body.split("\n").filter((l) => l.includes(`"manager_employee_id":"${value}"`) && [...heldIds].some((h) => l.includes(`"employee_id":"${h}"`))).length;
      }
    }
    // the comparison covered real work: removals, reference scrubbing and at least one held row left unscrubbed
    expect(removed).toBeGreaterThan(world.length);
    expect(scrubbed).toBeGreaterThan(0);
    expect(protectedRefs).toBeGreaterThan(0);
  });

  it("retention minimization: byte-identical to revision 2 for no, one and all held subjects", () => {
    const heldSets = [new Set<string>(), new Set([...heldIds].slice(0, 1)), heldIds];
    for (const held of heldSets) {
      for (const o of objects.filter((x) => x.column === "employee_id")) {
        const rule: RowRule = { remove: (row) => !held.has(String(row.employee_id)), refColumns: [], refValue: null, prefilter: { needles: [...held], unmatched: "remove" } };
        const { prefilter: _p, ...reference } = rule;
        expect(transformRows(o.body, o.format, rule), `${held.size} held in ${o.part.name}`).toEqual(transformRowsRev2(o.body, o.format, reference));
      }
    }
  });

  it("parses only lines that contain the subject's id", () => {
    const hris = objects.find((o) => o.part.name === "hris")!;
    const w = world.find((x) => hris.body.split("\n").filter((l) => l.includes(x.employee_id)).length >= 2)!;
    const candidates = hris.body.split("\n").filter((l) => l.includes(w.employee_id)).length;
    const parse = vi.spyOn(JSON, "parse");
    transformRows(hris.body, "jsonl", deletionRule(hris.part, "employee_id", w.employee_id));
    expect(parse).toHaveBeenCalledTimes(candidates);
    expect(candidates).toBeLessThan(hris.body.split("\n").filter(Boolean).length);
  });
});
