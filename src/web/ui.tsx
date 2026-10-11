// Shared console pieces: links that use the history router, the async loader hook, error and empty states.
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { ApiError, type Visibility } from "./api.ts";
import { navigate } from "./router.ts";

export function Link(props: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.to);
  };
  return (
    <a href={props.to} onClick={onClick} className={props.className}>
      {props.children}
    </a>
  );
}

export type Async<T> = { state: "loading" } | { state: "error"; error: unknown } | { state: "ready"; data: T };

/** Runs `load` when `key` changes; `reload` runs it again. A result that arrives after the key changed is dropped. */
export function useAsync<T>(load: () => Promise<T>, key: string): [Async<T>, () => void] {
  const [result, setResult] = useState<Async<T>>({ state: "loading" });
  const [nonce, setNonce] = useState(0);
  // `load` is a new closure on every render; `key` names its inputs, so only a changed key (or reload) runs it
  useEffect(() => {
    let live = true;
    setResult({ state: "loading" });
    load().then(
      (data) => live && setResult({ state: "ready", data }),
      (error: unknown) => live && setResult({ state: "error", error }),
    );
    return () => {
      live = false;
    };
  }, [key, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return [result, reload];
}

const MESSAGES: Record<string, string> = {
  unauthenticated: "Your session has ended. Reload the page to sign in again.",
  forbidden: "Your persona is not allowed to do this.",
  not_found: "Not found, or outside your scope.",
  csrf: "The request was refused (missing console header).",
  invalid_body: "The server rejected the form. Check the fields.",
  invalid_query: "The server rejected the query.",
  active_request_exists: "This person already has an open deletion request.",
  not_failed: "Only a failed request can be retried.",
  audit_contention: "The audit log is busy. Try again in a moment.",
  busy: "The audit log is busy. Try again in a moment.",
};

/** A problem the console found before calling the API; its message is shown as is. */
export class FormError extends Error {
  override name = "FormError";
}

export function describeError(e: unknown): string {
  if (e instanceof FormError) return e.message;
  if (e instanceof ApiError) return MESSAGES[e.code] ?? MESSAGES[e.status === 401 ? "unauthenticated" : e.status === 403 ? "forbidden" : e.status === 404 ? "not_found" : ""] ?? `The request failed (${e.status} ${e.code}).`;
  return "The request failed. Check your connection.";
}

export function ErrorNote(props: { error: unknown }) {
  return (
    <p className="note error" role="alert">
      {describeError(props.error)}
    </p>
  );
}

export function Loading() {
  return <p className="note muted">Loading...</p>;
}

const VISIBILITY_LABEL: Record<Visibility, string | null> = { allow: null, deny: null, mask_nullify: "masked", mask_date_year: "year only" };

/** A column header with its visibility for the purpose; masked columns say so instead of showing an empty cell. */
export function ColumnName(props: { name: string; visibility: Visibility }) {
  const label = VISIBILITY_LABEL[props.visibility];
  return (
    <>
      {props.name}
      {label ? <span className="badge">{label}</span> : null}
    </>
  );
}

export function formatCell(v: unknown, visibility: Visibility = "allow"): string {
  if (visibility === "mask_nullify") return "hidden";
  if (v === null || v === undefined) return "";
  if (visibility === "mask_date_year" && typeof v === "string") return v.slice(0, 4);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function shortRef(ref: string | null | undefined): string {
  if (!ref) return "";
  return ref.length > 14 ? `${ref.slice(0, 11)}...` : ref;
}

export function Status(props: { status: string }) {
  return <span className={`status status-${props.status}`}>{props.status.replace(/_/g, " ")}</span>;
}
