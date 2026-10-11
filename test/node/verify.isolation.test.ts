// Verification shares no code with erasure (ADR 0003): nothing in src/worker/verify/ imports from erase/ or
// workflows/. This reads source files, so it runs in the node project (workerd tests have no filesystem).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../scripts/lib/run.ts";

const dir = path.join(REPO_ROOT, "src/worker/verify");

describe("verify isolation", () => {
  it("no file in src/worker/verify imports from erase/ or workflows/", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), "utf8");
      const imports = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((x) => x[1]!);
      for (const imp of imports) {
        expect(imp, `${f} imports ${imp}`).not.toMatch(/(^|\/)(erase|workflows)\//);
        expect(imp).not.toMatch(/storage\/r2-rewrite/);
      }
    }
  });
});
