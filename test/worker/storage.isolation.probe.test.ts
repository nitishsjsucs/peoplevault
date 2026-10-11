import { env } from "cloudflare:workers";
import { expect, it } from "vitest";

// Each test file starts from migrated, empty storage (no rows leak from d1.migrations.test.ts).
it("starts with empty control-plane tables", async () => {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM deletion_requests").first<{ n: number }>();
  expect(row?.n).toBe(0);
});
