"""Population, org structure, legal holds and attribute changes (SPEC.md section 7.1).

Every entity family draws from its own `random.Random(f"{SEED}:{family}")`; CPython hashes string seeds with
SHA-512, so streams are stable across runs and machines. Nothing here iterates over a set or an unordered dict.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field, replace
from datetime import date, timedelta

from peoplevault.synth import counts as C
from peoplevault.synth.names import FIRST_NAMES, LAST_NAMES

LEVELS = ("IC1", "IC2", "IC3", "IC4", "IC5")
LEVEL_PREFIX = {"IC1": "Associate", "IC2": "", "IC3": "Senior", "IC4": "Staff", "IC5": "Principal"}
FAMILY = {
    "ENG-PLATFORM": "Platform Engineer", "ENG-PRODUCT": "Software Engineer", "ENG-DATA": "Data Engineer",
    "SALES-NA": "Account Executive", "SALES-EMEA": "Account Executive", "CUSTOMER-SUCCESS": "Customer Success Specialist",
    "MARKETING": "Marketing Specialist", "FINANCE": "Financial Analyst", "PEOPLE": "People Operations Specialist",
    "LEGAL": "Legal Specialist", "OPERATIONS": "Operations Specialist", "EXECUTIVE": "Executive Assistant",
}
MANAGER_TITLE = {
    "ENG-PLATFORM": "Engineering Manager", "ENG-PRODUCT": "Engineering Manager", "ENG-DATA": "Data Engineering Manager",
    "SALES-NA": "Sales Manager", "SALES-EMEA": "Sales Manager", "CUSTOMER-SUCCESS": "Customer Success Lead",
    "MARKETING": "Marketing Manager", "FINANCE": "Finance Manager", "PEOPLE": "People Operations Manager",
    "LEGAL": "Legal Operations Manager", "OPERATIONS": "Operations Manager",
}
HEAD_TITLE = {
    "ENG-PLATFORM": "Head of Platform Engineering", "ENG-PRODUCT": "Head of Product Engineering", "ENG-DATA": "Head of Data",
    "SALES-NA": "Head of Sales North America", "SALES-EMEA": "Head of Sales EMEA", "CUSTOMER-SUCCESS": "Head of Customer Success",
    "MARKETING": "Head of Marketing", "FINANCE": "Head of Finance", "PEOPLE": "Head of People", "LEGAL": "General Counsel",
    "OPERATIONS": "Head of Operations",
}
UNIT_WEIGHT = {
    "ENG-PLATFORM": 1.6, "ENG-PRODUCT": 1.8, "ENG-DATA": 1.2, "SALES-NA": 1.4, "SALES-EMEA": 1.0,
    "CUSTOMER-SUCCESS": 1.0, "MARKETING": 0.8, "FINANCE": 0.7, "PEOPLE": 0.8, "LEGAL": 0.5, "OPERATIONS": 0.9,
}
NON_EXEC_UNITS: tuple[str, ...] = tuple(u for u in C.ORG_UNITS if u != "EXECUTIVE")
LOCATIONS = ("San Jose", "Austin", "New York", "Toronto", "Remote US")
EMEA_LOCATIONS = ("London", "Dublin")
BASE_SALARY = {"IC1": 72000, "IC2": 96000, "IC3": 126000, "IC4": 156000, "IC5": 186000, "M1": 168000, "M2": 232000, "E1": 320000}
BONUS_PCT = {"IC1": 5.0, "IC2": 7.5, "IC3": 10.0, "IC4": 12.5, "IC5": 15.0, "M1": 15.0, "M2": 25.0, "E1": 50.0}
GENDERS = (("female", 48), ("male", 48), ("nonbinary", 4))
ETHNICITIES = ("group_a", "group_b", "group_c", "group_d", "group_e")
HOLD_MATTERS = ("LH-2026-001", "LH-2026-002")


def rng(family: str) -> random.Random:
    return random.Random(f"{C.SEED}:{family}")


def eid(n: int) -> str:
    return f"E{n:05d}"


def rand_date(r: random.Random, lo: date, hi: date) -> date:
    return date.fromordinal(r.randint(lo.toordinal(), hi.toordinal()))


def title_for(org_unit: str, level: str) -> str:
    if level == "E1":
        return "Chief Executive Officer"
    if level == "M2":
        return HEAD_TITLE[org_unit]
    if level == "M1":
        return MANAGER_TITLE[org_unit]
    return f"{LEVEL_PREFIX[level]} {FAMILY[org_unit]}".strip()


@dataclass
class Employee:
    employee_id: str
    first_name: str
    last_name: str
    personal_email: str
    phone: str
    birth_date: date
    gender: str
    ethnicity: str
    hire_date: date
    termination_date: date | None
    org_unit: str
    job_level: str
    job_title: str
    location: str
    manager_id: str | None
    is_restricted: bool
    role: str  # ceo | org_head | line_manager | staff
    base_salary: int
    bonus_target_pct: float
    hold_matter: str | None = None
    principal_role: str | None = None  # hr_partner | people_analyst | privacy_officer | manager

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    @property
    def work_email(self) -> str:
        return f"{self.first_name.lower()}.{self.last_name.lower()}@peoplevault.test"

    @property
    def is_manager(self) -> bool:
        return self.role in ("ceo", "org_head", "line_manager")

    def active_on(self, d: date) -> bool:
        return self.hire_date <= d and (self.termination_date is None or self.termination_date > d)

    def employed_during(self, start: date, end: date) -> bool:
        return self.hire_date <= end and (self.termination_date is None or self.termination_date >= start)


@dataclass(frozen=True)
class Change:
    employee_id: str
    export_index: int  # effective from this weekly export onwards (1..12)
    kind: str  # promotion | transfer | manager_change
    org_unit: str | None = None
    manager_id: str | None = None
    job_level: str | None = None


@dataclass
class Population:
    employees: dict[str, Employee]
    changes: list[Change]
    org_heads: dict[str, str]  # unit -> employee id
    line_managers: dict[str, list[str]]  # unit -> ids
    hr_partners: list[str]
    analysts: list[str]
    privacy_officers: list[str]
    hr_partner_units: dict[str, list[str]]  # employee id -> 2 org units
    holds: dict[str, list[str]]  # matter -> subject ids (ordered)
    _state_cache: dict = field(default_factory=dict, repr=False)

    def ids(self) -> list[str]:
        return sorted(self.employees)

    def state(self, employee_id: str, export_index: int) -> Employee:
        """Attributes as of HRIS weekly export `export_index` (0..12); index -1 means before the exports."""
        key = (employee_id, export_index)
        if key not in self._state_cache:
            e = self.employees[employee_id]
            for ch in self.changes:
                if ch.employee_id != employee_id or ch.export_index > export_index:
                    continue
                if ch.kind == "promotion":
                    e = replace(e, job_level=ch.job_level, job_title=title_for(e.org_unit, ch.job_level))
                elif ch.kind == "transfer":
                    loc = e.location
                    if ch.org_unit == "SALES-EMEA" and loc not in EMEA_LOCATIONS:
                        loc = "London"
                    elif ch.org_unit != "SALES-EMEA" and loc in EMEA_LOCATIONS:
                        loc = "New York"
                    e = replace(e, org_unit=ch.org_unit, manager_id=ch.manager_id, job_title=title_for(ch.org_unit, e.job_level), location=loc)
                elif ch.kind == "manager_change":
                    e = replace(e, manager_id=ch.manager_id)
            self._state_cache[key] = e
        return self._state_cache[key]

    def final(self, employee_id: str) -> Employee:
        return self.state(employee_id, len(C.HRIS_WEEKLY_DATES) - 1)

    def promotion_date(self, employee_id: str) -> date | None:
        for ch in self.changes:
            if ch.employee_id == employee_id and ch.kind == "promotion":
                return C.HRIS_WEEKLY_DATES[ch.export_index]
        return None

    def held_subjects(self) -> list[str]:
        return [s for m in HOLD_MATTERS for s in self.holds[m]]

    def managers_ever(self, employee_id: str) -> list[str]:
        """Every manager the employee had at any point (initial and after changes)."""
        out = [self.employees[employee_id].manager_id]
        for ch in self.changes:
            if ch.employee_id == employee_id and ch.manager_id:
                out.append(ch.manager_id)
        return [m for m in dict.fromkeys(out) if m]


def _allocate(total: int, weights: dict[str, float], minimum: dict[str, int] | None = None) -> dict[str, int]:
    keys = list(weights)
    wsum = sum(weights.values())
    alloc = {k: int(total * weights[k] / wsum) for k in keys}
    if minimum:
        for k in keys:
            alloc[k] = max(alloc[k], minimum[k])
    i = 0
    order = sorted(keys, key=lambda k: -weights[k])
    while sum(alloc.values()) < total:
        alloc[order[i % len(order)]] += 1
        i += 1
    while sum(alloc.values()) > total:
        k = order[i % len(order)]
        if alloc[k] > (minimum or {}).get(k, 0):
            alloc[k] -= 1
        i += 1
    return alloc


def build_population() -> Population:
    # ---- ids and status --------------------------------------------------------------------------------
    r_status = rng("status")
    others = [eid(n) for n in range(2, C.EMPLOYEES_EVER + 1)]
    shuffled = r_status.sample(others, len(others))
    active_ids = [C.CEO_ID] + shuffled[: C.ACTIVE - 1]
    terminated_ids = shuffled[C.ACTIVE - 1 :]
    old_terminated = terminated_ids[: C.TERMINATED_PAST_RETENTION]
    recent_terminated = terminated_ids[C.TERMINATED_PAST_RETENTION :]
    assert len(terminated_ids) == C.TERMINATED and len(recent_terminated) == C.TERMINATED_RECENT

    # ---- names -------------------------------------------------------------------------------------------
    r_names = rng("names")
    combos = [(f, last) for f in FIRST_NAMES for last in LAST_NAMES]
    picked = r_names.sample(combos, C.EMPLOYEES_EVER)
    name_of = {eid(n): picked[n - 1] for n in range(1, C.EMPLOYEES_EVER + 1)}

    # ---- org structure among active employees -------------------------------------------------------------
    r_org = rng("org")
    pool = r_org.sample(active_ids[1:], len(active_ids) - 1)
    heads = pool[: C.ORG_HEADS]
    line_mgr_ids = pool[C.ORG_HEADS : C.ORG_HEADS + C.LINE_MANAGERS]
    staff_ids = pool[C.ORG_HEADS + C.LINE_MANAGERS :]
    assert len(staff_ids) == C.ACTIVE - C.MANAGERS
    org_heads = {u: heads[i] for i, u in enumerate(NON_EXEC_UNITS)}
    lm_alloc = _allocate(C.LINE_MANAGERS, UNIT_WEIGHT, {u: 3 for u in NON_EXEC_UNITS})
    line_managers: dict[str, list[str]] = {}
    cursor = 0
    for u in NON_EXEC_UNITS:
        line_managers[u] = line_mgr_ids[cursor : cursor + lm_alloc[u]]
        cursor += lm_alloc[u]
    exec_staff = staff_ids[: C.EXECUTIVE_STAFF]
    unit_staff = staff_ids[C.EXECUTIVE_STAFF :]
    staff_alloc = _allocate(len(unit_staff), UNIT_WEIGHT, {u: 4 * lm_alloc[u] for u in NON_EXEC_UNITS})
    staff_unit: dict[str, str] = {s: "EXECUTIVE" for s in exec_staff}
    staff_by_unit: dict[str, list[str]] = {}
    cursor = 0
    for u in NON_EXEC_UNITS:
        members = unit_staff[cursor : cursor + staff_alloc[u]]
        staff_by_unit[u] = members
        cursor += staff_alloc[u]
        for s in members:
            staff_unit[s] = u
    manager_of: dict[str, str] = {s: C.CEO_ID for s in exec_staff}
    for u in NON_EXEC_UNITS:
        managers = line_managers[u]
        members = staff_by_unit[u]
        for i, s in enumerate(members):
            # the first 3 per manager round-robin, then random, so every line manager has >= 3 reports
            manager_of[s] = managers[i % len(managers)] if i < 3 * len(managers) else r_org.choice(managers)
        for m in managers:
            manager_of[m] = org_heads[u]
        manager_of[org_heads[u]] = C.CEO_ID

    # ---- principals (non-manager staff) ---------------------------------------------------------------------
    r_pr = rng("principals")
    people_staff = staff_by_unit["PEOPLE"]
    chosen_people = r_pr.sample(people_staff, C.HR_PARTNERS + C.ANALYSTS)
    hr_partners = chosen_people[: C.HR_PARTNERS]
    analysts = chosen_people[C.HR_PARTNERS :]
    privacy_officers = r_pr.sample(staff_by_unit["LEGAL"], C.PRIVACY_OFFICERS)
    units = r_pr.sample(list(C.ORG_UNITS), len(C.ORG_UNITS))
    hr_partner_units = {hp: sorted(units[2 * i : 2 * i + 2]) for i, hp in enumerate(hr_partners)}
    principal_staff = set(hr_partners) | set(analysts) | set(privacy_officers)

    # ---- legal holds ---------------------------------------------------------------------------------------
    r_hold = rng("holds")
    eligible_active = [s for s in unit_staff if s not in principal_staff]
    held_active = r_hold.sample(eligible_active, 2)
    held_old = r_hold.sample(old_terminated, 2)
    held_recent = r_hold.sample(recent_terminated, 2)
    holds = {"LH-2026-001": [held_old[0], held_old[1], held_active[0]], "LH-2026-002": [held_active[1], held_recent[0], held_recent[1]]}
    held = set(held_active) | set(held_old) | set(held_recent)

    # ---- restricted ------------------------------------------------------------------------------------------
    r_res = rng("restricted")
    confidential_pool = [s for s in unit_staff if s not in principal_staff and s not in held]
    confidential = set(r_res.sample(confidential_pool, C.CONFIDENTIAL_NON_MANAGERS))

    # ---- build employee records ---------------------------------------------------------------------------
    r_person = rng("person")
    r_dates = rng("dates")
    employees: dict[str, Employee] = {}
    term_unit_weights = dict(UNIT_WEIGHT)
    for n in range(1, C.EMPLOYEES_EVER + 1):
        e_id = eid(n)
        first, last = name_of[e_id]
        g = r_person.choices([g for g, _ in GENDERS], weights=[w for _, w in GENDERS])[0]
        eth = r_person.choice(ETHNICITIES)
        birth = rand_date(r_person, date(1962, 1, 1), date(2002, 12, 31))
        phone = f"+1-555-01{r_person.randint(0, 99):02d}"
        personal = f"{first.lower()}{last.lower()}{r_person.randint(10, 99)}@example.test"
        noise = r_person.uniform(-0.08, 0.08)
        termination: date | None = None
        if e_id == C.CEO_ID:
            role, unit, level, manager = "ceo", "EXECUTIVE", "E1", None
            hire = date(2008, 3, 3)
        elif e_id in heads:
            role, unit, level, manager = "org_head", next(u for u, h in org_heads.items() if h == e_id), "M2", C.CEO_ID
            hire = rand_date(r_dates, date(2008, 6, 1), date(2016, 12, 31))
        elif e_id in line_mgr_ids:
            unit = next(u for u, ms in line_managers.items() if e_id in ms)
            role, level, manager = "line_manager", "M1", org_heads[unit]
            hire = rand_date(r_dates, date(2009, 1, 1), date(2018, 12, 31))
        elif e_id in staff_unit:
            role, unit, manager = "staff", staff_unit[e_id], manager_of[e_id]
            level = r_person.choices(LEVELS, weights=[20, 30, 28, 15, 7])[0]
            if e_id in principal_staff:
                hire = rand_date(r_dates, date(2012, 1, 1), date(2022, 12, 31))
                level = "IC3"
            elif e_id in held_active:
                hire = rand_date(r_dates, date(2025, 12, 1), date(2026, 3, 31))
                level = "IC1"
            else:
                hire = rand_date(r_dates, date(2010, 1, 1), date(2026, 5, 31))
        else:  # terminated
            role = "staff"
            unit = r_person.choices(list(term_unit_weights), weights=list(term_unit_weights.values()))[0]
            level = r_person.choices(LEVELS[:4], weights=[25, 35, 28, 12])[0]
            manager = r_person.choice(line_managers[unit])
            if e_id in old_terminated:
                termination = rand_date(r_dates, date(2019, 2, 1), date(2023, 9, 26))
                if e_id in held_old:
                    hire = rand_date(r_dates, date(2012, 1, 1), min(date(2019, 9, 30), termination - timedelta(days=365)))
                else:
                    hire = rand_date(r_dates, date(2010, 1, 1), termination - timedelta(days=365))
            else:
                if e_id in held_recent:
                    termination = rand_date(r_dates, date(2024, 1, 8), date(2024, 5, 31))
                else:
                    termination = rand_date(r_dates, date(2023, 10, 4), date(2026, 6, 30))
                hire = rand_date(r_dates, date(2010, 1, 1), termination - timedelta(days=180))
        if unit == "SALES-EMEA":
            location = r_person.choice(EMEA_LOCATIONS)
        else:
            location = r_person.choice(LOCATIONS)
        title = title_for(unit, level)
        if e_id in hr_partners:
            title = "HR Business Partner"
        elif e_id in analysts:
            title = "People Analyst"
        elif e_id in privacy_officers:
            title = "Privacy Counsel"
        salary = int(round(BASE_SALARY[level] * (1 + noise) / 500.0) * 500)
        employees[e_id] = Employee(
            employee_id=e_id, first_name=first, last_name=last, personal_email=personal, phone=phone, birth_date=birth,
            gender=g, ethnicity=eth, hire_date=hire, termination_date=termination, org_unit=unit, job_level=level,
            job_title=title, location=location, manager_id=manager,
            is_restricted=(role in ("ceo", "org_head") or e_id in confidential), role=role, base_salary=salary,
            bonus_target_pct=BONUS_PCT[level],
        )
    for matter in HOLD_MATTERS:
        for s in holds[matter]:
            employees[s].hold_matter = matter
    for hp in hr_partners:
        employees[hp].principal_role = "hr_partner"
    for a in analysts:
        employees[a].principal_role = "people_analyst"
    for p in privacy_officers:
        employees[p].principal_role = "privacy_officer"
    for m in [C.CEO_ID, *heads, *line_mgr_ids]:
        employees[m].principal_role = "manager"

    # ---- attribute changes inside the 13 weekly exports ---------------------------------------------------
    r_ch = rng("changes")
    candidates = [
        s for s in unit_staff
        if s not in principal_staff and s not in held and s not in confidential
    ]
    picked_changes = r_ch.sample(candidates, len(candidates))
    report_count = {m: 0 for m in line_mgr_ids}
    for s in unit_staff:
        report_count[manager_of[s]] += 1
    changes: list[Change] = []
    promos = transfers = mgr_changes = 0
    for s in picked_changes:
        e = employees[s]
        week = r_ch.randint(1, len(C.HRIS_WEEKLY_DATES) - 1)
        if promos < C.PROMOTIONS and e.job_level != "IC5":
            nxt = LEVELS[LEVELS.index(e.job_level) + 1]
            changes.append(Change(s, week, "promotion", job_level=nxt))
            promos += 1
        elif transfers < C.TRANSFERS and report_count[e.manager_id] > 3:
            new_unit = r_ch.choice([u for u in NON_EXEC_UNITS if u != e.org_unit])
            new_mgr = r_ch.choice(line_managers[new_unit])
            changes.append(Change(s, week, "transfer", org_unit=new_unit, manager_id=new_mgr))
            report_count[e.manager_id] -= 1
            report_count[new_mgr] += 1
            transfers += 1
        elif mgr_changes < C.MANAGER_CHANGES and report_count[e.manager_id] > 3 and len(line_managers[e.org_unit]) > 1:
            new_mgr = r_ch.choice([m for m in line_managers[e.org_unit] if m != e.manager_id])
            changes.append(Change(s, week, "manager_change", manager_id=new_mgr))
            report_count[e.manager_id] -= 1
            report_count[new_mgr] += 1
            mgr_changes += 1
        if promos == C.PROMOTIONS and transfers == C.TRANSFERS and mgr_changes == C.MANAGER_CHANGES:
            break
    assert (promos, transfers, mgr_changes) == (C.PROMOTIONS, C.TRANSFERS, C.MANAGER_CHANGES)
    changes.sort(key=lambda c: (c.export_index, c.employee_id))
    return Population(
        employees=employees, changes=changes, org_heads=org_heads, line_managers=line_managers,
        hr_partners=hr_partners, analysts=analysts, privacy_officers=privacy_officers,
        hr_partner_units=hr_partner_units, holds=holds,
    )
