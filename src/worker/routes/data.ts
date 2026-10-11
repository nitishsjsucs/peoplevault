// Purpose data API (SPEC.md sections 13 and 14.6). Every read names a purpose; the PDP authorizes persona to purpose
// and action, row scope comes from the verified principal, the query is a compiled named query run as the purpose's
// warehouse identity, and columns are filtered again before responding. Every decision is audited.
import { Hono, type Context } from "hono";
import { ExtractBody, IdentityLookupBody } from "../../shared/api-schemas.ts";
import type { Purpose, QueryDef } from "../../shared/policy-types.ts";
import type { AppEnv } from "../app.ts";
import { getProfile, getRoster, putProfile, putRoster, type RosterEntry } from "../cache/profile-cache.ts";
import { audit, errorJson } from "../context.ts";
import { identityByRef, isSubjectSuppressed, suppressedRefs, type RefKind } from "../identity/refs.ts";
import { POLICY, queryFor } from "../policy/compiled.ts";
import { columnsFor, decide, filterColumns, type Action, type Decision } from "../policy/pdp.ts";
import { WarehouseError, type QueryParams } from "../warehouse/client.ts";

export const data = new Hono<AppEnv>();

const PAGE = 100;
const R = {
  list: "/api/v1/purposes/:purpose/employees",
  profile: "/api/v1/purposes/:purpose/employees/:ref",
  team: "/api/v1/purposes/team_management/team",
  dataset: "/api/v1/purposes/workforce_analytics/datasets/:name",
  extract: "/api/v1/purposes/workforce_analytics/extracts",
  lookup: "/api/v1/purposes/:purpose/identity-lookup",
} as const;

type Allowed = Extract<Decision, { allow: true }>;

async function authorize(c: Context<AppEnv>, purpose: string, action: Action, route: string): Promise<Allowed | Response> {
  const d = decide({ principal: c.get("principal"), purpose, action });
  if (!d.allow) {
    await audit(c, { purpose: POLICY.purposes[purpose as Purpose] ? purpose : null, action, route, decision: "deny", reason: d.reason });
    return c.json({ error: d.status === 404 ? "not_found" : "forbidden", code: d.reason }, d.status);
  }
  return d;
}

async function denyAfter(c: Context<AppEnv>, purpose: string, action: Action, route: string, status: 400 | 404, code: string): Promise<Response> {
  await audit(c, { purpose, action, route, decision: "deny", reason: code });
  return errorJson(c, status, code);
}

async function scopeParams(c: Context<AppEnv>, d: Allowed): Promise<QueryParams> {
  switch (d.rowScope.kind) {
    case "org_units":
      return { org_units: d.rowScope.orgUnits };
    case "direct_reports":
      return { manager_key: await c.get("pseudo").pseudonym("warehouse_key", d.rowScope.managerEmployeeId) };
    default:
      return {};
  }
}

function pickParams(q: QueryDef, all: QueryParams): QueryParams {
  const out: QueryParams = {};
  for (const name of Object.keys(q.params)) {
    const v = all[name];
    if (v === undefined) throw new WarehouseError("bad_params");
    out[name] = v;
  }
  return out;
}

async function runAll(c: Context<AppEnv>, q: QueryDef, purpose: Purpose, base: QueryParams): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const params = q.pagedBy ? { ...base, cursor, limit: PAGE } : base;
    const res = await c.get("warehouse").run(q.id, purpose, pickParams(q, params));
    out.push(...res.rows);
    if (!q.pagedBy || res.rows.length < PAGE) break;
    cursor = String(res.rows[res.rows.length - 1]![q.pagedBy]);
  }
  return out;
}

function rejectUnknownParams(c: Context<AppEnv>, allowed: string[]): string | null {
  for (const k of Object.keys(c.req.queries())) if (!allowed.includes(k)) return k;
  return null;
}

async function withWarehouse<T>(c: Context<AppEnv>, fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof WarehouseError) {
      console.error("warehouse_error", e.code);
      return errorJson(c, 502, e.code);
    }
    throw e;
  }
}

// ---- list ---------------------------------------------------------------------------------------------------------
data.get(R.list, async (c) => {
  const purpose = c.req.param("purpose");
  const d = await authorize(c, purpose, "list_employees", R.list);
  if (d instanceof Response) return d;
  if (rejectUnknownParams(c, ["cursor"])) return denyAfter(c, purpose, "list_employees", R.list, 400, "unsupported_parameter");
  const q = queryFor(d.purpose!, "list");
  if (!q) return denyAfter(c, purpose, "list_employees", R.list, 404, "no_list_for_purpose");
  const cursor = c.req.query("cursor") ?? "";
  const out = await withWarehouse(c, async () => {
    const res = await c.get("warehouse").run(q.id, d.purpose!, pickParams(q, { ...(await scopeParams(c, d)), cursor, limit: PAGE }));
    const refKind = POLICY.purposes[d.purpose!].ref as RefKind;
    const hidden = await suppressedRefs(c.env.DB, refKind);
    const rows = filterColumns(res.rows, columnsFor(q)).filter((r) => !hidden.has(String(r[refKind])));
    const nextCursor = res.rows.length === PAGE ? String(res.rows[res.rows.length - 1]![q.pagedBy!]) : null;
    return { rows, nextCursor };
  });
  if (out instanceof Response) return out;
  await audit(c, { purpose, action: "list_employees", route: R.list, decision: "allow", reason: "ok", rowCount: out.rows.length });
  return c.json({ rows: out.rows, columns: columnsFor(q), nextCursor: out.nextCursor });
});

// ---- profile ------------------------------------------------------------------------------------------------------
data.get(R.profile, async (c) => {
  const purpose = c.req.param("purpose");
  const ref = c.req.param("ref");
  const d = await authorize(c, purpose, "read_profile", R.profile);
  if (d instanceof Response) return d;
  if (rejectUnknownParams(c, [])) return denyAfter(c, purpose, "read_profile", R.profile, 400, "unsupported_parameter");
  const p = POLICY.purposes[d.purpose!];
  const refKind = p.ref as RefKind;
  const q = queryFor(d.purpose!, "profile");
  if (!q || !ref.startsWith(p.refPrefix)) return denyAfter(c, purpose, "read_profile", R.profile, 404, "not_found");
  const ident = await identityByRef(c.env.DB, refKind, ref);
  if (!ident || ident.suppressed) return denyAfter(c, purpose, "read_profile", R.profile, 404, "not_found");
  const principal = c.get("principal");
  const ownRef = principal.employeeId ? await c.get("pseudo").pseudonym("employee_ref", principal.employeeId) : null;
  const cached = await getProfile(c.env.CACHE, purpose, ref);
  if (cached) {
    const inScope =
      d.rowScope.kind === "org_units" ? d.rowScope.orgUnits.includes(String(cached.scope.org_unit)) : d.rowScope.kind === "direct_reports" ? cached.scope.manager_ref === ownRef : true;
    if (!inScope) return denyAfter(c, purpose, "read_profile", R.profile, 404, "not_found");
    await audit(c, { purpose, action: "read_profile", route: R.profile, subjectRef: ident.subjectRef, decision: "allow", reason: "ok", rowCount: 1, detail: { cache: "hit" } });
    return c.json({ profile: cached.profile, columns: columnsFor(q) });
  }
  const out = await withWarehouse(c, async () => {
    const params: QueryParams = { ...(await scopeParams(c, d)), [refKind]: ref };
    const res = await c.get("warehouse").run(q.id, d.purpose!, pickParams(q, params));
    return res.rows;
  });
  if (out instanceof Response) return out;
  if (out.length !== 1) return denyAfter(c, purpose, "read_profile", R.profile, 404, "not_found");
  const [profile] = filterColumns(out, columnsFor(q));
  const scope = d.rowScope.kind === "org_units" ? { org_unit: String(out[0]!.org_unit) } : d.rowScope.kind === "direct_reports" && ownRef ? { manager_ref: ownRef } : {};
  // A deletion may have started while the warehouse was read: never cache a suppressed subject.
  if (!(await isSubjectSuppressed(c.env.DB, ident.subjectRef))) await putProfile(c.env.CACHE, purpose, ref, { v: 1, profile: profile!, scope });
  await audit(c, { purpose, action: "read_profile", route: R.profile, subjectRef: ident.subjectRef, decision: "allow", reason: "ok", rowCount: 1, detail: { cache: "miss" } });
  return c.json({ profile, columns: columnsFor(q) });
});

// ---- team roster --------------------------------------------------------------------------------------------------
data.get(R.team, async (c) => {
  const d = await authorize(c, "team_management", "list_employees", R.team);
  if (d instanceof Response) return d;
  const principal = c.get("principal");
  if (!principal.employeeId) return denyAfter(c, "team_management", "list_employees", R.team, 404, "not_found");
  const pseudo = c.get("pseudo");
  const managerRef = await pseudo.pseudonym("employee_ref", principal.employeeId);
  // A suppressed manager's own roster is neither served nor cached.
  if (await isSubjectSuppressed(c.env.DB, await pseudo.pseudonym("subject_ref", principal.employeeId))) {
    return denyAfter(c, "team_management", "list_employees", R.team, 404, "not_found");
  }
  const hidden = await suppressedRefs(c.env.DB, "employee_ref");
  let roster = await getRoster(c.env.CACHE, managerRef);
  let cache = "hit";
  if (!roster) {
    cache = "miss";
    const q = queryFor("team_management", "list")!;
    const rows = await withWarehouse(c, async () => runAll(c, q, "team_management", await scopeParams(c, d)));
    if (rows instanceof Response) return rows;
    roster = filterColumns(rows, columnsFor(q))
      .filter((r) => !hidden.has(String(r.employee_ref)))
      .map((r) => ({ employee_ref: String(r.employee_ref), full_name: String(r.full_name), job_title: String(r.job_title) }));
    await putRoster(c.env.CACHE, managerRef, roster);
  }
  const visible: RosterEntry[] = roster.filter((r) => !hidden.has(r.employee_ref));
  await audit(c, { purpose: "team_management", action: "list_employees", route: R.team, decision: "allow", reason: "ok", rowCount: visible.length, detail: { cache } });
  return c.json({ rows: visible });
});

// ---- analytics datasets -------------------------------------------------------------------------------------------
data.get(R.dataset, async (c) => {
  const name = c.req.param("name");
  const d = await authorize(c, "workforce_analytics", "read_dataset", R.dataset);
  if (d instanceof Response) return d;
  const q = name === "attrition_features" || name === "headcount_monthly" ? queryFor("workforce_analytics", name) : undefined;
  if (!q) return denyAfter(c, "workforce_analytics", "read_dataset", R.dataset, 404, "unknown_dataset");
  const allowed = name === "attrition_features" ? ["month", "cursor"] : [];
  if (rejectUnknownParams(c, allowed)) return denyAfter(c, "workforce_analytics", "read_dataset", R.dataset, 400, "unsupported_parameter");
  const month = c.req.query("month") ?? "";
  if (name === "attrition_features" && !/^\d{4}-\d{2}-01$/.test(month)) return denyAfter(c, "workforce_analytics", "read_dataset", R.dataset, 400, "month_required");
  const out = await withWarehouse(c, async () => {
    const params: QueryParams = name === "attrition_features" ? { month, cursor: c.req.query("cursor") ?? "", limit: PAGE } : {};
    const res = await c.get("warehouse").run(q.id, "workforce_analytics", pickParams(q, params));
    const hidden = await suppressedRefs(c.env.DB, "analytics_id");
    return filterColumns(res.rows, columnsFor(q)).filter((r) => !("analytics_id" in r) || !hidden.has(String(r.analytics_id)));
  });
  if (out instanceof Response) return out;
  await audit(c, { purpose: "workforce_analytics", action: "read_dataset", route: R.dataset, decision: "allow", reason: "ok", rowCount: out.length });
  return c.json({ rows: out, columns: columnsFor(q) });
});

// ---- analytics extracts (R2 pv-derived) ---------------------------------------------------------------------------
export const EXTRACT_FIELDS = ["analytics_id", "org_unit", "job_level", "salary_band", "rating_band", "tenure_years", "age_band", "gender", "terminated_in_month"];
export const extractKey = (month: string) => `extracts/workforce_analytics/attrition/month=${month}/attrition.jsonl`;

data.post(R.extract, async (c) => {
  const d = await authorize(c, "workforce_analytics", "create_extract", R.extract);
  if (d instanceof Response) return d;
  const body = ExtractBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return denyAfter(c, "workforce_analytics", "create_extract", R.extract, 400, "invalid_body");
  const month = body.data.month;
  const q = queryFor("workforce_analytics", "attrition_features")!;
  const rows = await withWarehouse(c, async () => runAll(c, q, "workforce_analytics", { month: `${month}-01` }));
  if (rows instanceof Response) return rows;
  const hidden = await suppressedRefs(c.env.DB, "analytics_id");
  const kept = filterColumns(rows, columnsFor(q)).filter((r) => !hidden.has(String(r.analytics_id)));
  const jsonl = kept.map((r) => JSON.stringify(Object.fromEntries(EXTRACT_FIELDS.map((f) => [f, r[f] ?? null])))).join("\n") + (kept.length ? "\n" : "");
  const key = extractKey(month);
  await c.env.DERIVED.put(key, jsonl, {
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { purpose: "workforce_analytics", subject_key: "analytics_id", created_by: c.get("principal").id, month },
  });
  await audit(c, { purpose: "workforce_analytics", action: "create_extract", route: R.extract, decision: "allow", reason: "ok", rowCount: kept.length });
  return c.json({ key, rows: kept.length }, 201);
});

// ---- identity lookup (POST only: names and email prefixes never reach a URL) -------------------------------------
data.post(R.lookup, async (c) => {
  const purpose = c.req.param("purpose");
  const d = await authorize(c, purpose, "identity_lookup", R.lookup);
  if (d instanceof Response) return d;
  const body = IdentityLookupBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return denyAfter(c, purpose, "identity_lookup", R.lookup, 400, "invalid_query");
  const q = queryFor(d.purpose!, "identity_lookup");
  if (!q) return denyAfter(c, purpose, "identity_lookup", R.lookup, 404, "not_found");
  const out = await withWarehouse(c, async () => {
    const res = await c.get("warehouse").run(q.id, d.purpose!, { q: body.data.q });
    const hidden = await suppressedRefs(c.env.DB, "employee_ref");
    return filterColumns(res.rows, columnsFor(q)).filter((r) => !hidden.has(String(r.employee_ref)));
  });
  if (out instanceof Response) return out;
  await audit(c, { purpose, action: "identity_lookup", route: R.lookup, decision: "allow", reason: "ok", rowCount: out.length });
  return c.json({ rows: out, columns: columnsFor(q) });
});
