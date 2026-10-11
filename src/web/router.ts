// A small history router for the console. Paths hold purposes, pseudonymous refs (employee_ref, analytics_id) and
// request ids only: never a name, email or employee id (SPEC.md section 11.5). Navigation never puts form input into
// the URL; the identity lookup lives in component state and is sent as a POST body.
import { useSyncExternalStore } from "react";
import type { Purpose } from "./api.ts";

export const DATA_PURPOSES = ["employee_relations", "team_management", "workforce_analytics"] as const satisfies readonly Purpose[];
export type DataPurpose = (typeof DATA_PURPOSES)[number];

export type Route =
  | { page: "me" }
  | { page: "employees"; purpose: DataPurpose }
  | { page: "profile"; purpose: DataPurpose; ref: string }
  | { page: "requests" }
  | { page: "request"; id: string }
  | { page: "holds" }
  | { page: "report" }
  | { page: "audit" }
  | { page: "not_found" };

const isDataPurpose = (p: string): p is DataPurpose => (DATA_PURPOSES as readonly string[]).includes(p);

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/+$/, "").split("/").slice(1);
  const [a, b, c, d, ...rest] = parts;
  if (parts.length === 0 || (parts.length === 1 && a === "")) return { page: "me" };
  if (a === "purposes" && b && isDataPurpose(b) && c === "employees" && rest.length === 0) {
    if (d === undefined) return { page: "employees", purpose: b };
    const ref = decode(d);
    if (ref) return { page: "profile", purpose: b, ref };
  }
  if (a === "privacy" && c === undefined) {
    if (b === "requests") return { page: "requests" };
    if (b === "holds") return { page: "holds" };
    if (b === "report") return { page: "report" };
    if (b === "audit") return { page: "audit" };
  }
  if (a === "privacy" && b === "requests" && c && d === undefined) {
    const id = decode(c);
    if (id) return { page: "request", id };
  }
  return { page: "not_found" };
}

export function hrefFor(r: Route): string {
  switch (r.page) {
    case "me":
      return "/";
    case "employees":
      return `/purposes/${r.purpose}/employees`;
    case "profile":
      return `/purposes/${r.purpose}/employees/${encodeURIComponent(r.ref)}`;
    case "request":
      return `/privacy/requests/${encodeURIComponent(r.id)}`;
    case "requests":
    case "holds":
    case "report":
    case "audit":
      return `/privacy/${r.page}`;
    case "not_found":
      return "/";
  }
}

const listeners = new Set<() => void>();

export function navigate(href: string): void {
  window.history.pushState(null, "", href);
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  window.addEventListener("popstate", l);
  return () => {
    listeners.delete(l);
    window.removeEventListener("popstate", l);
  };
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname);
}
