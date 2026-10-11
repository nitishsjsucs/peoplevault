import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import casesText from "../../policy/cases/authz_cases.yaml?raw";

interface Case {
  id: string;
  category: string;
  layers: string[];
}

const cases = parse(casesText) as Case[];

describe("authorization case catalog", () => {
  it("has exactly 100 cases: A 12, B 15, C 30, D 16, E 8, F 13, G 6", () => {
    expect(cases).toHaveLength(100);
    const byCat: Record<string, number> = {};
    for (const c of cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1;
    expect(byCat).toEqual({ A: 12, B: 15, C: 30, D: 16, E: 8, F: 13, G: 6 });
  });
  it("runs all 100 at the pdp layer and 48 at the warehouse layer", () => {
    expect(cases.filter((c) => c.layers.includes("pdp"))).toHaveLength(100);
    expect(cases.filter((c) => c.layers.includes("warehouse"))).toHaveLength(48);
  });
});
