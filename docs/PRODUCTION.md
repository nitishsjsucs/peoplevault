# Production setup

This is section 23 of SPEC.md, kept current as the code lands. Production runs on the Cloudflare **Workers Free** plan (SPEC.md section 30, ADR 0007); nothing here needs Workers Paid. The rest of the revision 3 changes (shared Google Cloud project `master-magnet-444903-u4`, `peoplevault` names, the pulled audit copy, the daily admission cap) land in the migration commits listed in PROGRESS.md, and this file follows them. Steps marked (P1) are below the core cut line and are not needed for v1. Workers AI and AI Gateway need no setup for v1: no resume claim depends on them, and they are P1.

Everything a script can do is in `npm run setup:prod`. This section lists, in order, what only Nitish can do (accounts, payment, consent screens, logins, token creation, naming choices) and then the commands to run. The last column says where each fact was checked on 2026-10-10; "(unverified)" marks what could not be confirmed against an official page or the wrangler 4.149.0 source. `docs/PRODUCTION.md` carries this section verbatim and is kept current.

## Accounts, plans, console steps and tokens

| # | Provider | Step | Where | Cost | Needed for | Checked against |
|---|---|---|---|---|---|---|
| 1 | Cloudflare | Create or sign in to an account; turn on two-factor authentication | https://dash.cloudflare.com/sign-up | free | everything on Cloudflare | |
| 2 | Cloudflare | Stay on Workers Free: do not upgrade to Workers Paid and do not create Basin Pipelines resources | none | $0 | the whole design (SPEC.md section 30) | Nitish's decision on 2026-10-10; Pipelines creation returned "This feature requires a Workers Paid plan [code: 1021]" |
| 3 | Cloudflare | Register a workers.dev subdomain (pick the name; the Worker becomes `peoplevault.<name>.workers.dev`). Either in the dashboard, or put `PV_WORKERS_SUBDOMAIN=<name>` in `.secrets/prod.env` and let `setup:prod` register it after asking | `https://dash.cloudflare.com/<ACCOUNT_ID>/workers/onboarding` | free | wrangler refuses to deploy Workflows without one ("You need to register a workers.dev subdomain before deploying Workflows"); doctor's edge check URL | wrangler 4.149.0 `cli.js` |
| 4 | Cloudflare | Open R2 Object Storage once and activate it if the dashboard asks (unverified whether a separate activation is still required) | dashboard, R2 Object Storage | free tier covers this project | R2 buckets and Basin Catalog | |
| 5 | Cloudflare | Zero Trust onboarding: choose a team name (for example `nitish-pv`, giving `nitish-pv.cloudflareaccess.com`), choose the Free plan, enter payment details (the setup docs say Free is not charged) | dashboard, Zero Trust | $0 (Free plan seat limit of 50 reported by third parties, unverified) | Cloudflare Access in front of the Worker | Cloudflare One setup docs |
| 6 | Cloudflare | Add One-time PIN as a login method | Zero Trust, Settings, Authentication, Login methods, Add new (path unverified) | free | signing in by email as each persona | Access docs |
| 7 | Cloudflare | Create an account API token named in `.secrets/prod.env` as `PV_CF_API_TOKEN` (Custom token) with exactly: Access: Apps and Policies Edit; Access: Service Tokens Edit; Access: Organizations, Identity Providers, and Groups Read; Workers Scripts Read. No Billing Read: the doctor has no plan check on Workers Free. Do not call it `CLOUDFLARE_API_TOKEN`: wrangler would use that variable instead of the OAuth login, and this token cannot create D1, R2 or Queues | My Profile, API Tokens, Create Token | free | Access app, policies and service tokens; doctor's subdomain check | API token permissions reference (names) |
| 8 | Cloudflare | Create an R2 API token with Admin Read & Write; save it as `PV_R2_CATALOG_TOKEN` | R2 Object Storage, Manage API tokens, Create API token | free | pyiceberg REST access to the Basin Catalog Iceberg archive | Basin Catalog guide |
| 9 | Cloudflare | `npx wrangler login` in the repo and approve the OAuth consent screen | terminal, browser | free | every wrangler command; doctor's R2, KV, Queues and Basin listings (wrangler OAuth token) | `wrangler whoami --json` |
| 10 | Google | Google account; create a project (for example `peoplevault-<suffix>`) dedicated to PeopleVault | https://console.cloud.google.com | free | BigQuery; the executor's project-level read grants assume a dedicated project | |
| 11 | Google | Create or link a billing account to the project | Billing, Link a billing account, or `gcloud billing projects link` | card required; usage expected under $1/month | DML deletes (the BigQuery sandbox has no DML and expires tables after 60 days) | BigQuery sandbox docs |
| 12 | Google | Budget alert at $5 | Billing, Budgets and alerts | free | cost guard | |
| 13 | Google | Install the Google Cloud CLI and log in, including the ADC quota project (commands in 23.2) | terminal, browser consent | free | `pv setup gcp`; impersonating `pv-executor`; Data Catalog and data policy calls with user ADC | `brew info --cask gcloud-cli`; Google auth docs |
| 14 | Google | Only if `pv setup gcp` reports that organization policy `iam.disableServiceAccountKeyCreation` blocks the `pv-gateway` key: use a project outside that organization, or ask for an exception for this project | IAM, Organization policies | free | the Worker's BigQuery credential | |
| 15 | Choice | Persona sign-in emails, for example Gmail plus-addresses: `PV_ACCESS_ALLOWED_EMAILS=<you>+hr@gmail.com,<you>+mgr@gmail.com,<you>+analyst@gmail.com,<you>+privacy@gmail.com` and `PV_ACCESS_PERSONA_EMAILS=<you>+hr@gmail.com=hrbp-01,<you>+mgr@gmail.com=mgr-001,<you>+analyst@gmail.com=analyst-01,<you>+privacy@gmail.com=privacy-01` | `.secrets/prod.env` | free | signing in as each of the four personas | |
| 16 | Choice | After the first `setup:prod`, copy `PV_PSEUDONYM_MASTER_KEY` from `.secrets/worker-secrets.env` into a password manager | password manager | free | pseudonym stability; losing it orphans every pseudonym | |
| 17 | GitHub | Push the repository (`git push origin main`; you publish it), then answer yes when `npm run setup:prod -- --only github` asks to write the executor secrets and `PV_PROD_ENABLED=true`. Optional but recommended: without it, deletions wait for you to run `pv executor run --target prod --drain` and fail after 24 hours | terminal | free (Actions minutes are free for public repositories) | the hourly production executor (`executor.yml`) and the daily residual check | GitHub docs on disabling and enabling workflows |
| 18 | Choice | After the production eval result is committed, turn the retention cron on: `npm run setup:prod -- --only worker --retention-cron on` (re-renders `RETENTION_CRON=on` and redeploys). The 70-subject retention backlog then drains at 8 a day. Until then the daily cron only re-admits deferred and orphaned requests | terminal | free | automated retention in production within the daily admission cap | SPEC.md section 30.3.4 |

Not needed: Workers Paid, Basin Pipelines, and any Workers AI or AI Gateway setup for v1 (P1, no resume claim depends on them). Basin Pipelines is Workers Paid only, so `setup:prod` creates no stream, sink or pipeline; the audit copy `governance.audit_events` is pulled by `pv audit export` instead (SPEC.md section 30.3.3).

### The scheduled executor (`executor.yml`, P1)

`.github/workflows/executor.yml` runs every hour at minute 7 (and on demand from the Actions tab) once the repository variable `PV_PROD_ENABLED` is `true`. It drains the executor tasks that the Workflows queue in D1 (warehouse DML, the `headcount_monthly` rebuild, Iceberg deletes), and at 04 UTC it also runs the token-free residual check. A concurrency group keeps two runs from overlapping. It reads these repository secrets, all written by `npm run setup:prod -- --only github` with the values travelling on `gh`'s standard input, never in a command line:

| Secret | Value |
|---|---|
| `PV_BASE_URL` | `https://peoplevault.<subdomain>.workers.dev` |
| `PV_CF_ACCESS_CLIENT_ID`, `PV_CF_ACCESS_CLIENT_SECRET` | the `pv-executor` Access service token |
| `PV_GCP_PROJECT` | the Google Cloud project id |
| `PV_GCP_EXECUTOR_KEY` | a `pv-executor` key created by `pv setup actions-key` and piped straight into the secret; it is never written to disk, so no `pv-executor` key exists on your machine (rotate with `uv run --project pipelines pv setup actions-key --repo <owner>/<name> --rotate`) |
| `PV_R2_CATALOG_TOKEN`, `PV_CATALOG_URI`, `PV_CATALOG_WAREHOUSE` | Basin Catalog access |
| `PV_POLICY_TAGS_JSON` | the policy tag resource names `pv setup gcp` recorded |

Setup keeps a SHA-256 of each uploaded value in `.secrets/prod-resources.json`, so a rotated value (for example a rotated service token) is uploaded again on the next run and nothing else is rewritten. The pseudonym master key is not a GitHub secret: nothing in the job needs it.

The repository is public, and so are its Actions logs: the job sets `PV_PUBLIC_LOGS=true`, which prints an uncaught exception as its type and redacted message only (no traceback), sends warnings through the redacting logger and turns dbt's own console output off; the job prints counts, never rows. The key file lives in the runner's temp directory and is deleted in an `always()` step.

GitHub disables scheduled workflows in a public repository after 60 days without repository activity. `npm run doctor -- --prod` reads the workflow's state and the age of its last successful run (more than 26 hours is `[missing]`) and prints `gh workflow enable executor.yml --repo <owner>/<name>` when it has been disabled.

## Local CLIs and logins

State on this Mac when this section was last updated (`npm run doctor -- --prod`, 2026-10-10 evening): wrangler is logged in (one account), the Google Cloud CLI 588.0.0 is installed with an active account and application default credentials, and gh is logged in. Still to do: the project id, the quota project and billing (below), and the tokens and choices in the table above.

```bash
npx wrangler login                                  # browser OAuth
npx wrangler whoami --json                          # must print "loggedIn": true
brew install --cask gcloud-cli                      # Google Cloud CLI cask (587.0.0 on 2026-10-10); includes bq
gcloud init                                         # choose account and project
gcloud auth login
gcloud auth application-default login               # user ADC; dbt and the executor impersonate pv-executor on top of it
gcloud config set project <PROJECT_ID>
gcloud auth application-default set-quota-project <PROJECT_ID>   # Data Catalog and data policy calls need a quota project
gcloud billing accounts list
gcloud billing projects link <PROJECT_ID> --billing-account=<BILLING_ACCOUNT_ID>
gh auth status                                      # already logged in on this Mac
```

## Environment file

`.secrets/prod.env` (gitignored, mode 600), read by every production script:

```
CLOUDFLARE_ACCOUNT_ID=...
PV_CF_API_TOKEN=...
PV_R2_CATALOG_TOKEN=...
PV_GCP_PROJECT=...
PV_ACCESS_ALLOWED_EMAILS=...
PV_ACCESS_PERSONA_EMAILS=...
PV_WORKERS_SUBDOMAIN=...           # optional; only if setup should register the subdomain
# written by setup:prod, never edited by hand:
PV_BASE_URL=https://peoplevault.<subdomain>.workers.dev
PV_CF_ACCESS_CLIENT_ID_EXECUTOR=... / PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR=...
PV_CF_ACCESS_CLIENT_ID_HR=... (and MANAGER, ANALYST, PRIVACY)
PV_CATALOG_URI=... / PV_CATALOG_WAREHOUSE=...
```

A service token's client secret is shown once by Cloudflare. If `.secrets/prod.env` loses one, `setup:prod` rotates that token and records the new secret.

Also written by setup and gitignored: `.secrets/worker-secrets.env` (`PV_PSEUDONYM_MASTER_KEY`, `GCP_GATEWAY_SA_KEY`; uploaded by `npm run deploy`), `.secrets/prod-resources.json` (resource ids, policy tag resource names), `infra/cloudflare/wrangler.production.jsonc`. No `pv-executor` key exists on the laptop.

## Costs

| Item | Cost at this project's scale | Source |
|---|---|---|
| Workers Free: Workers, Workflows, Queues, D1, KV, Workers Logs | $0; every daily allowance is per account and shared with three other repos, so this repo plans for at most 25% of each (SPEC.md section 30.4) | Workers, Workflows, Queues, D1 and KV pricing and limits pages (SPEC.md section 30.1) |
| R2 | free tier 10 GB-month, 1M Class A, 10M Class B per month; this project stores under 50 MB | R2 pricing page (verified) |
| Basin Catalog | 1M catalog operations per month included, then $9 per million; compaction left off; snapshot expiration has no separate charge | Basin pricing pages (verified) |
| Workers Logs | invocation logs disabled; only identifier-free console logs remain, kept 3 days on Free | Workers Logs docs |
| Zero Trust | Free plan, $0 | setup docs (payment details required, not charged) |
| BigQuery | 1 TiB of queries and 10 GiB storage free per month (allowance stated on the sandbox page); the full production eval scans a few GB because each referenced table bills at least 10 MB (minimum unverified this session) | BigQuery docs |
| Workers AI, AI Gateway (P1, not used in v1) | not needed | |
| Expected total | $0 per month on Cloudflare; well under $1 on Google Cloud | estimate |

## Commands after the logins

```bash
npm run doctor -- --prod                                       # lists exactly what is missing, with the fix for each line
npm run setup:prod -- --dry-run                                # optional: shows the exact plan, secrets masked
npm run setup:prod                                             # idempotent; re-run until doctor is green
npm run doctor -- --prod
# IAM grants take about 30 seconds and policy tag changes up to 30 minutes to propagate (column-level access control docs); wait before the next line
uv run --project pipelines pv authz warehouse --target bigquery --write-results --ceiling-probes
uv run --directory pipelines pytest -m bigquery                    # the live BigQuery suite (48 cases, 37 ceiling probes, controls, time travel)
uv run --project pipelines pv eval deletion --profile prod         # once, before any DSR; one canary DSR alone first, then the other 11 (12 of the day's 16 starts)
npm run authz:prod -- --allow-writes                               # the 100-case file through Access with the service tokens (after the eval: it creates a deletion request and a hold)
uv run --project pipelines pv executor run --target prod --drain   # P0: the production executor runs from this Mac (P1 executor.yml automates it)
# 48 hours later (BigQuery time travel window) and again after 1 day for Basin snapshot expiration
uv run --project pipelines pv residuals check --target prod
npm run readme:results
git add evals/results README.md && git commit -m "docs: production results"
npm run setup:prod -- --only worker --retention-cron on            # only after the production eval result is committed
# after you push: the hourly executor in GitHub Actions (asks before writing anything to GitHub)
npm run setup:prod -- --only github
npm run doctor -- --prod                                       # the GitHub lines turn ok after the first successful run
```

`pv eval deletion --profile prod` plants 5 residues of designed types (one per store) straight into R2, KV, D1, BigQuery and the Basin Catalog, warms the production caches through Access with the persona service tokens, submits 6 deletions, 1 held request and the 5 planted subjects as `privacy-01`, runs the production executor in-process until every request is terminal, runs the residual check, scans every production store with the independent oracle, removes the planted residues and writes `evals/results/deletion-prod-<date>.{json,md}`. It runs once per seeded project (its subjects are gone afterwards): it refuses to start when any data subject request exists, when a request already names one of its cohort subjects, or when fewer than 12 of the day's 16 deletion starts are left. It submits one deletion alone first (the canary) and stops if that one does not complete, so a Workers Free limit that only production enforces fails one request closed instead of twelve.

If a run leaves the probe dataset behind (for example after an interrupted ceiling-probe run), `uv run --project pipelines pv authz warehouse --target bigquery --cleanup` removes it and its grants.

## What the scripted paths are, and what has run

| Path | Command | State |
|---|---|---|
| Prerequisite report | `npm run doctor -- --prod` (Google lines from `pv doctor gcp --json`) | written; runs on this Mac today and reports everything as missing; tested with fakes and recorded responses |
| Cloudflare resources, Worker render, migrations, deploy | `npm run setup:prod` groups `cloudflare` and `worker`, `npm run deploy` | written, dry-run golden-tested, not yet executed |
| Google Cloud | `pv setup gcp [--dry-run]` | written, dry-run golden-tested with a fake client, not yet executed |
| Access application and service tokens | `npm run setup:prod -- --only access` | written, not yet executed. The `worker` destination takes the Worker's id from `GET /accounts/{id}/workers/workers`; the reference describes that field only as "the ID of the Cloudflare Worker", so the first run confirms it, and the doctor's edge check proves the result |
| Seeding | `npm run seed:prod` | written, not yet executed; refuses to run once any deletion request exists (re-uploading exports would resurrect erased data) |
| Warehouse authorization | `pv authz warehouse --target bigquery --ceiling-probes` | written, not yet executed |
| Executor, residual check, lake self-test | `pv executor run --target prod`, `pv residuals check --target prod`, `pv lake init --target prod` | written, not yet executed |
| Production deletion eval | `pv eval deletion --profile prod` | written, not yet executed; R2 objects are listed and read through `GET /accounts/{id}/r2/buckets/{bucket}/objects[/{key}]` with wrangler's OAuth token, and that endpoint's pagination fields are unverified |
| Authorization cases through Access (P1) | `npm run authz:prod [-- --allow-writes]` (`pv authz api --target prod`) | written, not yet executed. Rehearsed against the local stack with the full synthetic population (`npm run authz:api:local`). It runs every case it can with the four persona service tokens and the executor's, re-resolving subjects from the production population's ground truth (`data/generated-prod`, written by `seed:prod`), and reports the exact runnable count with a reason for each skipped case: forged, missing or unmapped tokens cannot pass Access, the fixture's other principals have no token, some selectors have no qualifying subject, and the deletion and hold cases need `--allow-writes` |
| Production warm-up (P1) | step 9 of `npm run seed:prod` (`pv warmup --target prod --with-extracts`) | written, not yet executed; creates the 6 analytics extracts as `analyst-01` and warms the cache entries whose principal has a service token (the others need an interactive sign-in) |
| Audit copy (P1) | removed from the production path: Basin Pipelines is Workers Paid only. Its replacement, `pv audit export` (an exactly-once pull into `governance.audit_events`), is migration commit M6 | not built yet |
| Scheduled executor (P1) | `.github/workflows/executor.yml`, `npm run setup:prod -- --only github`, `pv setup actions-key` | written, not yet executed (the repository has not been pushed); the workflow's structure, the secrets it reads and the doctor's schedule checks are tested |

## What the scripts cannot do

Account creation, payment details, Zero Trust onboarding, adding the One-time PIN login method, creating the two Cloudflare tokens, choosing the workers.dev subdomain name (registration itself can be scripted once the name is set), the OAuth consent screens of `wrangler login` and `gcloud auth`, linking billing, the budget alert, any organization policy exception, and accepting any terms of service. Everything else (every resource in sections 15 and 16, secrets, deploys, the Access application, service tokens, seeding, and in P1 GitHub secrets) is scripted and idempotent.
