"""No token of any subject matches any value or token of another subject (SPEC.md sections 7.1 and 14.3).

Checked as a bare substring (which implies the boundary-aware check) over all 1,200 subjects, plus the
boundary-aware matchers themselves on a sample against every other subject's values.
"""

from __future__ import annotations

import random
import re
from functools import lru_cache

from synth_helpers import exports, population

from peoplevault.pseudo import TEST_MASTER_KEY, Pseudonymizer
from peoplevault.synth.names import FIRST_NAMES, LAST_NAMES, prefix_free, suffix_free
from peoplevault.verify.tokens import matchers, subject_tokens

OWN_VALUE_FIELDS = (
    "employee_id", "full_name", "work_email", "personal_email", "phone", "birth_date", "gender", "ethnicity", "hire_date",
    "termination_date", "employment_status", "job_title", "job_level", "org_unit", "location", "export_date",
    "pay_period_end", "base_salary", "bonus_target_pct", "currency", "leave_id", "start_date", "end_date", "leave_type",
    "leave_category", "leave_reason", "accommodation_note", "status", "review_id", "cycle", "rating", "review_text",
)


@lru_cache(maxsize=1)
def subject_data():
    pop = population()
    ps = Pseudonymizer(TEST_MASTER_KEY)
    values: dict[str, set[str]] = {e: set() for e in pop.employees}
    tokens: dict[str, dict[str, str]] = {}
    for e_id in pop.employees:
        refs = ps.all(e_id)
        f = pop.final(e_id)
        tokens[e_id] = {"employee_id": e_id, "work_email": f.work_email, "full_name": f.full_name, **{k: refs[k] for k in ("employee_ref", "warehouse_key", "analytics_id")}}
        values[e_id].update(refs.values())
    for obj in exports():
        for row in obj.rows:
            owner = row["employee_id"]
            for field in OWN_VALUE_FIELDS:
                v = row.get(field)
                if v is not None:
                    values[owner].add(str(v))
    return tokens, values


def test_first_names_suffix_free_last_names_prefix_free():
    assert suffix_free(FIRST_NAMES) and prefix_free(LAST_NAMES)


def test_no_cross_subject_substring_collisions():
    tokens, values = subject_data()
    ids = set(tokens)
    emails = {t["work_email"]: e for e, t in tokens.items()}
    names = {t["full_name"]: e for e, t in tokens.items()}
    pseudo = {t[k]: e for e, t in tokens.items() for k in ("employee_ref", "warehouse_key", "analytics_id")}
    pseudo.update({v: e for e, vs in values.items() for v in vs if re.fullmatch(r"(wk|er|an|sr)_[a-z2-7]{26}", v)})
    problems = []
    for owner, vals in values.items():
        for v in vals:
            for m in re.finditer(r"E\d{5}", v):
                if m.group() in ids and m.group() != owner:
                    problems.append((owner, "employee_id", v))
            for m in re.finditer(r"(?:wk|er|an|sr)_[a-z2-7]{26}", v):
                if pseudo.get(m.group(), owner) != owner:
                    problems.append((owner, "pseudonym", v))
            for m in re.finditer(r"[A-Za-z0-9._%+-]+@peoplevault\.test", v):
                local = m.group()
                for i in range(len(local)):
                    hit = emails.get(local[i:])
                    if hit is not None and hit != owner:
                        problems.append((owner, "work_email", v))
            for i, ch in enumerate(v):
                if ch != " ":
                    continue
                left, right = v[:i], v[i + 1 :]
                for first in FIRST_NAMES:
                    if not left.endswith(first):
                        continue
                    for last in LAST_NAMES:
                        if right.startswith(last):
                            hit = names.get(f"{first} {last}")
                            if hit is not None and hit != owner:
                                problems.append((owner, "full_name", v))
    assert problems == []


def test_boundary_aware_matchers_on_a_sample():
    tokens, values = subject_data()
    sample = random.Random(7).sample(sorted(tokens), 25)
    for e_id in sample:
        ms = matchers(subject_tokens(tokens[e_id]))
        combined = re.compile("|".join(f"(?:{m.pattern})" for m in ms))
        for other, vals in values.items():
            if other == e_id:
                continue
            for v in vals:
                assert combined.search(v) is None, (e_id, other, v)
        own_hits = sum(1 for v in values[e_id] if combined.search(v))
        assert own_hits >= 3  # the subject's own values do match


def test_record_ids_never_embed_an_employee_id():
    for obj in exports():
        for row in obj.rows:
            for col in ("leave_id", "review_id"):
                if col in row:
                    assert re.fullmatch(r"(LV|RV)-\d{6}", row[col])
                    assert re.search(r"E\d{5}", row[col]) is None


def test_known_collision_shapes_are_not_matched():
    from peoplevault.verify.tokens import TokenMatcher, pattern_for

    email = TokenMatcher("work_email", "ian.chen@peoplevault.test", pattern_for("work_email", "ian.chen@peoplevault.test"))
    assert not email.test("brian.chen@peoplevault.test")
    assert email.test("contact: ian.chen@peoplevault.test.")
    name = TokenMatcher("full_name", "Ann Li", pattern_for("full_name", "Ann Li"))
    assert not name.test("Ann Lin") and not name.test("Joann Li") and name.test("Ann Li, Sales")
    eid = TokenMatcher("employee_id", "E00042", pattern_for("employee_id", "E00042"))
    assert not eid.test("E000421") and not eid.test("XE00042") and eid.test("id=E00042;")
