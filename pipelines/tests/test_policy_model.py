import copy

import pytest
import yaml

from peoplevault import config
from peoplevault.policy.model import PURPOSES, TAGGED_CLASSES, Policy, policy


def _raw():
    return yaml.safe_load(config.POLICY_YAML.read_text())


def test_four_personas_five_purposes_six_tagged_classes():
    p = policy()
    assert list(p.personas) == ["hr_partner", "manager", "people_analyst", "privacy_officer"]
    assert list(p.purposes) == list(PURPOSES) and len(p.purposes) == 5
    assert list(p.data_classes.tagged) == list(TAGGED_CLASSES) and len(TAGGED_CLASSES) == 6


def test_visibility_matrix_complete_5x6():
    p = policy()
    assert set(p.visibility) == set(PURPOSES)
    for row in p.visibility.values():
        assert set(row) == set(TAGGED_CLASSES)
    cells = [v for row in p.visibility.values() for v in row.values()]
    assert len(cells) == 30
    assert cells.count("deny") == 18 and cells.count("allow") == 8
    assert cells.count("mask_nullify") == 2 and cells.count("mask_date_year") == 2


def test_matrix_matches_spec_section_8_3():
    v = policy().visibility
    assert v["employee_relations"]["date_of_birth"] == "mask_date_year"
    assert v["employee_relations"]["health_leave"] == "mask_nullify"
    assert v["team_management"]["compensation"] == "mask_nullify"
    assert v["workforce_analytics"]["protected_attribute"] == "allow"
    assert v["workforce_analytics"]["direct_identifier"] == "deny"


def test_every_view_and_query_column_classified():
    p = policy()
    classes = p.column_class
    for views in p.purpose_views.values():
        for view in views.values():
            for col in view.columns:
                assert col in classes
    for qs in p.queries.values():
        for q in qs.values():
            for col in q.columns:
                assert col in classes


def test_export_columns_all_classified():
    classes = policy().column_class
    hris = "employee_id, full_name, work_email, personal_email, phone, birth_date, gender, ethnicity, hire_date, termination_date, employment_status, job_title, job_level, org_unit, location, manager_employee_id, is_restricted, export_date"
    payroll = "employee_id, pay_period_end, base_salary, bonus_target_pct, currency"
    leave = "leave_id, employee_id, start_date, end_date, leave_type, leave_category, leave_reason, accommodation_note, status"
    perf = "review_id, employee_id, cycle, rating, review_text, reviewer_employee_id"
    extract = "analytics_id, org_unit, job_level, salary_band, rating_band, tenure_years, age_band, gender, terminated_in_month"
    for line in (hris, payroll, leave, perf, extract):
        for col in line.split(", "):
            assert col in classes, col


def test_no_view_selects_a_deny_column():
    p = policy()
    for purpose, views in p.purpose_views.items():
        for view in views.values():
            for col in view.columns:
                assert p.visibility_of(purpose, col) != "deny", (purpose, col)


def test_view_selecting_deny_column_is_rejected():
    raw = _raw()
    bad = copy.deepcopy(raw)
    bad["purpose_views"]["team_management"]["employees"]["columns"].append("gender")
    with pytest.raises(ValueError, match="deny column gender"):
        Policy.model_validate(bad)


def test_unknown_action_rejected():
    bad = copy.deepcopy(_raw())
    bad["personas"]["manager"]["grants"]["team_management"].append("drop_tables")
    with pytest.raises(ValueError, match="unknown action"):
        Policy.model_validate(bad)


def test_missing_category_rejected():
    bad = copy.deepcopy(_raw())
    bad["assets"] = [a for a in bad["assets"] if a["category"] != "application_caches"]
    with pytest.raises(ValueError, match="6 categories"):
        Policy.model_validate(bad)


def test_privacy_officer_holds_two_purposes_others_one():
    p = policy()
    assert list(p.personas["privacy_officer"].grants) == ["privacy_compliance", "legal_hold_management"]
    for name in ("hr_partner", "manager", "people_analyst"):
        assert len(p.personas[name].grants) == 1
