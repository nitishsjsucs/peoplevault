// Counts KV, R2 and D1 operations (SPEC.md section 14.1). A Worker invocation may make up to 1,000 operations to
// external services (KV and R2 named; D1 counted conservatively). The design allows at most 500 per Workflow step
// and 900 per instance; each step reports its count in its output and tests enforce both limits.

export interface OpCounter {
  kv: number;
  r2: number;
  d1: number;
  total(): number;
}

export function newCounter(): OpCounter {
  return {
    kv: 0,
    r2: 0,
    d1: 0,
    total() {
      return this.kv + this.r2 + this.d1;
    },
  };
}

function wrapObject<T extends object>(target: T, onCall: () => void, methods: string[]): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v === "function" && methods.includes(String(prop))) {
        return (...args: unknown[]) => {
          onCall();
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

function wrapD1(db: D1Database, c: OpCounter): D1Database {
  return new Proxy(db, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (prop === "prepare") {
        return (sql: string) => wrapStatement(t.prepare(sql), c);
      }
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          c.d1 += 1;
          return t.batch(stmts.map((s) => (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s));
        };
      }
      if (prop === "exec") {
        return (sql: string) => {
          c.d1 += 1;
          return t.exec(sql);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

function wrapStatement(stmt: D1PreparedStatement, c: OpCounter): D1PreparedStatement {
  return new Proxy(stmt, {
    get(t, prop, recv) {
      if (prop === "__inner") return t;
      const v = Reflect.get(t, prop, recv);
      if (prop === "bind") return (...args: unknown[]) => wrapStatement(t.bind(...args), c);
      if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
        return (...args: unknown[]) => {
          c.d1 += 1;
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** Proxies CACHE, EXPORTS, DERIVED and DB; a KV bulk get counts as one operation. */
export function withOpBudget<E extends Env>(env: E, counter: OpCounter): E {
  const kv = wrapObject(env.CACHE, () => (counter.kv += 1), ["get", "put", "delete", "list", "getWithMetadata"]);
  const r2 = (b: R2Bucket) => wrapObject(b, () => (counter.r2 += 1), ["get", "put", "delete", "list", "head", "createMultipartUpload"]);
  return { ...env, CACHE: kv, EXPORTS: r2(env.EXPORTS), DERIVED: r2(env.DERIVED), DB: wrapD1(env.DB, counter) };
}

export const STEP_BUDGET = 500;
export const INSTANCE_BUDGET = 900;
