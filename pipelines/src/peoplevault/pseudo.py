"""HMAC pseudonymization with per-kind HKDF keys (SPEC.md section 10). Identical to src/worker/pseudo/hmac.ts.

    K_kind    = HKDF-SHA256(IKM = M, salt = "peoplevault/v1", info = "pv-pseudonym:" + kind, L = 32)
    pseudonym = prefix + base32_lower_nopad(HMAC-SHA256(K_kind, "v1|" + employee_id))[0:26]

Keyed rather than plain hashing: 1,200 sequential ids hashed without a key are reversible by enumeration.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Literal

Kind = Literal["warehouse_key", "employee_ref", "analytics_id", "subject_ref"]
KINDS: tuple[Kind, ...] = ("warehouse_key", "employee_ref", "analytics_id", "subject_ref")
PREFIXES: dict[str, str] = {"warehouse_key": "wk_", "employee_ref": "er_", "analytics_id": "an_", "subject_ref": "sr_"}
SALT = b"peoplevault/v1"
INFO_PREFIX = b"pv-pseudonym:"
MESSAGE_PREFIX = b"v1|"
LENGTH = 26


def hkdf_sha256(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """RFC 5869 extract-and-expand with SHA-256."""
    if length > 255 * 32:
        raise ValueError("length too large")
    prk = hmac.new(salt or b"\x00" * 32, ikm, hashlib.sha256).digest()
    okm, block, counter = b"", b"", 1
    while len(okm) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        okm += block
        counter += 1
    return okm[:length]


def base32_lower_nopad(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").rstrip("=").lower()


class Pseudonymizer:
    def __init__(self, master_key: bytes):
        if len(master_key) < 16:
            raise ValueError("master key too short")
        self._keys = {kind: hkdf_sha256(master_key, SALT, INFO_PREFIX + kind.encode(), 32) for kind in KINDS}

    def pseudonym(self, kind: Kind, employee_id: str) -> str:
        if kind not in self._keys:
            raise ValueError(f"unknown pseudonym kind {kind}")
        mac = hmac.new(self._keys[kind], MESSAGE_PREFIX + employee_id.encode(), hashlib.sha256).digest()
        return PREFIXES[kind] + base32_lower_nopad(mac)[:LENGTH]

    def all(self, employee_id: str) -> dict[str, str]:
        return {kind: self.pseudonym(kind, employee_id) for kind in KINDS}


def from_b64(master_key_b64: str) -> Pseudonymizer:
    return Pseudonymizer(base64.b64decode(master_key_b64))


TEST_MASTER_KEY = bytes(range(32))
