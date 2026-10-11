"""Pydantic model of policy/policy.yaml with cross-field validation (fail closed on any inconsistency)."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

from peoplevault import config

Persona = Literal["hr_partner", "manager", "people_analyst", "privacy_officer"]
PurposeName = Literal["employee_relations", "team_management", "workforce_analytics", "privacy_compliance", "legal_hold_management"]
Visibility = Literal["allow", "deny", "mask_nullify", "mask_date_year"]
AssetCategory = Literal["source_exports", "warehouse_tables", "historical_snapshots", "identity_mappings", "derived_datasets", "application_caches"]

PERSONAS: tuple[str, ...] = ("hr_partner", "manager", "people_analyst", "privacy_officer")
PURPOSES: tuple[str, ...] = ("employee_relations", "team_management", "workforce_analytics", "privacy_compliance", "legal_hold_management")
TAGGED_CLASSES: tuple[str, ...] = ("direct_identifier", "date_of_birth", "compensation", "performance", "health_leave", "protected_attribute")
UNTAGGED_CLASSES: tuple[str, ...] = ("job", "coarsened", "pseudonym")
CATEGORIES: tuple[str, ...] = ("source_exports", "warehouse_tables", "historical_snapshots", "identity_mappings", "derived_datasets", "application_caches")
HUMAN_ACTIONS: tuple[str, ...] = (
    "list_employees", "read_profile", "read_dataset", "create_extract", "identity_lookup",
    "create_deletion_request", "read_deletion_request", "place_legal_hold", "release_legal_hold", "read_legal_holds",
    "read_assets", "read_report", "read_audit", "run_retention",
)
SYSTEM_ACTIONS: tuple[str, ...] = ("executor_claim", "executor_complete", "executor_suppression", "executor_audit_export")
PROFILE_BASE_SOURCES = ("profile_base", "attrition_features", "headcount_monthly")
PARAM_TYPES = ("string", "string_array", "date")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class PersonaDef(Strict):
    label: str
    grants: dict[PurposeName, list[str]]


class SystemRoleDef(Strict):
    actions: list[str]


class PurposeDef(Strict):
    row_scope: Literal["org_units", "direct_reports", "all", "identity_lookup"]
    restricted_population: Literal["include", "exclude"]
    terminated: Literal["include", "exclude"]
    ref: Literal["employee_ref", "analytics_id"]
    bq_identity: str


class DataClasses(Strict):
    tagged: list[str]
    untagged: list[str]


class PurposeView(Strict):
    source: Literal["profile_base", "attrition_features", "headcount_monthly"]
    columns: list[str]


class FunctionDef(Strict):
    name: str
    view: str
    params: dict[str, Literal["string", "string_array", "date"]]


class FilterDef(Strict):
    op: Literal["eq", "in_array", "prefix_any_ci"]
    param: str
    column: str | None = None
    columns: list[str] | None = None


class QueryDef(Strict):
    function: FunctionDef | None = None
    view: str | None = None
    params: dict[str, Literal["string", "string_array", "date"]] = Field(default_factory=dict)
    filters: list[FilterDef] = Field(default_factory=list)
    paged_by: str | None = None
    limit: int | None = None
    order_by: list[str] | None = None
    columns: list[str]

    @property
    def view_name(self) -> str:
        return self.function.view if self.function else str(self.view)

    @property
    def all_params(self) -> dict[str, str]:
        return dict(self.function.params) if self.function else dict(self.params)


class Datasets(Strict):
    data: list[str]
    max_time_travel_hours: int
    fail_safe_days: int
    authorized_sources: list[str]


class Retention(Strict):
    days: int | None = None
    months: int | None = None
    ttl_seconds: int | None = None
    basis: Literal["object_date", "period_end", "month_end", "cycle_end", "export_date", "month", "month_metadata", "native"]


class AssetPart(Strict):
    name: str
    location: str | None = None
    format: Literal["jsonl", "csv"] | None = None
    reference_columns: list[str]
    retention: Retention | None = None


class AssetDef(Strict):
    id: str
    category: AssetCategory
    store: Literal["r2", "kv", "d1", "warehouse", "iceberg"]
    location: str
    executor: Literal["worker", "python"]
    row_level: bool
    erase: Literal["rewrite_objects", "delete_keys", "delete_rows", "dml_delete", "iceberg_delete", "dbt_rebuild"]
    subject_column: str | None
    parts: list[AssetPart]


class RetentionPolicy(Strict):
    terminated_subject_years: int
    kv_ttl_seconds: int


class Verification(Strict):
    match_full_name: bool
    tokens: list[str]
    exact_columns: list[str]
    d1_internal_prefixes: list[str]
    d1_internal_tables: list[str]
    d1_stage_exclusions: dict[str, list[str]]


class Pseudonyms(Strict):
    salt: str
    info_prefix: str
    message_prefix: str
    length: int
    kinds: dict[str, str]


class Policy(Strict):
    version: int
    personas: dict[Persona, PersonaDef]
    system_roles: dict[str, SystemRoleDef]
    purposes: dict[PurposeName, PurposeDef]
    data_classes: DataClasses
    columns: dict[str, list[str]]
    visibility: dict[PurposeName, dict[str, Visibility]]
    purpose_views: dict[PurposeName, dict[str, PurposeView]]
    queries: dict[PurposeName, dict[str, QueryDef]]
    datasets: Datasets
    assets: list[AssetDef]
    retention: RetentionPolicy
    verification: Verification
    pseudonyms: Pseudonyms

    # ---- derived lookups -------------------------------------------------------------------------------
    @property
    def column_class(self) -> dict[str, str]:
        return {col: cls for cls, cols in self.columns.items() for col in cols}

    def visibility_of(self, purpose: str, column: str) -> Visibility:
        cls = self.column_class[column]
        if cls in UNTAGGED_CLASSES:
            return "allow"
        return self.visibility[purpose][cls]  # type: ignore[index]

    def purpose_dataset(self, purpose: str) -> str:
        return f"pv_purpose_{purpose}"

    @model_validator(mode="after")
    def _validate(self) -> Policy:
        errors: list[str] = []
        if tuple(self.personas) != PERSONAS:
            errors.append(f"personas must be exactly {PERSONAS}")
        if tuple(self.purposes) != PURPOSES:
            errors.append(f"purposes must be exactly {PURPOSES}")
        if tuple(self.data_classes.tagged) != TAGGED_CLASSES or tuple(self.data_classes.untagged) != UNTAGGED_CLASSES:
            errors.append("data classes must be the 6 tagged and 3 untagged classes")
        if set(self.columns) != set(TAGGED_CLASSES) | set(UNTAGGED_CLASSES):
            errors.append("columns must be grouped by exactly the 9 data classes")
        seen: dict[str, str] = {}
        for cls, cols in self.columns.items():
            for col in cols:
                if col in seen:
                    errors.append(f"column {col} classified twice ({seen[col]}, {cls})")
                seen[col] = cls
        for persona, pdef in self.personas.items():
            for purpose, actions in pdef.grants.items():
                for action in actions:
                    if action not in HUMAN_ACTIONS:
                        errors.append(f"{persona}/{purpose}: unknown action {action}")
        for role in self.system_roles.values():
            for action in role.actions:
                if action not in SYSTEM_ACTIONS:
                    errors.append(f"system role action {action} unknown")
        for purpose in PURPOSES:
            row = self.visibility.get(purpose)  # type: ignore[call-overload]
            if row is None or set(row) != set(TAGGED_CLASSES):
                errors.append(f"visibility row for {purpose} must cover the 6 tagged classes")
        for purpose, views in self.purpose_views.items():
            for vname, view in views.items():
                for col in view.columns:
                    if col not in seen:
                        errors.append(f"view {purpose}.{vname}: unclassified column {col}")
                    elif seen[col] in TAGGED_CLASSES and self.visibility[purpose][seen[col]] == "deny":
                        errors.append(f"view {purpose}.{vname} selects deny column {col}")
        for purpose, queries in self.queries.items():
            views = self.purpose_views.get(purpose, {})
            for qname, q in queries.items():
                qid = f"{purpose}.{qname}"
                if (q.function is None) == (q.view is None):
                    errors.append(f"{qid}: exactly one of function or view")
                    continue
                view = views.get(q.view_name)
                if view is None:
                    errors.append(f"{qid}: unknown view {q.view_name}")
                    continue
                for col in q.columns:
                    if col not in view.columns:
                        errors.append(f"{qid}: column {col} not in view {q.view_name}")
                params = q.all_params
                for f in q.filters:
                    if f.param not in params:
                        errors.append(f"{qid}: filter param {f.param} not declared")
                    cols = f.columns if f.op == "prefix_any_ci" else [f.column]
                    for col in cols or []:
                        if col not in view.columns:
                            errors.append(f"{qid}: filter column {col} not in view")
                if q.paged_by and q.paged_by not in view.columns:
                    errors.append(f"{qid}: paged_by column not in view")
        ids = [a.id for a in self.assets]
        if len(set(ids)) != len(ids):
            errors.append("duplicate asset ids")
        for a in self.assets:
            if not a.parts:
                errors.append(f"asset {a.id} has no parts")
            for part in a.parts:
                for col in part.reference_columns:
                    if col not in seen:
                        errors.append(f"asset {a.id}: unclassified reference column {col}")
            if a.subject_column is not None and a.subject_column not in seen:
                errors.append(f"asset {a.id}: unclassified subject column")
        if {a.category for a in self.assets} != set(CATEGORIES):
            errors.append("every one of the 6 categories needs at least one asset")
        if set(self.pseudonyms.kinds) != {"warehouse_key", "employee_ref", "analytics_id", "subject_ref"}:
            errors.append("pseudonym kinds must be warehouse_key, employee_ref, analytics_id, subject_ref")
        if errors:
            raise ValueError("; ".join(errors))
        return self


def load_policy(path: Path | None = None) -> Policy:
    return Policy.model_validate(yaml.safe_load((path or config.POLICY_YAML).read_text()))


@lru_cache(maxsize=1)
def policy() -> Policy:
    """Cached policy from the repository's policy/policy.yaml."""
    return load_policy()
