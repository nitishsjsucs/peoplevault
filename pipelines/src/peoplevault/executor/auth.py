"""Executor authentication. Local: a JWT minted from the dev key with common_name pv-executor-local and an empty
sub (the shape of an Access service token JWT). Production: the pv-executor Access service token headers; Access
issues the JWT at the edge."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass

import jwt
from jwt.algorithms import RSAAlgorithm

from peoplevault import config

EXECUTOR_LOCAL = "pv-executor-local"


@dataclass
class DevJwtAuth:
    private_jwk: dict
    issuer: str
    audience: str
    common_name: str = EXECUTOR_LOCAL
    ttl: int = 600
    _cached: tuple[float, str] | None = None

    def headers(self) -> dict[str, str]:
        now = time.time()
        if self._cached is None or self._cached[0] < now + 60:
            key = RSAAlgorithm.from_jwk(json.dumps(self.private_jwk))
            iat = int(now)
            token = jwt.encode(
                {"iss": self.issuer, "aud": [self.audience], "sub": "", "common_name": self.common_name, "iat": iat, "nbf": iat, "exp": iat + self.ttl},
                key,
                algorithm="RS256",
                headers={"kid": self.private_jwk.get("kid", "dev")},
            )
            self._cached = (now + self.ttl, token)
        return {"Cf-Access-Jwt-Assertion": self._cached[1]}

    @classmethod
    def from_local_settings(cls) -> DevJwtAuth:
        s = config.local_settings()
        if not s.private_jwk:
            raise RuntimeError("DEV_ACCESS_PRIVATE_JWK missing from .dev.vars; run `npm run dev:keys`")
        return cls(s.private_jwk, s.issuer, s.audience)


@dataclass
class AccessServiceTokenAuth:
    client_id: str
    client_secret: str

    def headers(self) -> dict[str, str]:
        return {"CF-Access-Client-Id": self.client_id, "CF-Access-Client-Secret": self.client_secret}
