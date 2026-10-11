// Hand-written additions to the generated worker-configuration.d.ts.
// AUDIT_STREAM is a production-only Basin Pipelines binding (P1). There is deliberately no local
// `pipelines` binding: Miniflare's local pipeline binding is a no-op, so binding it locally would
// pretend to stream. AUDIT_STREAM_MODE=disabled makes /api/health report `disabled_local`.
interface Env {
  AUDIT_STREAM?: import("cloudflare:pipelines").Pipeline;
}
declare namespace Cloudflare {
  interface Env {
    AUDIT_STREAM?: import("cloudflare:pipelines").Pipeline;
  }
}
