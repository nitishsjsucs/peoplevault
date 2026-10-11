import { describe, expect, it } from "vitest";
import { cycleEnd, exportBasisDate, isPast, minusDays, minusMonths, minusYears, monthEnd, retentionRunAsOf } from "../../src/worker/retention/rules.ts";

const AS_OF = "2026-09-30";
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe("retention boundary rule (inclusive cutoff)", () => {
  it.each([
    ["HRIS 56 days", minusDays(AS_OF, 56), "2026-08-05"],
    ["payroll 300 days", minusDays(AS_OF, 300), "2025-12-04"],
    ["leave 365 days", minusDays(AS_OF, 365), "2025-09-30"],
    ["performance 540 days", minusDays(AS_OF, 540), "2025-04-08"],
    ["extracts 90 days", minusDays(AS_OF, 90), "2026-07-02"],
    ["lake 84 months", minusMonths(AS_OF, 84), "2019-09-30"],
    ["terminated 3 years", minusYears(AS_OF, 3), "2023-09-30"],
  ])("%s", (_name, cutoff, expected) => {
    expect(cutoff).toBe(expected);
    expect(isPast(cutoff, cutoff)).toBe(true);
    expect(isPast(shift(cutoff, -1), cutoff)).toBe(true);
    expect(isPast(shift(cutoff, 1), cutoff)).toBe(false);
  });

  it("derives basis dates from export keys", () => {
    expect(exportBasisDate("exports/hris/employees/dt=2026-07-06/employees.jsonl")).toBe("2026-07-06");
    expect(exportBasisDate("exports/payroll/compensation/period=2025-11/compensation.csv")).toBe("2025-11-30");
    expect(exportBasisDate("exports/leave/requests/month=2024-02/requests.jsonl")).toBe("2024-02-29");
    expect(exportBasisDate("exports/performance/reviews/cycle=2024H2/reviews.jsonl")).toBe("2024-12-31");
    expect(exportBasisDate("exports/adhoc/copy.jsonl")).toBeNull();
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(cycleEnd("2025H1")).toBe("2025-06-30");
    expect(minusMonths("2026-03-31", 1)).toBe("2026-02-28");
  });
});

describe("the as_of date of a retention run started through the API", () => {
  const local = { env: "local" as const, retentionAsOf: "2026-09-30" };
  const prod = { env: "production" as const, retentionAsOf: null };
  it("locally accepts today or a past date (the eval's fixed date) and refuses a future one", () => {
    expect(retentionRunAsOf("2026-09-30", local, "2026-10-11")).toEqual({ asOf: "2026-09-30" });
    expect(retentionRunAsOf("2026-10-11", local, "2026-10-11")).toEqual({ asOf: "2026-10-11" });
    expect(retentionRunAsOf("2026-10-12", local, "2026-10-11")).toEqual({ error: "as_of_in_future" });
    expect(retentionRunAsOf(undefined, local, "2026-10-11")).toEqual({ asOf: "2026-09-30" });
  });
  it("production takes no date from the request and uses today", () => {
    expect(retentionRunAsOf("2026-09-30", prod, "2026-10-11")).toEqual({ error: "as_of_not_allowed" });
    expect(retentionRunAsOf("2099-12-31", prod, "2026-10-11")).toEqual({ error: "as_of_not_allowed" });
    expect(retentionRunAsOf(undefined, prod, "2026-10-11")).toEqual({ asOf: "2026-10-11" });
  });
});
