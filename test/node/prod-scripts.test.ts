// Production helpers that need no network: config rendering, env files with mode 600, deploy refusals and the
// principal mapping SQL of seed:prod.
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deployArgs, deployProblems } from "../../scripts/deploy-prod.ts";
import { parseEnv, readEnvFile, renderConfig, TEMPLATE, upsertEnvFile } from "../../scripts/lib/prod-files.ts";
import { principalMappingSql } from "../../scripts/seed-prod.ts";

describe("production helpers", () => {
  it("renders the template and refuses empty values", () => {
    const t = readFileSync(TEMPLATE, "utf8");
    const out = renderConfig(t, { d1Id: "d1", kvId: "kv", accessTeamDomain: "team.cloudflareaccess.com", accessAud: "aud", gcpProject: "proj" });
    expect(out).not.toContain('"pipelines"');
    expect(out).not.toContain('"limits"');
    expect(out).not.toMatch(/__[A-Z0-9_]+__/);
    expect(deployProblems(out, ["GCP_GATEWAY_SA_KEY", "PV_PSEUDONYM_MASTER_KEY"])).toEqual([]);
    expect(() => renderConfig(t, { d1Id: "", kvId: "kv", accessTeamDomain: "t", accessAud: "a", gcpProject: "p" })).toThrow(/__D1_ID__/);
  });

  it("refuses to deploy an unrendered config, invocation logs or the wrong secrets", () => {
    const t = readFileSync(TEMPLATE, "utf8");
    expect(deployProblems(null, [])).toHaveLength(2);
    expect(deployProblems(t, ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"])[0]).toMatch(/placeholders left/);
    const logsOn = renderConfig(t, { d1Id: "d", kvId: "k", accessTeamDomain: "t", accessAud: "a", gcpProject: "p" }).replace('"invocation_logs": false', '"invocation_logs": true');
    expect(deployProblems(logsOn, ["PV_PSEUDONYM_MASTER_KEY", "GCP_GATEWAY_SA_KEY"])).toEqual(["observability.logs.invocation_logs must be false"]);
    expect(deployProblems(logsOn.replace('"invocation_logs": true', '"invocation_logs": false'), ["PV_PSEUDONYM_MASTER_KEY", "DEV_ACCESS_JWKS"])[0]).toMatch(/exactly/);
    expect(deployArgs()).toEqual(["deploy", "-c", "infra/cloudflare/wrangler.production.jsonc", "--secrets-file", ".secrets/worker-secrets.env"]);
  });

  it("upserts env files with mode 600, keeping comments and other keys", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pv-env-"));
    const file = path.join(dir, "sub", "prod.env");
    upsertEnvFile(file, { A: "1" });
    writeFileSync(file, "# comment\nA=1\nB=two\n");
    upsertEnvFile(file, { B: "2", C: "x=y" });
    expect(readFileSync(file, "utf8")).toBe("# comment\nA=1\nB=2\nC=x=y\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readEnvFile(file)).toEqual({ A: "1", B: "2", C: "x=y" });
    expect(parseEnv('Q="quoted"\n#X=1\nbad line')).toEqual({ Q: "quoted" });
  });

  it("maps service tokens and sign-in emails to principals with validated values only", () => {
    const env: Record<string, string> = {
      PV_CF_ACCESS_CLIENT_ID_EXECUTOR: "exec.access",
      PV_CF_ACCESS_CLIENT_ID_HR: "hr.access",
      PV_CF_ACCESS_CLIENT_ID_MANAGER: "mgr.access",
      PV_CF_ACCESS_CLIENT_ID_ANALYST: "an.access",
      PV_CF_ACCESS_CLIENT_ID_PRIVACY: "pr.access",
      PV_ACCESS_PERSONA_EMAILS: "Owner+HR@example.test=hrbp-01, owner+mgr@example.test=mgr-001",
    };
    expect(principalMappingSql(env)).toEqual([
      "UPDATE principals SET service_client_id = 'exec.access' WHERE system_role = 'executor'",
      "UPDATE principals SET service_client_id = 'hr.access' WHERE id = 'hrbp-01'",
      "UPDATE principals SET service_client_id = 'mgr.access' WHERE id = 'mgr-001'",
      "UPDATE principals SET service_client_id = 'an.access' WHERE id = 'analyst-01'",
      "UPDATE principals SET service_client_id = 'pr.access' WHERE id = 'privacy-01'",
      "UPDATE principals SET email = 'owner+hr@example.test' WHERE id = 'hrbp-01'",
      "UPDATE principals SET email = 'owner+mgr@example.test' WHERE id = 'mgr-001'",
    ]);
    expect(() => principalMappingSql({ ...env, PV_ACCESS_PERSONA_EMAILS: "x'; DROP TABLE principals;--@e.test=hrbp-01" })).toThrow();
    expect(() => principalMappingSql({ ...env, PV_CF_ACCESS_CLIENT_ID_HR: "" })).toThrow(/pv-persona-hr/);
  });
});
