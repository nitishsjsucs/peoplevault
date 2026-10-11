// Same-origin JSON client for the Worker API (SPEC.md sections 11.5 and 13). The console holds no token: the browser
// sends the CF_Authorization cookie (set by Cloudflare Access, or by /dev/login locally). Every mutating call and the
// identity lookup send the CSRF header, and lookups are POST bodies, so names and email prefixes never reach a URL.
import { AUDIT_VERIFY_WINDOW } from "../shared/limits.ts";

export const CSRF_HEADER = "X-PV-Requested-With";
export const CSRF_VALUE = "peoplevault";

export type Persona = "hr_partner" | "manager" | "people_analyst" | "privacy_officer";
export type Purpose = "employee_relations" | "team_management" | "workforce_analytics" | "privacy_compliance" | "legal_hold_management";
export type Visibility = "allow" | "deny" | "mask_nullify" | "mask_date_year";
export type RequestStatus = "received" | "held" | "running" | "completed" | "completed_with_residuals" | "failed";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type Json = Record<string, unknown>;

export async function api<T>(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers[CSRF_HEADER] = CSRF_VALUE;
    headers["Content-Type"] = "application/json";
  }
  // An expired Access session answers with a redirect to the team's login page; following it from fetch would fail
  // as a cross-origin request, so the redirect is read as "signed out" and the page reload signs in again.
  const res = await fetch(path, { method, headers, credentials: "same-origin", redirect: "manual", ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  if (res.type === "opaqueredirect" || res.status === 0) throw new ApiError(401, "unauthenticated");
  const data = (await res.json().catch(() => null)) as Json | null;
  if (!res.ok) throw new ApiError(res.status, String(data?.code ?? data?.error ?? "error"));
  return data as T;
}

const seg = encodeURIComponent;

function query(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

// ---- who am I ---------------------------------------------------------------------------------------------------------
export interface Me {
  principalId: string;
  persona: Persona;
  purposes: Purpose[];
}
export const getMe = () => api<Me>("/api/v1/me");

export interface DevPrincipal {
  id: string;
  kind: "human" | "system";
  persona: Persona | null;
  status: string;
}

/** Local dev login (AUTH_MODE=local-jwks on a loopback host); null when /dev/* answers 404, as in production. */
export async function getDevPrincipals(): Promise<DevPrincipal[] | null> {
  try {
    return (await api<{ principals: DevPrincipal[] }>("/dev/principals")).principals;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
export const devLogin = (principalId: string) => api<{ ok: boolean; principalId: string; persona: Persona | null }>(`/dev/login${query({ principal: principalId })}`);
export const devLogout = () => api<{ ok: boolean }>("/dev/logout");
/** Cloudflare Access logout for the application's hostname. */
export const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

// ---- purpose-scoped data ----------------------------------------------------------------------------------------------
export type Row = Record<string, unknown>;
export interface EmployeePage {
  rows: Row[];
  columns: Record<string, Visibility>;
  nextCursor: string | null;
}
export const getEmployees = (purpose: Purpose, cursor: string | null) => api<EmployeePage>(`/api/v1/purposes/${seg(purpose)}/employees${query({ cursor })}`);
export const getProfile = (purpose: Purpose, ref: string) => api<{ profile: Row; columns: Record<string, Visibility> }>(`/api/v1/purposes/${seg(purpose)}/employees/${seg(ref)}`);

export interface LookupRow {
  employee_ref: string;
  full_name: string;
  work_email: string;
  org_unit: string;
  employment_status: string;
}
export const identityLookup = (purpose: "privacy_compliance" | "legal_hold_management", q: string) =>
  api<{ rows: LookupRow[] }>(`/api/v1/purposes/${seg(purpose)}/identity-lookup`, { method: "POST", body: { q } });

// ---- deletion requests ------------------------------------------------------------------------------------------------
export interface DeletionRequest {
  id: string;
  kind: "dsr" | "retention";
  subjectRef: string;
  status: RequestStatus;
  requestedBy: string;
  workflowInstanceId: string | null;
  createdAt: string;
  completedAt: string | null;
  admittedAt: string | null;
  summary: Json | null;
}
export interface AssetResult {
  asset_id: string;
  category: string;
  applicability: string;
  rows_before: number | null;
  rows_erased: number | null;
  references_scrubbed: number | null;
  action_status: string;
  verify_status: string;
  verify_matches: number | null;
  verified_at: string | null;
}
export interface Residual {
  id: string;
  asset_id: string;
  kind: string;
  state: string;
  evidence: string;
  expected_clear_at: string | null;
  cleared_at: string | null;
}
export interface Started {
  requestId: string;
  status: "received";
  deferred?: boolean;
  instanceId?: string | null;
}

export const listRequests = (status: RequestStatus | null) => api<{ requests: DeletionRequest[] }>(`/api/v1/privacy/deletion-requests${query({ status })}`);
export const getRequest = (id: string) => api<{ request: DeletionRequest; assets: AssetResult[]; residuals: Residual[] }>(`/api/v1/privacy/deletion-requests/${seg(id)}`);
export const getReceipt = (id: string) => api<{ receipt: Json; audit: { seq: number; hash: string } | null }>(`/api/v1/privacy/deletion-requests/${seg(id)}/receipt`);
export const createRequest = (employeeRef: string, reason: string) => api<Started>("/api/v1/privacy/deletion-requests", { method: "POST", body: { employee_ref: employeeRef, reason } });
export const retryRequest = (id: string) => api<Started>(`/api/v1/privacy/deletion-requests/${seg(id)}/retry`, { method: "POST", body: {} });

// ---- legal holds ------------------------------------------------------------------------------------------------------
export interface Hold {
  id: string;
  matterId: string;
  subjectRef: string;
  placedBy: string;
  placedAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}
export const listHolds = () => api<{ holds: Hold[] }>("/api/v1/privacy/legal-holds");
export const placeHold = (matterId: string, employeeRef: string, reason: string) =>
  api<{ hold: Hold }>("/api/v1/privacy/legal-holds", { method: "POST", body: { matter_id: matterId, employee_ref: employeeRef, reason } });
export const releaseHold = (id: string) =>
  api<{ hold: Hold; resubmitted: string[]; deferred: string[]; remainingHolds: number }>(`/api/v1/privacy/legal-holds/${seg(id)}/release`, { method: "POST", body: {} });

// ---- coverage report --------------------------------------------------------------------------------------------------
export interface Coverage {
  value: number | null;
  display: string;
  applicablePairs: number;
  cleanPairs: number;
}
export interface Report {
  window: { from: string | null; to: string | null };
  requests: { total: number; byStatus: Record<string, number> };
  coverage: Coverage;
  byCategory: Record<string, Coverage & { notPresent: number; aggregateRecompute: number }>;
  held: { requests: number; assetPairs: number };
  aggregateRecompute: { recomputed: number; notRecomputed: number };
  residuals: { kind: string; state: string; evidence: string; n: number }[];
  failures: { requestId: string; assetId: string; findings: unknown }[];
  failuresCursor: string | null;
}
export const getReport = (from: string | null, to: string | null, cursor: string | null) => api<Report>(`/api/v1/privacy/reports/deletion${query({ from, to, cursor })}`);

// ---- audit ------------------------------------------------------------------------------------------------------------
export interface AuditEvent {
  seq: number;
  ts: string;
  actor: string;
  actor_kind: string;
  persona: string | null;
  purpose: string | null;
  action: string;
  route: string | null;
  subject_ref: string | null;
  request_id: string | null;
  decision: string;
  reason: string;
  row_count: number | null;
  hash: string;
}
export const getAudit = (cursor: number | null) => api<{ events: AuditEvent[]; cursor: number | null }>(`/api/v1/privacy/audit${query({ cursor })}`);

export interface VerifyWindow {
  ok: boolean;
  afterSeq: number;
  anchorHash: string;
  from: number | null;
  to: number | null;
  lastHash: string;
  nextAfterSeq: number;
  complete: boolean;
  checked: number;
  brokenAtSeq?: number;
}
export const getVerifyWindow = (afterSeq: number) => api<VerifyWindow>(`/api/v1/privacy/audit/verify${query({ after_seq: afterSeq, limit: AUDIT_VERIFY_WINDOW })}`);

export interface ChainResult {
  ok: boolean;
  checked: number;
  windows: number;
  lastHash: string | null;
  /** first seq whose hash does not chain, or the window whose anchor differs from the previous window's last hash */
  brokenAtSeq: number | null;
  reason: "intact" | "hash_mismatch" | "anchor_mismatch" | "no_progress";
}

/**
 * Verifies the whole chain one window at a time (Workers Free: at most 50 events per request, SPEC.md section
 * 30.3.2): follows `nextAfterSeq` until `complete` and checks that each window starts on the previous window's last
 * hash, so the windows cannot be stitched from different chains.
 */
export async function verifyChain(onWindow?: (checked: number, windows: number) => void, fetchWindow = getVerifyWindow): Promise<ChainResult> {
  let after = 0;
  let checked = 0;
  let windows = 0;
  let prevLast: string | null = null;
  for (;;) {
    const w = await fetchWindow(after);
    windows++;
    if (prevLast !== null && w.anchorHash !== prevLast) return { ok: false, checked, windows, lastHash: prevLast, brokenAtSeq: w.afterSeq, reason: "anchor_mismatch" };
    checked += w.checked;
    onWindow?.(checked, windows);
    if (!w.ok) return { ok: false, checked, windows, lastHash: w.lastHash, brokenAtSeq: w.brokenAtSeq ?? w.from, reason: "hash_mismatch" };
    if (w.complete) return { ok: true, checked, windows, lastHash: w.lastHash, brokenAtSeq: null, reason: "intact" };
    if (w.nextAfterSeq <= after) return { ok: false, checked, windows, lastHash: w.lastHash, brokenAtSeq: after, reason: "no_progress" };
    prevLast = w.lastHash;
    after = w.nextAfterSeq;
  }
}
