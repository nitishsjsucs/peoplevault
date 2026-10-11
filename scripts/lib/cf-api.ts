// Cloudflare REST client for setup:prod and doctor. Two credentials, never printed: PV_CF_API_TOKEN (Access, Workers
// subdomain, Workers scripts, AI Gateway) and wrangler's OAuth token (R2, KV, Queues, Basin listings), read into memory with
// `wrangler auth token --json`. The fetch implementation is injectable so recorded responses test every call.
export const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfEnvelope<T> {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
}

export class CfApiError extends Error {
  override name = "CfApiError";
  readonly status: number;
  readonly codes: number[];
  constructor(status: number, codes: number[]) {
    super(`Cloudflare API error ${status} (${codes.join(",") || "no code"})`);
    this.status = status;
    this.codes = codes;
  }
}

export interface AccessApp {
  id: string;
  name: string;
  aud: string;
  type: string;
  destinations?: { type: string; worker_id?: string; uri?: string }[];
}
export interface AiGateway {
  id: string;
  collect_logs: boolean;
  cache_ttl: number | null;
  cache_invalidate_on_update?: boolean;
  rate_limiting_interval: number | null;
  rate_limiting_limit: number | null;
  rate_limiting_technique?: string;
}
export interface ServiceToken {
  id: string;
  name: string;
  client_id: string;
  client_secret?: string;
}

export class CfApi {
  readonly accountId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(accountId: string, token: string, fetchImpl: typeof fetch = fetch) {
    this.accountId = accountId;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${CF_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const env = (await res.json().catch(() => ({ success: false, errors: [], result: null }))) as CfEnvelope<T>;
    if (!res.ok || !env.success) throw new CfApiError(res.status, (env.errors ?? []).map((e) => e.code));
    return env.result;
  }

  private acct(p: string): string {
    return `/accounts/${this.accountId}${p}`;
  }

  accessApps(): Promise<AccessApp[]> {
    return this.call("GET", this.acct("/access/apps"));
  }
  createAccessApp(body: unknown): Promise<AccessApp> {
    return this.call("POST", this.acct("/access/apps"), body);
  }
  accessPolicies(appId: string): Promise<{ id: string; name: string }[]> {
    return this.call("GET", this.acct(`/access/apps/${appId}/policies`));
  }
  createAccessPolicy(appId: string, body: unknown): Promise<{ id: string; name: string }> {
    return this.call("POST", this.acct(`/access/apps/${appId}/policies`), body);
  }
  serviceTokens(): Promise<ServiceToken[]> {
    return this.call("GET", this.acct("/access/service_tokens"));
  }
  createServiceToken(name: string): Promise<ServiceToken> {
    return this.call("POST", this.acct("/access/service_tokens"), { name, duration: "8760h" });
  }
  /** Client secret is returned once; the caller stores it in .secrets/prod.env. */
  rotateServiceToken(id: string): Promise<ServiceToken> {
    return this.call("POST", this.acct(`/access/service_tokens/${id}/rotate`));
  }
  /** Workers with their immutable ids (the Access `worker` destination takes this id). */
  workers(): Promise<{ id: string; name: string }[]> {
    return this.call("GET", this.acct("/workers/workers"));
  }
  organization(): Promise<{ name: string; auth_domain: string }> {
    return this.call("GET", this.acct("/access/organizations"));
  }
  /** Error 10007 means no workers.dev subdomain is registered (Workflows cannot deploy without one). */
  async workersSubdomain(): Promise<string | null> {
    try {
      return (await this.call<{ subdomain: string }>("GET", this.acct("/workers/subdomain"))).subdomain;
    } catch (e) {
      if (e instanceof CfApiError && e.codes.includes(10007)) return null;
      throw e;
    }
  }
  registerWorkersSubdomain(subdomain: string): Promise<{ subdomain: string }> {
    return this.call("PUT", this.acct("/workers/subdomain"), { subdomain });
  }
  r2Buckets(): Promise<{ buckets: { name: string }[] }> {
    return this.call("GET", this.acct("/r2/buckets"));
  }
  kvNamespaces(): Promise<{ id: string; title: string }[]> {
    return this.call("GET", this.acct("/storage/kv/namespaces?per_page=100"));
  }
  queues(): Promise<{ queue_id: string; queue_name: string }[]> {
    return this.call("GET", this.acct("/queues"));
  }
  /** One AI Gateway, or null when the account has none with this id (404). */
  async aiGateway(id: string): Promise<AiGateway | null> {
    try {
      return await this.call<AiGateway>("GET", this.acct(`/ai-gateway/gateways/${id}`));
    } catch (e) {
      if (e instanceof CfApiError && e.status === 404) return null;
      throw e;
    }
  }
  createAiGateway(body: unknown): Promise<AiGateway> {
    return this.call("POST", this.acct("/ai-gateway/gateways"), body);
  }
  updateAiGateway(id: string, body: unknown): Promise<AiGateway> {
    return this.call("PUT", this.acct(`/ai-gateway/gateways/${id}`), body);
  }
  /** Basin Catalog (formerly R2 Data Catalog) status of a bucket; endpoint shape unverified (SPEC.md section 27). */
  catalog(bucket: string): Promise<{ status?: string; name?: string }> {
    return this.call("GET", this.acct(`/r2-catalog/${bucket}`));
  }
}
