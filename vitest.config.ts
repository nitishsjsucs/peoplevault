import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import testKeys from "./test/fixtures/test-keys.json" with { type: "json" };

// Test master key: the published test-vector key (bytes 0x00..0x1f), base64. Never valid in production (env.ts).
const TEST_MASTER_KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");

export default defineConfig(async () => {
  const migrations = await readD1Migrations("migrations");
  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  PV_PSEUDONYM_MASTER_KEY: TEST_MASTER_KEY_B64,
                  DEV_ACCESS_JWKS: JSON.stringify({ keys: [testKeys.primary.public] }),
                  DEV_ACCESS_PRIVATE_JWK: JSON.stringify(testKeys.primary.private),
                  WAREHOUSE_SHIM_TOKEN: "test-shim-token",
                  GCP_GATEWAY_SA_KEY: "",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/worker/**/*.test.ts"],
            // workflow tests run whole deletions (10 at once in one test); CI machines are slower than a laptop
            testTimeout: 120_000,
            setupFiles: ["test/worker/setup.ts"],
          },
        },
        {
          test: {
            name: "node",
            include: ["test/node/**/*.test.ts"],
            environment: "node",
          },
        },
      ],
    },
  };
});
