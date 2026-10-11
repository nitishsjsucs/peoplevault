"""Compiles policy/policy.yaml into every generated, committed artifact.

`compile_all()` returns {repo-relative path: file content}. `pv policy compile` writes them, and
`pv policy check` compiles in memory and fails on any difference (CI drift check).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from peoplevault import config
from peoplevault.policy.model import CATEGORIES, PERSONAS, UNTAGGED_CLASSES, Policy, load_policy

COMPILED_JSON = "policy/compiled/policy.json"


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def policy_source_hash(policy_yaml_text: str) -> str:
    return hashlib.sha256(policy_yaml_text.encode()).hexdigest()


def _query_entry(policy: Policy, purpose: str, name: str) -> dict:
    q = policy.queries[purpose][name]  # type: ignore[index]
    view = policy.purpose_views[purpose][q.view_name]  # type: ignore[index]
    params = q.all_params
    if q.paged_by:
        params = {**params, "cursor": "string", "limit": "int"}
    return {
        "id": f"{purpose}.{name}",
        "purpose": purpose,
        "name": name,
        "kind": "function" if q.function else "view",
        "object": q.function.name if q.function else q.view_name,
        "view": q.view_name,
        "viewSource": view.source,
        "params": params,
        "filters": [f.model_dump(exclude_none=True) for f in q.filters],
        "pagedBy": q.paged_by,
        "limit": q.limit,
        "orderBy": q.order_by or ([q.paged_by] if q.paged_by else None),
        "columns": [
            {"name": col, "class": policy.column_class[col], "visibility": policy.visibility_of(purpose, col)}
            for col in q.columns
        ],
    }


def compiled_policy(policy: Policy, source_hash: str) -> dict:
    personas = {}
    for name in PERSONAS:
        p = policy.personas[name]  # type: ignore[index]
        personas[name] = {"label": p.label, "purposes": list(p.grants), "grants": {k: list(v) for k, v in p.grants.items()}}
    purposes = {}
    for name, p in policy.purposes.items():
        purposes[name] = {
            "rowScope": p.row_scope,
            "restrictedPopulation": p.restricted_population,
            "terminated": p.terminated,
            "ref": p.ref,
            "refPrefix": policy.pseudonyms.kinds[p.ref],
            "bqIdentity": p.bq_identity,
            "dataset": policy.purpose_dataset(name),
        }
    queries = {}
    for purpose, qs in policy.queries.items():
        for name in qs:
            entry = _query_entry(policy, purpose, name)
            queries[entry["id"]] = entry
    assets = []
    for a in policy.assets:
        refs: list[str] = []
        for part in a.parts:
            refs.extend(c for c in part.reference_columns if c not in refs)
        assets.append({
            "id": a.id,
            "category": a.category,
            "store": a.store,
            "location": a.location,
            "executor": a.executor,
            "rowLevel": a.row_level,
            "erase": a.erase,
            "subjectColumn": a.subject_column,
            "referenceColumns": refs,
            "parts": [
                {
                    "name": part.name,
                    "location": part.location,
                    "format": part.format,
                    "referenceColumns": list(part.reference_columns),
                    "retention": part.retention.model_dump(exclude_none=True) if part.retention else None,
                }
                for part in a.parts
            ],
        })
    return {
        "version": policy.version,
        "policyHash": source_hash,
        "personas": personas,
        "systemRoles": {k: {"actions": list(v.actions)} for k, v in policy.system_roles.items()},
        "purposes": purposes,
        "dataClasses": {"tagged": list(policy.data_classes.tagged), "untagged": list(policy.data_classes.untagged)},
        "columnClass": dict(sorted(policy.column_class.items())),
        "visibility": {p: dict(row) for p, row in policy.visibility.items()},
        "untaggedVisibility": {cls: "allow" for cls in UNTAGGED_CLASSES},
        "queries": queries,
        "categories": list(CATEGORIES),
        "assets": assets,
        "retention": policy.retention.model_dump(),
        "verification": {
            "matchFullName": policy.verification.match_full_name,
            "tokens": list(policy.verification.tokens),
            "exactColumns": list(policy.verification.exact_columns),
            "d1InternalPrefixes": list(policy.verification.d1_internal_prefixes),
            "d1InternalTables": list(policy.verification.d1_internal_tables),
            "d1StageExclusions": {k: list(v) for k, v in policy.verification.d1_stage_exclusions.items()},
        },
        "pseudonyms": {
            "salt": policy.pseudonyms.salt,
            "infoPrefix": policy.pseudonyms.info_prefix,
            "messagePrefix": policy.pseudonyms.message_prefix,
            "length": policy.pseudonyms.length,
            "kinds": dict(policy.pseudonyms.kinds),
        },
        "datasets": {
            "data": list(policy.datasets.data),
            "maxTimeTravelHours": policy.datasets.max_time_travel_hours,
            "failSafeDays": policy.datasets.fail_safe_days,
            "authorizedSources": list(policy.datasets.authorized_sources),
        },
    }


def compile_all(policy_path: Path | None = None) -> dict[str, str]:
    path = policy_path or config.POLICY_YAML
    text = path.read_text()
    policy = load_policy(path)
    outputs: dict[str, str] = {
        COMPILED_JSON: json.dumps(compiled_policy(policy, policy_source_hash(text)), indent=2, ensure_ascii=False) + "\n",
    }
    for extra in _generators():
        outputs.update(extra(policy))
    return dict(sorted(outputs.items()))


def _generators():
    """Additional generators (dbt purpose models, routines, BigQuery infrastructure) register here."""
    gens = []
    try:
        from peoplevault.policy import sqlgen

        gens.append(sqlgen.generate)
    except ImportError:
        pass
    try:
        from peoplevault.policy import bqinfra

        gens.append(bqinfra.generate)
    except ImportError:
        pass
    return gens


def write_all(root: Path | None = None) -> list[str]:
    root = root or config.REPO_ROOT
    written = []
    for rel, content in compile_all().items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or target.read_text() != content:
            target.write_text(content)
            written.append(rel)
    return written


def generated_dirs() -> list[str]:
    """Directories that hold only generated files (stale files there are drift too)."""
    return ["pipelines/dbt/models/purpose", "infra/bigquery"]


def check(root: Path | None = None) -> list[str]:
    """Returns a list of drift problems (empty when committed files match the policy)."""
    root = root or config.REPO_ROOT
    expected = compile_all()
    problems = []
    for rel, content in expected.items():
        target = root / rel
        if not target.exists():
            problems.append(f"missing: {rel}")
        elif target.read_text() != content:
            problems.append(f"differs: {rel}")
    for d in generated_dirs():
        base = root / d
        if not base.exists():
            continue
        for f in sorted(base.rglob("*")):
            if f.is_file():
                rel = f.relative_to(root).as_posix()
                if rel not in expected and not rel.startswith("infra/bigquery/migrations/"):
                    problems.append(f"stale generated file: {rel}")
    return problems
