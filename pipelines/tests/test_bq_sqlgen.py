"""Golden BigQuery SQL generated from the policy (SPEC.md sections 15.4, 15.5, 15.7)."""

from peoplevault.policy import sqlgen
from peoplevault.policy.model import policy


def test_table_function_golden():
    p = policy()
    q = p.queries["team_management"]["list"]
    assert sqlgen.routine_sql(p, "team_management", q, "bigquery") == (
        "create or replace table function `{project}.peoplevault_purpose_team_management.direct_reports`(p_manager_key STRING) as ("
        "select employee_ref, full_name, work_email, job_title, job_level, org_unit, employment_status "
        "from `{project}.peoplevault_purpose_team_management.employees` where manager_key = p_manager_key)"
    )
    q = p.queries["employee_relations"]["profile"]
    sql = sqlgen.routine_sql(p, "employee_relations", q, "bigquery")
    assert "(p_org_units ARRAY<STRING>, p_employee_ref STRING)" in sql
    assert "where org_unit in unnest(p_org_units) and employee_ref = p_employee_ref)" in sql


def test_identity_lookup_golden_both_dialects():
    p = policy()
    q = p.queries["privacy_compliance"]["identity_lookup"]
    assert sqlgen.routine_sql(p, "privacy_compliance", q, "duckdb") == (
        "create or replace macro peoplevault_purpose_privacy_compliance.identity_lookup(p_q) as table "
        "select employee_ref, full_name, work_email, org_unit, employment_status from peoplevault_purpose_privacy_compliance.directory "
        "where (starts_with(lower(full_name), lower(p_q)) or starts_with(lower(work_email), lower(p_q))) order by full_name limit 20"
    )


def test_row_access_policies_golden():
    macro = sqlgen.row_access_macro(policy())
    assert (
        'create or replace row access policy rap_full on {{ this }} grant to ("serviceAccount:peoplevault-er-reader@{{ target.project }}.iam.gserviceaccount.com", '
        '"serviceAccount:peoplevault-pc-reader@{{ target.project }}.iam.gserviceaccount.com", "serviceAccount:peoplevault-lh-reader@{{ target.project }}.iam.gserviceaccount.com", '
        '"serviceAccount:peoplevault-executor@{{ target.project }}.iam.gserviceaccount.com") filter using (true);'
    ) in macro
    assert (
        'create or replace row access policy rap_non_restricted on {{ this }} grant to ("serviceAccount:peoplevault-tm-reader@{{ target.project }}.iam.gserviceaccount.com", '
        '"serviceAccount:peoplevault-wa-reader@{{ target.project }}.iam.gserviceaccount.com") filter using (is_restricted = false)'
    ) in macro
    assert "{%- if target.type == 'bigquery' -%}" in macro


def test_named_query_sql_uses_parameters_never_literals():
    p = policy()
    for purpose, qs in p.queries.items():
        for q in qs.values():
            for dialect, prefix in (("bigquery", "@"), ("duckdb", "$")):
                sql = sqlgen.query_sql(p, purpose, q, dialect)
                for name in q.all_params:
                    assert prefix + name in sql
                if q.paged_by:
                    assert f"limit {prefix}limit" in sql
                assert "'" not in sql.replace("''", "")


def test_purpose_views_mask_and_filter():
    p = policy()
    tm = sqlgen.purpose_view_sql(p, "team_management", "employees")
    assert "{{ pv_mask('base_salary', 'mask_nullify') }} as base_salary" in tm
    assert "where not is_restricted\n  and employment_status = 'active'" in tm
    er = sqlgen.purpose_view_sql(p, "employee_relations", "employees")
    assert "{{ pv_mask('birth_date', 'mask_date_year') }} as birth_date" in er
    assert "{{ pv_mask('leave_reason', 'mask_nullify') }} as leave_reason" in er
    assert "where" not in er.split("from")[-1]  # includes restricted and terminated
    wa = sqlgen.purpose_view_sql(p, "workforce_analytics", "employees")
    assert "where not is_restricted" in wa and "employment_status = 'active'" not in wa
