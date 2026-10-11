// Console paths hold purposes, pseudonymous refs and request ids only (SPEC.md section 11.5).
import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute, type Route } from "../../src/web/router.ts";
import { REF } from "./fake-api.ts";

describe("router", () => {
  const routes: Route[] = [
    { page: "me" },
    { page: "employees", purpose: "employee_relations" },
    { page: "employees", purpose: "team_management" },
    { page: "profile", purpose: "workforce_analytics", ref: `an_${"q".repeat(26)}` },
    { page: "profile", purpose: "employee_relations", ref: REF },
    { page: "requests" },
    { page: "request", id: "3f2a7c1e-0000-4000-8000-000000000001" },
    { page: "holds" },
    { page: "report" },
    { page: "audit" },
  ];

  it.each(routes)("round trips %o", (r) => {
    expect(parseRoute(hrefFor(r))).toEqual(r);
  });

  it.each(["/nope", "/purposes/privacy_compliance/employees", "/purposes/employee_relations/employees/x/y", "/privacy", "/privacy/holds/x", "/api/v1/me"])("%s is not a console page", (p) => {
    expect(parseRoute(p)).toEqual({ page: "not_found" });
  });

  it("tolerates a trailing slash and decodes encoded segments", () => {
    expect(parseRoute("/privacy/requests/")).toEqual({ page: "requests" });
    expect(parseRoute("/privacy/requests/a%2Fb")).toEqual({ page: "request", id: "a/b" });
    expect(parseRoute("/privacy/requests/%E0%A4%A")).toEqual({ page: "not_found" });
  });
});
