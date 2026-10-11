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
