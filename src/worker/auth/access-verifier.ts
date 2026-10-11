// Cloudflare Access JWT verification (SPEC.md section 11.1). The Worker verifies the Cf-Access-Jwt-Assertion RS256
// JWT itself, against the team JWKS in production and a locally generated JWKS in development, so one code path
// covers both. ctx.access.getIdentity() is deliberately not used (undefined without Access, not testable locally).
import { createLocalJWKSet, createRemoteJWKSet, customFetch, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

export type AuthErrorCode =
  | "missing_token"
  | "expired"
  | "not_yet_valid"
  | "bad_signature"
  | "bad_audience"
  | "bad_issuer"
  | "bad_algorithm"
  | "unknown_kid"
  | "malformed";

export class AuthError extends Error {
  override name = "AuthError";
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface VerifiedIdentity {
  kind: "user" | "service";
  sub: string;
  email?: string;
  commonName?: string;
  iss: string;
  exp: number;
}

export interface AccessVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

export type VerifierConfig =
  | { mode: "access"; teamDomain: string; aud: string }
  | { mode: "local-jwks"; issuer: string; aud: string; jwks: JSONWebKeySet };

export interface VerifierOptions {
  /** Injected fetch for the remote JWKS (tests use recorded responses). */
  fetchImpl?: typeof fetch;
}

const CLOCK_TOLERANCE_SECONDS = 30;

function mapError(err: unknown): AuthError {
  if (err instanceof AuthError) return err;
  if (err instanceof errors.JWTExpired) return new AuthError("expired");
  if (err instanceof errors.JWTClaimValidationFailed) {
    if (err.claim === "nbf") return new AuthError("not_yet_valid");
    if (err.claim === "aud") return new AuthError("bad_audience");
    if (err.claim === "iss") return new AuthError("bad_issuer");
    return new AuthError("malformed");
  }
  if (err instanceof errors.JWSSignatureVerificationFailed) return new AuthError("bad_signature");
  if (err instanceof errors.JOSEAlgNotAllowed || err instanceof errors.JOSENotSupported) return new AuthError("bad_algorithm");
  if (err instanceof errors.JWKSNoMatchingKey) return new AuthError("unknown_kid");
  return new AuthError("malformed");
}

function identityFrom(payload: JWTPayload): VerifiedIdentity {
  const sub = typeof payload.sub === "string" ? payload.sub : undefined;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const commonName = typeof payload.common_name === "string" ? payload.common_name : undefined;
  const iss = payload.iss ?? "";
  const exp = payload.exp ?? 0;
  if (sub && sub.length > 0 && email) return { kind: "user", sub, email, iss, exp };
  // Access service tokens carry common_name (the client id) and an empty sub.
  if (sub === "" && commonName) return { kind: "service", sub, commonName, iss, exp };
  throw new AuthError("malformed");
}

function rejectUnsignedHeader(token: string): void {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("malformed");
  let header: { alg?: unknown };
  try {
    header = JSON.parse(atob(parts[0]!.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new AuthError("malformed");
  }
  if (typeof header.alg !== "string") throw new AuthError("malformed");
  if (header.alg !== "RS256") throw new AuthError("bad_algorithm");
}

// Remote JWKS sets are held at module scope so keys are fetched once per isolate (jose caches and refetches on an
// unknown kid, which handles Access's 6-week rotation with a 7-day overlap).
const remoteSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function createAccessVerifier(cfg: VerifierConfig, opts: VerifierOptions = {}): AccessVerifier {
  let keySet: Parameters<typeof jwtVerify>[1];
  let issuer: string;
  if (cfg.mode === "access") {
    issuer = cfg.teamDomain;
    const url = `${cfg.teamDomain}/cdn-cgi/access/certs`;
    const cacheKey = opts.fetchImpl ? `${url}#injected` : url;
    let set = opts.fetchImpl ? undefined : remoteSets.get(cacheKey);
    if (!set) {
      const fetchImpl = opts.fetchImpl;
      set = createRemoteJWKSet(new URL(url), fetchImpl ? { [customFetch]: (u: string, init: RequestInit) => fetchImpl(u, init) } : {});
      if (!opts.fetchImpl) remoteSets.set(cacheKey, set);
    }
    keySet = set;
  } else {
    issuer = cfg.issuer;
    keySet = createLocalJWKSet(cfg.jwks);
  }
  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      if (!token) throw new AuthError("missing_token");
      rejectUnsignedHeader(token);
      try {
        const { payload } = await jwtVerify(token, keySet, {
          issuer,
          audience: cfg.aud,
          algorithms: ["RS256"],
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
        });
        return identityFrom(payload);
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}
