# Build progress

Tracks the build against the commit plan in SPEC.md section 26. Updated in every commit.

## Position

Commit 4 of 25 (P0) done: `chore: scaffold uv project and dbt skeleton`.

## Done

| # | Commit | Notes |
|---|---|---|
| 1 | `docs: add design spec` | SPEC.md revision 2 |
| 2 | `docs: add README, context glossary and ADRs` | README (status: under construction), CONTEXT.md, ADR 0001 to 0006, docs/PRODUCTION.md (section 23), LICENSE, .gitignore, .nvmrc |
| 3 | `chore: scaffold Worker toolchain` | exact npm pins, tsconfigs (TypeScript 7.0.2), wrangler.jsonc (`peoplevault-local`, `secrets.required`, invocation logs off), env-extra.d.ts, generated worker-configuration.d.ts, vitest projects `worker` and `node`, config validation (env.ts), `/api/health` with tests; Workflow classes are placeholders that throw until commits 16 and 20 |
| 4 | `chore: scaffold uv project and dbt skeleton` | pyproject.toml (exact pins, Python 3.12), committed uv.lock (129 packages), `pv` CLI with `pv dbt`, config.py (paths, `.dev.vars` and `wrangler.jsonc` readers), redacting logger, dbt project and profiles (`local` DuckDB, `bigquery` impersonating pv-executor, `bigquery_actions` (P1), `bigquery_ci` parse only), policy tag vars, `dbtrun.py` refusing `--full-refresh` on BigQuery; pytest smoke, redaction, dbt runner and dbt parse tests |

## Next

5. `feat(policy): policy file, model and compiler with drift check`

## Check status

At commit 4: `npm run typecheck` passes; `npm run types:check` passes; `npm test` 3 passed, 0 failed; `npm run test:py` 18 passed, 0 failed; `ruff check pipelines` clean.

## Deviations from SPEC.md

None so far.
