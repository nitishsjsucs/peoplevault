// Hand-written additions to the generated worker-configuration.d.ts: production-only bindings that are absent from
// wrangler.jsonc. The Workers AI binding `AI` (P1 schema-drift triage, SPEC.md section 30.3.6) exists only in the
// production template, because a local AI binding always calls Cloudflare; locally the triage uses llama-server or a
// deterministic stub (AI_MODE). Revision 3 removed the Basin Pipelines binding AUDIT_STREAM (Workers Paid only).
interface Env {
  AI?: Ai;
}
declare namespace Cloudflare {
  interface Env {
    AI?: Ai;
  }
}
