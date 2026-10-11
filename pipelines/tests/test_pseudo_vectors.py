import json

import pytest

from peoplevault import config
from peoplevault.pseudo import KINDS, TEST_MASTER_KEY, Pseudonymizer, base32_lower_nopad, from_b64, hkdf_sha256

VECTORS = json.loads((config.POLICY_DIR / "test-vectors" / "pseudonyms.json").read_text())


def test_vector_file_shape():
    assert len(VECTORS["vectors"]) == 12
    assert len(VECTORS["hkdf_rfc5869"]) == 2
    assert bytes.fromhex(VECTORS["master_key_hex"]) == TEST_MASTER_KEY


@pytest.mark.parametrize("v", VECTORS["vectors"], ids=lambda v: f"{v['kind']}-{v['employee_id']}")
def test_pseudonym_vectors(v):
    assert from_b64(VECTORS["master_key_b64"]).pseudonym(v["kind"], v["employee_id"]) == v["pseudonym"]


@pytest.mark.parametrize("h", VECTORS["hkdf_rfc5869"], ids=lambda h: h["case"])
def test_hkdf_rfc5869(h):
    okm = hkdf_sha256(bytes.fromhex(h["ikm_hex"]), bytes.fromhex(h["salt_hex"]), bytes.fromhex(h["info_hex"]), h["length"])
    assert okm.hex() == h["okm_hex"]


def test_properties_over_1200_ids():
    p = Pseudonymizer(TEST_MASTER_KEY)
    ids = [f"E{i:05d}" for i in range(1, 1201)]
    for kind in KINDS:
        values = [p.pseudonym(kind, e) for e in ids]
        assert len(set(values)) == 1200
        for e, v in zip(ids, values, strict=True):
            assert len(v) == 29 and v[:3] in {"wk_", "er_", "an_", "sr_"}
            assert e.lower() not in v and e[1:] not in v
    one = p.all("E00042")
    assert len(set(one.values())) == 4


def test_base32():
    assert base32_lower_nopad(b"foobar") == "mzxw6ytboi"


def test_policy_parameters_match_implementation():
    from peoplevault.policy.model import policy

    ps = policy().pseudonyms
    assert ps.salt == "peoplevault/v1" and ps.info_prefix == "pv-pseudonym:" and ps.message_prefix == "v1|"
    assert ps.length == 26
    assert ps.kinds == {"warehouse_key": "wk_", "employee_ref": "er_", "analytics_id": "an_", "subject_ref": "sr_"}
