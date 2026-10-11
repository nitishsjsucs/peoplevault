// Counts KV, R2 and D1 calls, decoded R2 bytes and D1 statements per Workflow step (SPEC.md sections 14.1 and
// 30.3.1). Workers Free allows 1,000 calls to Cloudflare services and 50 D1 queries per invocation and 10 ms of CPU
// per step. The design allows at most 500 calls per step and 900 per instance, at most 40 D1 statements per step
// (every statement inside a batch counted one by one), and at most the step's byte cap of decoded R2 objects; each
// step reports its counts in its output and tests enforce every limit.

export interface OpCounter {
  kv: number;
  r2: number;
  d1: number;
  /** D1 statements: a batch of n statements counts n (the 50-query limit applies per statement, conservatively). */
  d1Statements: number;
  /** Bytes of R2 object bodies fetched (every get that returns a body counts its size). */
  r2Bytes: number;
  total(): number;
}

export function newCounter(): OpCounter {
  return {
    kv: 0,
    r2: 0,
    d1: 0,
    d1Statements: 0,
    r2Bytes: 0,
    total() {
      return this.kv + this.r2 + this.d1;
    },
  };
}

function wrapObject<T extends object>(target: T, onCall: () => void, methods: string[], onResult?: (prop: string, value: unknown) => void): T {
  return new Proxy(target, {
    get(t, prop, recv) {
      const v = Reflect.get(t, prop, recv);
      if (typeof v === "function" && methods.includes(String(prop))) {
        return (...args: unknown[]) => {
          onCall();
          const out = (v as (...a: unknown[]) => unknown).apply(t, args);
          if (onResult && out instanceof Promise) return out.then((r) => (onResult(String(prop), r), r));
          return out;
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
          c.d1Statements += stmts.length;
          return t.batch(stmts.map((s) => (s as unknown as { __inner?: D1PreparedStatement }).__inner ?? s));
        };
      }
      if (prop === "exec") {
        return (sql: string) => {
          c.d1 += 1;
          c.d1Statements += 1;
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
          c.d1Statements += 1;
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
  const countBody = (prop: string, r: unknown) => {
    if (prop === "get" && r && typeof r === "object" && "body" in r) counter.r2Bytes += (r as R2ObjectBody).size;
  };
  const r2 = (b: R2Bucket) => wrapObject(b, () => (counter.r2 += 1), ["get", "put", "delete", "list", "head", "createMultipartUpload"], countBody);
  return { ...env, CACHE: kv, EXPORTS: r2(env.EXPORTS), DERIVED: r2(env.DERIVED), DB: wrapD1(env.DB, counter) };
}

export const STEP_BUDGET = 500;
export const INSTANCE_BUDGET = 900;
/** Workers Free: 50 D1 queries per invocation; the design keeps every step at 40 or fewer. */
export const STEP_D1_STATEMENTS = 40;
