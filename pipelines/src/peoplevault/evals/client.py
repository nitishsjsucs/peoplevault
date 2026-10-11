"""HTTP client for the eval and the cache warm-up: dev JWTs signed with the local dev key (the stand-in for the
Access team key) for any seeded principal."""

from __future__ import annotations

import json
import time

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from peoplevault import config


class LocalClient:
    def __init__(self, principals: list[dict], base_url: str | None = None):
        s = config.local_settings()
        if not s.private_jwk:
            raise RuntimeError("DEV_ACCESS_PRIVATE_JWK missing; run `npm run dev:keys`")
        self.key = RSAAlgorithm.from_jwk(json.dumps(s.private_jwk))
        self.kid = s.private_jwk.get("kid", "dev")
        self.issuer, self.aud = s.issuer, s.audience
        self.base = base_url or f"http://127.0.0.1:{config.WORKER_PORT}"
        self.principals = {p["id"]: p for p in principals}
        self.http = httpx.Client(timeout=120.0)
        self._tokens: dict[str, tuple[float, str]] = {}

    def token(self, principal_id: str) -> str:
        cached = self._tokens.get(principal_id)
        now = time.time()
        if cached and cached[0] > now + 60:
            return cached[1]
        p = self.principals[principal_id]
        claims = {"iss": self.issuer, "aud": [self.aud], "iat": int(now), "nbf": int(now), "exp": int(now) + 3600}
        if p.get("kind") == "system":
            claims.update({"sub": "", "common_name": p["service_client_id"]})
        else:
            claims.update({"sub": f"dev-{principal_id}", "email": p["email"], "type": "app"})
        tok = jwt.encode(claims, self.key, algorithm="RS256", headers={"kid": self.kid})
        self._tokens[principal_id] = (now + 3600, tok)
        return tok

    def request(self, principal_id: str, method: str, path: str, body: dict | None = None) -> httpx.Response:
        headers = {"Cf-Access-Jwt-Assertion": self.token(principal_id)}
        if method != "GET":
            headers.update({"X-PV-Requested-With": "peoplevault", "content-type": "application/json"})
        return self.http.request(method, f"{self.base}{path}", headers=headers, json=body)


# principal id -> suffix of the PV_CF_ACCESS_CLIENT_{ID,SECRET}_<suffix> pair recorded by setup:prod (seed:prod maps them)
PROD_PRINCIPAL_TOKENS = {"privacy-01": "PRIVACY", "hrbp-01": "HR", "mgr-001": "MANAGER", "analyst-01": "ANALYST"}


class ProdClient:
    """The deployed Worker through Cloudflare Access with the persona service tokens (production eval). Access checks
    the token at the edge and passes its JWT to the Worker. Status: written, not yet executed."""

    def __init__(self, env: dict[str, str], http: httpx.Client | None = None):
        self.base = env.get("PV_BASE_URL", "").rstrip("/")
        if not self.base:
            raise RuntimeError("PV_BASE_URL missing from .secrets/prod.env (run `npm run setup:prod`)")
        self.creds: dict[str, tuple[str, str]] = {}
        for principal, suffix in PROD_PRINCIPAL_TOKENS.items():
            cid, secret = env.get(f"PV_CF_ACCESS_CLIENT_ID_{suffix}"), env.get(f"PV_CF_ACCESS_CLIENT_SECRET_{suffix}")
            if cid and secret:
                self.creds[principal] = (cid, secret)
        if "privacy-01" not in self.creds:
            raise RuntimeError("the privacy persona's service token is missing from .secrets/prod.env (run `npm run setup:prod`)")
        self.http = http or httpx.Client(timeout=120.0)

    def principals(self) -> set[str]:
        return set(self.creds)

    def request(self, principal_id: str, method: str, path: str, body: dict | None = None) -> httpx.Response:
        cid, secret = self.creds[principal_id]
        headers = {"CF-Access-Client-Id": cid, "CF-Access-Client-Secret": secret}
        if method != "GET":
            headers.update({"X-PV-Requested-With": "peoplevault", "content-type": "application/json"})
        return self.http.request(method, f"{self.base}{path}", headers=headers, json=body)
