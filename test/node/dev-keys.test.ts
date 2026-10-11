import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REQUIRED_SECRETS, buildDevVars, parseDevVars, renderDevVars } from "../../scripts/dev-keys.ts";
import { REPO_ROOT } from "../../scripts/lib/run.ts";

function stripJsonc(text: string): string {
  return text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
}

describe("dev-keys", () => {
  it("writes exactly the names in wrangler.jsonc secrets.required", async () => {
    const cfg = JSON.parse(stripJsonc(readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8")));
    expect([...REQUIRED_SECRETS]).toEqual(cfg.secrets.required);
    const values = await buildDevVars({}, false, new Date("2026-10-10T00:00:00Z"));
    const parsed = parseDevVars(renderDevVars(values));
    expect(Object.keys(parsed)).toEqual(cfg.secrets.required);
    expect(parsed.GCP_GATEWAY_SA_KEY).toBe("");
    expect(Buffer.from(parsed.PV_PSEUDONYM_MASTER_KEY!, "base64")).toHaveLength(32);
    const jwks = JSON.parse(parsed.DEV_ACCESS_JWKS!);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", kid: "dev-2026-10-10" });
    expect(jwks.keys[0].d).toBeUndefined();
    expect(JSON.parse(parsed.DEV_ACCESS_PRIVATE_JWK!).d).toBeTruthy();
  });

  it("keeps existing values unless forced", async () => {
    const first = await buildDevVars({}, false);
    const again = await buildDevVars(first, false);
    expect(again).toEqual(first);
    const forced = await buildDevVars(first, true);
    expect(forced.PV_PSEUDONYM_MASTER_KEY).not.toBe(first.PV_PSEUDONYM_MASTER_KEY);
  });

  it(".dev.vars.example lists the same names with empty values", () => {
    const example = parseDevVars(readFileSync(path.join(REPO_ROOT, ".dev.vars.example"), "utf8"));
    expect(Object.keys(example)).toEqual([...REQUIRED_SECRETS]);
    for (const v of Object.values(example)) expect(v).toBe("");
  });
});
