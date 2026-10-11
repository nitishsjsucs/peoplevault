# Build progress

Tracks the build against the commit plan in SPEC.md section 26. Updated in every commit.

## Position

Commit 7 of 25 (P0) done: `feat(synth): deterministic generator with exact and golden counts`.

## Done

| # | Commit | Notes |
|---|---|---|
| 1 | `docs: add design spec` | SPEC.md revision 2 |
| 2 | `docs: add README, context glossary and ADRs` | README (status: under construction), CONTEXT.md, ADR 0001 to 0006, docs/PRODUCTION.md (section 23), LICENSE, .gitignore, .nvmrc |
| 3 | `chore: scaffold Worker toolchain` | exact npm pins, tsconfigs (TypeScript 7.0.2), wrangler.jsonc (`peoplevault-local`, `secrets.required`, invocation logs off), env-extra.d.ts, generated worker-configuration.d.ts, vitest projects `worker` and `node`, config validation (env.ts), `/api/health` with tests; Workflow classes are placeholders that throw until commits 16 and 20 |
| 4 | `chore: scaffold uv project and dbt skeleton` | pyproject.toml (exact pins, Python 3.12), committed uv.lock (129 packages), `pv` CLI with `pv dbt`, config.py (paths, `.dev.vars` and `wrangler.jsonc` readers), redacting logger, dbt project and profiles (`local` DuckDB, `bigquery` impersonating pv-executor, `bigquery_actions` (P1), `bigquery_ci` parse only), policy tag vars, `dbtrun.py` refusing `--full-refresh` on BigQuery; pytest smoke, redaction, dbt runner and dbt parse tests |
| 5 | `feat(policy): policy file, model and compiler with drift check` | policy/policy.yaml (4 personas, 5 purposes, 9 classes, 5x6 matrix, purpose views, named queries with structured filters, 13 assets in 6 categories, retention, verification, pseudonym parameters); pydantic model with fail-closed validation; `pv policy compile` and `pv policy check`; policy/compiled/policy.json; TS types, compiled view and registry; pytest and vitest registry tests |
| 6 | `feat(pseudo): HKDF and HMAC pseudonyms in TypeScript and Python` | `src/worker/pseudo/hmac.ts` (WebCrypto), `peoplevault/pseudo.py` (stdlib RFC 5869), `policy/test-vectors/pseudonyms.json` (12 vectors + 2 RFC 5869 vectors), both test suites assert the same vectors plus determinism, kind separation, prefix and length, no raw id substring, no collisions over 1,200 ids |
| 7 | `feat(synth): deterministic generator with exact and golden counts` | `pv synth`: 1,200 employees (1,000 active, 72 + 128 terminated), 12 org units, 120 managers, 24 restricted, 132 + 1 opaque principals, 2 matters with 6 held subjects, 60/40/30 attribute changes, 41 export objects, 93-month history in 8 yearly files, D1 seed SQL, truth (subjects, cohorts, 420-entry KV warm-up plan); suffix-free first names and prefix-free last names; golden `data/expected_counts.json` (retention: 8 objects past retention, 3 deleted and 5 minimized for holds, 3 extracts, 70 + 2 held full, 10 + 2 held ci); boundary-aware token matchers (`verify/tokens.py`); tests for counts, determinism, golden counts, retention boundary, token collisions and identifier-free principals |

## Next

8. `feat(d1): control-plane migrations and seed`

## Check status

At commit 7: `npm run typecheck` passes; `npm run types:check` passes; `npm test` 26 passed, 0 failed; `npm run test:py` 93 passed, 0 failed; `ruff check pipelines` clean; `pv policy check` clean.

## Deviations from SPEC.md

- Policy action `read_legal_holds` added for `GET /api/v1/privacy/legal-holds` (the spec's Action list had no read action for holds; it is granted to `privacy_officer` under `legal_hold_management` only).
- `AssetDef.parts` is a list of part objects (name, location, format, reference columns, retention) instead of plain strings, so per-part retention and reference columns live in the policy; `referenceColumns` is kept at asset level as the union.
- The HRIS weekly export is a full "all workers" snapshot (all 1,200 employees with their status in each of the 13 objects), so terminated subjects have source-export rows to erase. Retention-relevant dates of the held subjects are chosen so that past-retention objects split into deletions and minimizations (golden: 3 deleted, 5 minimized).
- Named queries carry structured filters (`eq`, `in_array`, `prefix_any_ci`) instead of SQL fragments, so the compiler emits each dialect itself.
