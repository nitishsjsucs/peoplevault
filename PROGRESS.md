# Build progress

Tracks the build against the commit plan in SPEC.md section 26. Updated in every commit.

## Position

Commit 3 of 25 (P0) done: `chore: scaffold Worker toolchain`.

## Done

| # | Commit | Notes |
|---|---|---|
| 1 | `docs: add design spec` | SPEC.md revision 2 |
| 2 | `docs: add README, context glossary and ADRs` | README (status: under construction), CONTEXT.md, ADR 0001 to 0006, docs/PRODUCTION.md (section 23), LICENSE, .gitignore, .nvmrc |
| 3 | `chore: scaffold Worker toolchain` | exact npm pins, tsconfigs (TypeScript 7.0.2), wrangler.jsonc (`peoplevault-local`, `secrets.required`, invocation logs off), env-extra.d.ts, generated worker-configuration.d.ts, vitest projects `worker` and `node`, config validation (env.ts), `/api/health` with tests; Workflow classes are placeholders that throw until commits 16 and 20 |

## Next

4. `chore: scaffold uv project and dbt skeleton`

## Check status

At commit 3: `npm run typecheck` passes; `npm run types:check` passes; `npm test` 3 passed, 0 failed (worker project). `npm run test:py` arrives with commit 4.

## Deviations from SPEC.md

None so far.
