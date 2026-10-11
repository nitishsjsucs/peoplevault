"""120 labeled synthetic columns for the schema-drift triage eval (SPEC.md sections 16.3 and 30.3.6).

Each column has a name, 5 synthetic sample values and the data class a privacy reviewer would give it. 84 columns are
sensitive (the six policy-tagged classes) and 36 are not. In each class about half of the names say what the column
holds (``home_phone``) and the rest are opaque (``fld_11``), so only the values tell; the rule classes see the names
and a few value patterns, and the eval measures what the model adds. Deterministic: the same seed gives the same
columns. The values are made up here from small pools; none is read from the synthetic population.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass

SEED = 20261011
SENSITIVE = ("direct_identifier", "date_of_birth", "compensation", "performance", "health_leave", "protected_attribute")
UNTAGGED = ("job", "coarsened", "pseudonym")
CLASSES = SENSITIVE + UNTAGGED

FIRST = ["Ana", "Bruno", "Chiara", "Dmitri", "Elif", "Farah", "Goran", "Hana", "Ivo", "Jun", "Kalani", "Lior", "Mira", "Nnamdi", "Oskar", "Priya"]
LAST = ["Abreu", "Bakshi", "Castell", "Dvorak", "Eriksen", "Fofana", "Grieve", "Haddad", "Ilves", "Juarez", "Kowal", "Lindqvist", "Moreau", "Nakata"]
STREETS = ["Rua das Flores", "Elm Street", "Calle Mayor", "Ringstrasse", "Harbour Road", "Via Roma"]


@dataclass(frozen=True)
class LabeledColumn:
    id: str
    name: str
    samples: tuple[str, ...]
    label: str
    opaque: bool

    @property
    def sensitive(self) -> bool:
        return self.label in SENSITIVE


Gen = Callable[[random.Random], str]


def _name(r: random.Random) -> str:
    return f"{r.choice(FIRST)} {r.choice(LAST)}"


def _email(r: random.Random) -> str:
    return f"{r.choice(FIRST).lower()}.{r.choice(LAST).lower()}{r.randint(1, 99)}@mailbox.example"


def _phone(r: random.Random) -> str:
    return f"+{r.choice([1, 44, 351, 49])} {r.randint(200, 999)} {r.randint(100, 999)} {r.randint(1000, 9999)}"


def _address(r: random.Random) -> str:
    return f"{r.randint(1, 240)} {r.choice(STREETS)}, apt {r.randint(1, 30)}"


def _gov_id(r: random.Random) -> str:
    return f"{r.randint(100, 899)}-{r.randint(10, 99)}-{r.randint(1000, 9999)}"


def _passport(r: random.Random) -> str:
    return f"{r.choice('PXCN')}{r.randint(1000000, 9999999)}"


def _emp_no(r: random.Random) -> str:
    return f"EMP-{r.randint(10000, 99999)}"


def _birth(r: random.Random) -> str:
    return f"{r.randint(1958, 2004)}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}"


def _birth_us(r: random.Random) -> str:
    return f"{r.randint(1, 12):02d}/{r.randint(1, 28):02d}/{r.randint(1958, 2004)}"


def _money(r: random.Random) -> str:
    return f"{r.randint(42, 210) * 1000}"


def _money_fmt(r: random.Random) -> str:
    return f"${r.randint(42, 210):,},{r.randint(0, 9)}00"


def _money_cur(r: random.Random) -> str:
    return f"{r.choice(['USD', 'EUR', 'GBP'])} {r.randint(40, 180) * 1000}"


def _pct(r: random.Random) -> str:
    return f"{r.choice([2, 3, 4, 5, 6, 8, 10, 12])}.{r.randint(0, 9)}%"


def _rating(r: random.Random) -> str:
    return r.choice(["1 - Below", "2 - Partially meets", "3 - Meets", "4 - Exceeds", "5 - Outstanding"])


def _review(r: random.Random) -> str:
    return r.choice(
        ["Exceeds expectations on delivery", "Needs improvement in stakeholder communication", "Strong mentor, missed two deadlines",
         "Consistently meets goals", "Placed on improvement plan in Q2", "Excellent ownership of the migration"]
    )


def _health(r: random.Random) -> str:
    return r.choice(
        ["recovering from knee surgery", "migraine, two days", "physiotherapy twice weekly", "stress leave, return in November",
         "chronic back pain, standing desk", "post-operative rest", "asthma, avoid dusty sites", "hearing aid, captioned meetings"]
    )


def _leave_reason(r: random.Random) -> str:
    return r.choice(["maternity", "medical", "bereavement", "caregiver", "disability", "sick"])


def _gender(r: random.Random) -> str:
    return r.choice(["F", "M", "Non-binary", "F", "M"])


def _ethnicity(r: random.Random) -> str:
    return r.choice(["Hispanic or Latino", "Asian", "Black or African American", "White", "Two or more races"])


def _religion(r: random.Random) -> str:
    return r.choice(["Catholic", "Muslim", "Hindu", "None", "Jewish", "Buddhist"])


def _orientation(r: random.Random) -> str:
    return r.choice(["heterosexual", "gay", "bisexual", "prefer not to say"])


def _nationality(r: random.Random) -> str:
    return r.choice(["Brazilian", "Indian", "German", "Nigerian", "Portuguese", "Japanese"])


def _marital(r: random.Random) -> str:
    return r.choice(["Married", "Single", "Divorced", "Civil partnership"])


def _yes_no(r: random.Random) -> str:
    return r.choice(["yes", "no", "no", "yes"])


def _union(r: random.Random) -> str:
    return r.choice(["member", "non-member", "member"])


def _age(r: random.Random) -> str:
    return str(r.randint(22, 64))


def _dept(r: random.Random) -> str:
    return r.choice(["Engineering", "Finance", "People", "Sales", "Legal", "Operations"])


def _site(r: random.Random) -> str:
    return r.choice(["Lisbon", "Austin", "Pune", "Berlin", "Toronto"])


def _title(r: random.Random) -> str:
    return r.choice(["Senior Analyst", "Staff Engineer", "Account Executive", "Recruiter", "Product Manager"])


def _level(r: random.Random) -> str:
    return r.choice(["L3", "L4", "L5", "M1", "IC2"])


def _cost_center(r: random.Random) -> str:
    return r.choice(["CC-1010", "CC-2040", "CC-3300", "FIN-OPS", "ENG-PLAT"])


def _status(r: random.Random) -> str:
    return r.choice(["active", "on_leave", "terminated", "active"])


def _date(r: random.Random) -> str:
    return f"{r.randint(2015, 2026)}-{r.randint(1, 12):02d}-{r.randint(1, 28):02d}"


def _fte(r: random.Random) -> str:
    return r.choice(["1.0", "0.8", "0.5", "1.0"])


def _shift(r: random.Random) -> str:
    return r.choice(["day", "night", "rotating", "weekend"])


def _contract(r: random.Random) -> str:
    return r.choice(["permanent", "fixed-term", "contractor", "intern"])


def _band_age(r: random.Random) -> str:
    return r.choice(["20-29", "30-39", "40-49", "50-59", "60+"])


def _band_salary(r: random.Random) -> str:
    return r.choice(["<50k", "50k-75k", "75k-100k", "100k-150k", "150k+"])


def _band_tenure(r: random.Random) -> str:
    return r.choice(["0-1y", "1-3y", "3-5y", "5-10y", "10y+"])


def _band_rating(r: random.Random) -> str:
    return r.choice(["low", "mid", "high"])


def _quartile(r: random.Random) -> str:
    return r.choice(["Q1", "Q2", "Q3", "Q4"])


def _range(r: random.Random) -> str:
    lo = r.choice([0, 10, 50, 100, 250])
    return f"{lo}-{lo * 2 + 9}"


def _year_bin(r: random.Random) -> str:
    return r.choice(["2010-2014", "2015-2019", "2020-2024", "2025+"])


def _hexkey(r: random.Random) -> str:
    return "".join(r.choice("0123456789abcdef") for _ in range(32))


def _token(r: random.Random) -> str:
    return "tok_" + "".join(r.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(20))


def _base32ref(r: random.Random) -> str:
    return "vr_" + "".join(r.choice("abcdefghijklmnopqrstuvwxyz234567") for _ in range(26))


def _uuid(r: random.Random) -> str:
    h = _hexkey(r)
    return f"{h[:8]}-{h[8:12]}-4{h[13:16]}-a{h[17:20]}-{h[20:32]}"


# (name, generator, opaque) per class; 120 in all
SPEC: dict[str, list[tuple[str, Gen, bool]]] = {
    "direct_identifier": [
        ("personal_email_2", _email, False), ("home_phone", _phone, False), ("mobile_number", _phone, False), ("home_address", _address, False),
        ("emergency_contact_name", _name, False), ("national_id", _gov_id, False), ("passport_no", _passport, False), ("employee_number", _emp_no, False),
        ("legal_name", _name, False), ("private_email", _email, False),
        ("fld_11", _email, True), ("attr_contact", _phone, True), ("col_c", _name, True), ("x_ref_ext", _gov_id, True), ("misc_1", _address, True),
        ("notes_ident", _name, True), ("value_a", _passport, True), ("f_17", _emp_no, True), ("c_display", _name, True), ("field_9", _email, True),
    ],
    "date_of_birth": [
        ("birthdate", _birth, False), ("date_of_birth_2", _birth_us, False), ("dob_iso", _birth, False), ("born_on", _birth, False),
        ("d1", _birth, True), ("fld_date_x", _birth_us, True), ("attr_d", _birth, True), ("col_k", _birth_us, True),
    ],
    "compensation": [
        ("annual_salary_usd", _money, False), ("bonus_paid", _money_fmt, False), ("equity_grant_value", _money_cur, False), ("hourly_wage", lambda r: f"{r.randint(18, 95)}.{r.randint(0, 99):02d}", False),
        ("commission_q3", _money_fmt, False), ("pension_contribution", _money_cur, False), ("net_pay", _money, False), ("merit_increase_pct", _pct, False),
        ("amt_1", _money_fmt, True), ("fld_money", _money_cur, True), ("col_n", _money, True), ("val_a", _money_cur, True), ("x_total", _money_fmt, True), ("misc_amt", _money, True),
    ],
    "performance": [
        ("perf_score_2025", _rating, False), ("manager_review_text", _review, False), ("calibration_rating", _rating, False), ("goal_attainment_score", _pct, False),
        ("pip_flag", _yes_no, False), ("disciplinary_note", _review, False), ("nine_box_position", lambda r: r.choice(["high potential", "core", "solid performer", "at risk"]), False),
        ("peer_feedback", _review, False),
        ("rv_1", _review, True), ("txt_7", _review, True), ("col_r", _rating, True), ("fld_eval", _rating, True), ("notes_mgr", _review, True), ("x_score", _rating, True),
    ],
    "health_leave": [
        ("sick_days_ytd", lambda r: str(r.randint(0, 14)), False), ("medical_condition", _health, False), ("disability_status", _yes_no, False), ("accommodation_request", _health, False),
        ("maternity_leave_start", _date, False), ("leave_reason_detail", _leave_reason, False), ("fmla_case_note", _health, False), ("workplace_injury", _health, False),
        ("notes_2", _health, True), ("fld_abs", _health, True), ("col_h", _health, True), ("x_case", _health, True), ("attr_m", _leave_reason, True), ("misc_note", _health, True),
    ],
    "protected_attribute": [
        ("gender_identity", _gender, False), ("ethnic_origin", _ethnicity, False), ("religion", _religion, False), ("sexual_orientation", _orientation, False),
        ("nationality", _nationality, False), ("marital_status", _marital, False), ("veteran_status", _yes_no, False), ("union_member", _union, False),
        ("g", _gender, True), ("attr_e", _ethnicity, True), ("col_rel", _religion, True), ("fld_ms", _marital, True), ("x_cit", _nationality, True), ("misc_age", _age, True),
    ],
    "job": [
        ("job_family", _dept, False), ("cost_center_code", _cost_center, False), ("office_site", _site, False), ("team_name", _dept, False),
        ("fte_ratio", _fte, False), ("shift_pattern", _shift, False), ("contract_type", _contract, False), ("role_start_date", _date, False),
        ("division_name", _dept, False), ("job_level_2", _level, False),
        ("c1", _dept, True), ("fld_loc", _site, True), ("attr_t", _title, True), ("col_lvl", _level, True), ("x_dept", _cost_center, True), ("misc_s", _status, True),
    ],
    "coarsened": [
        ("age_bracket", _band_age, False), ("salary_band_2026", _band_salary, False), ("tenure_bucket", _band_tenure, False), ("rating_band_h1", _band_rating, False),
        ("headcount_range", _range, False), ("hire_year_bin", _year_bin, False),
        ("b1", _band_age, True), ("fld_rng", _band_salary, True), ("col_q", _quartile, True), ("x_grp", _band_tenure, True),
    ],
    "pseudonym": [
        ("vendor_person_key", _hexkey, False), ("analytics_token", _token, False), ("hashed_employee", _hexkey, False), ("surrogate_id", _uuid, False), ("ext_ref", _base32ref, False),
        ("k1", _hexkey, True), ("fld_tok", _token, True), ("col_h2", _hexkey, True), ("x_id", _base32ref, True), ("misc_k", _uuid, True),
    ],
}


def columns(seed: int = SEED) -> list[LabeledColumn]:
    r = random.Random(seed)
    out: list[LabeledColumn] = []
    for label in CLASSES:
        for name, gen, opaque in SPEC[label]:
            samples = tuple(gen(r) for _ in range(5))
            out.append(LabeledColumn(id=f"c{len(out) + 1:03d}", name=name, samples=samples, label=label, opaque=opaque))
    return out
