// The console shell: sign-in (local dev login or Cloudflare Access), and purpose scoping of the navigation and pages.
// The Worker's PDP decides every call; these tests pin that the console does not even ask outside the persona.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../../src/web/App.tsx";
import { fakeApi, reply, signedIn } from "./fake-api.ts";

function at(path: string) {
  window.history.pushState(null, "", path);
  return render(<App />);
}

describe("sign-in", () => {
  it("locally lists the fixture principals and signs in through /dev/login", async () => {
    let signedInAs: string | null = null;
    const { calls } = fakeApi({
      "GET /api/v1/me": () => (signedInAs ? { principalId: signedInAs, persona: "privacy_officer", purposes: ["privacy_compliance", "legal_hold_management"] } : reply(401, { error: "unauthenticated", code: "missing_token" })),
      "GET /dev/principals": {
        principals: [
          { id: "privacy-01", kind: "human", persona: "privacy_officer", status: "active" },
          { id: "pv-executor-local", kind: "system", persona: null, status: "active" },
          { id: "hrbp-09", kind: "human", persona: "hr_partner", status: "disabled" },
        ],
      },
      "GET /dev/login": () => {
        signedInAs = "privacy-01";
        return { ok: true, principalId: "privacy-01", persona: "privacy_officer" };
      },
    });
    at("/");
    const button = await screen.findByRole("button", { name: "privacy-01" });
    expect(screen.queryByRole("button", { name: "pv-executor-local" })).toBeNull();
    expect(screen.queryByRole("button", { name: "hrbp-09" })).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "Privacy Officer" })).toBeTruthy();
    expect(calls.some((c) => c.url === "/dev/login?principal=privacy-01")).toBe(true);
  });

  it("in production (no /dev routes) points to Cloudflare Access", async () => {
    fakeApi({ "GET /api/v1/me": reply(401, { error: "unauthenticated", code: "missing_token" }) });
    at("/");
    expect(await screen.findByText(/behind Cloudflare Access/)).toBeTruthy();
  });

  it("refuses service principals", async () => {
    fakeApi({ "GET /api/v1/me": reply(403, { error: "forbidden", code: "human_only" }) });
    at("/");
    expect(await screen.findByText(/This console is for people/)).toBeTruthy();
  });
});

describe("purpose scoping", () => {
  it("shows an HR partner only the employee relations browser", async () => {
    fakeApi(signedIn("hr_partner", "hrbp-01"));
    at("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav.textContent).toBe("Employee relations");
  });

  it("shows a privacy officer requests, report, audit and holds, and no employee browser", async () => {
    fakeApi(signedIn("privacy_officer"));
    at("/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Deletion requests", "Coverage report", "Audit log", "Legal holds"]);
  });

  it.each([
    ["hr_partner", "/privacy/requests", "/api/v1/privacy/"],
    ["hr_partner", "/privacy/holds", "/api/v1/privacy/"],
    ["manager", "/purposes/employee_relations/employees", "/api/v1/purposes/"],
    ["people_analyst", "/purposes/team_management/employees/er_aaaaaaaaaaaaaaaaaaaaaaaaaa", "/api/v1/purposes/"],
    ["privacy_officer", "/purposes/workforce_analytics/employees", "/api/v1/purposes/"],
  ] as const)("%s at %s: says no access and calls nothing under %s", async (persona, path, prefix) => {
    const { calls } = fakeApi(signedIn(persona));
    at(path);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/has no access to/));
    expect(calls.filter((c) => c.path.startsWith(prefix))).toEqual([]);
    expect(screen.queryByText(/^Purpose:/)).toBeNull();
  });

  it("an unknown path is not found", async () => {
    fakeApi(signedIn("privacy_officer"));
    at("/somewhere");
    expect(await screen.findByText("Page not found.")).toBeTruthy();
  });

  it("signs out locally through /dev/logout", async () => {
    let out = false;
    const routes = signedIn("hr_partner", "hrbp-01");
    const { calls } = fakeApi({
      ...routes,
      "GET /api/v1/me": () => (out ? reply(401, { error: "unauthenticated", code: "missing_token" }) : routes["GET /api/v1/me"]),
      "GET /dev/logout": () => {
        out = true;
        return { ok: true };
      },
    });
    at("/");
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Local sign-in" })).toBeTruthy();
    expect(calls.some((c) => c.path === "/dev/logout")).toBe(true);
  });

  it("navigates without a page load and keeps the URL free of anything typed", async () => {
    fakeApi({ ...signedIn("privacy_officer"), "GET /api/v1/privacy/legal-holds": { holds: [] } });
    at("/");
    fireEvent.click(await screen.findByRole("link", { name: "Legal holds" }));
    expect(await screen.findByRole("heading", { name: "Legal holds" })).toBeTruthy();
    expect(window.location.pathname).toBe("/privacy/holds");
    expect(window.location.search).toBe("");
  });
});
