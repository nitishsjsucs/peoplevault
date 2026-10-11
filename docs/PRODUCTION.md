# Production setup

This file is section 23 of SPEC.md (revision 3, 2026-10-10) verbatim, followed by two sections that track the code: the scheduled executor and the state of every scripted path. Production runs on the Cloudflare **Workers Free** plan in an account shared with three other repos, and BigQuery lives in the Google Cloud project `master-magnet-444903-u4`, also shared (SPEC.md section 30, ADR 0007). Nothing in this repository has run against Cloudflare or Google Cloud yet.

Revision 3 (2026-10-10). Everything a script can do is in `npm run setup:prod`. This section lists, in order, what only Nitish can do (accounts, payment, consent screens, logins, token creation, naming choices) and then the commands to run. Production stays on **Workers Free**, Google Cloud billing is enabled on the **shared project `master-magnet-444903-u4`**, and the "Done" column says what was already true on 2026-10-10, checked read-only where a command could check it (`wrangler whoami`, `wrangler r2 bucket list`, `d1 list --json`, `kv namespace list`, `queues list`, `workflows list` all empty; `gcloud config list`, `gcloud billing projects describe`, `gcloud services list --enabled`, `bq ls` empty, the ADC file). Nothing was created or changed by the architect; Nitish's operator runs the setup after the gate. `docs/PRODUCTION.md` carries this section verbatim and is kept current.

## Accounts, plans, console steps and tokens

| # | Provider | Step | Where or command | Cost | Needed for | Done on 2026-10-10 | Checked against |
|---|---|---|---|---|---|---|---|
| 1 | Cloudflare | Account `dc93c3bc8aa4f9e09a0d7e7354a80873`; keep two-factor authentication on | https://dash.cloudflare.com | free | everything on Cloudflare | yes (two-factor not checkable read-only) | `wrangler whoami` |
| 2 | Cloudflare | Stay on Workers Free: do not upgrade to Workers Paid and do not create Basin Pipelines resources | none | $0 | the whole design (section 30) | yes | Nitish's decision; Pipelines creation returned code 1021 |
| 3 | Cloudflare | workers.dev subdomain `nitish-ratakonda`, so the Worker is `https://peoplevault.nitish-ratakonda.workers.dev` | dashboard, Workers and Pages | free | deploying Workflows; the doctor's edge check | yes | brief |
| 4 | Cloudflare | R2 activated with a card on file (R2 and Basin Catalog need an R2 subscription, not a Workers plan) | dashboard, R2 | free tier | R2 buckets, Basin Catalog | yes (enabling Basin Catalog on a bucket works on Free) | Nitish's check |
| 5 | Cloudflare | Zero Trust team `old-truth-a7dc`, Free plan, team domain `https://old-truth-a7dc.cloudflareaccess.com` | dashboard, Zero Trust | $0 (50 seats per account; this repo uses 5) | Access | yes | brief |
| 6 | Cloudflare | Add One-time PIN as a login method | Zero Trust, Integrations, Identity providers, Add new identity provider, One-time PIN | free | signing in by email as each persona | in progress | One-time PIN docs |
| 7 | Cloudflare | Account API token `PV_CF_API_TOKEN` (Custom token): Access: Apps and Policies Edit; Access: Service Tokens Edit; Access: Organizations, Identity Providers, and Groups Read; Workers Scripts Read; AI Gateway Edit (the API reference calls it AI Gateway Write; setup creates the P1 gateway `peoplevault` and the doctor reads it); optionally Account Analytics Read (the doctor's CPU p99 line). No Billing Read any more. Never name it `CLOUDFLARE_API_TOKEN` (wrangler would use it instead of the OAuth login) | My Profile, API Tokens, Create Token | free | Access application, policies and service tokens; the AI Gateway; doctor | no | API token permissions reference (Account Analytics Read name unverified) |
| 8 | Cloudflare | R2 API token with Admin Read & Write, saved as `PV_R2_CATALOG_TOKEN` | R2, Manage API tokens, Create API token | free | pyiceberg REST access to `hr_history.employee_monthly` and `governance.audit_events`; snapshot expiration | no | Basin Catalog get-started and manage-catalogs pages |
| 9 | Cloudflare | `npx wrangler login` | terminal, browser | free | every wrangler command | yes (OAuth as `nitish.ratakonda@sjsu.edu`) | `wrangler whoami` |
| 10 | Google | Use the shared project `master-magnet-444903-u4` (no new project; four repos share it, so every name of this repo starts with `peoplevault` and every grant is dataset- or resource-scoped) | `gcloud config set project master-magnet-444903-u4` | free | BigQuery | yes (active gcloud project) | `gcloud config list` |
| 11 | Google | Enable billing on the project. It names billing account `01E865-CB9CA4-66E862` but reports `billingEnabled: false`, so check in the console that the billing account is open, then link it | https://console.cloud.google.com/billing/linkedaccount?project=master-magnet-444903-u4 or `gcloud billing projects link master-magnet-444903-u4 --billing-account=01E865-CB9CA4-66E862` | card required; expected $0 inside the free tier | DML deletes (the sandbox rejects INSERT, MERGE and DELETE and expires tables after 60 days) | no | `gcloud billing projects describe` |
| 12 | Google | Budget alert on that billing account, scoped to the project, at $1 with 50%, 90% and 100% thresholds | Billing, Budgets and alerts | free | cost guard (the free tier is shared by four repos) | no | not checkable read-only |
| 13 | Google | gcloud and bq installed and logged in as `nitishsancs@gmail.com`; application default credentials with quota project `master-magnet-444903-u4` | terminal | free | `pv setup gcp`; impersonation; Data Catalog and data policy calls | yes | `gcloud config list`; ADC `quota_project_id` |
| 14 | Google | APIs: `bigquery.googleapis.com` and `bigquerydatapolicy.googleapis.com` are on; `datacatalog`, `iam` and `iamcredentials` are enabled by `pv setup gcp` (no manual step) | scripted | free | policy tags; impersonation | partly | `gcloud services list --enabled` |
| 15 | Google | Only if `pv setup gcp` reports that organization policy `iam.disableServiceAccountKeyCreation` blocks the `peoplevault-gateway` key: ask for an exception | IAM, Organization policies | free | the Worker's BigQuery credential | n/a | |
| 16 | Choice | `.secrets/prod.env` values: `CLOUDFLARE_ACCOUNT_ID=dc93c3bc8aa4f9e09a0d7e7354a80873`, `PV_GCP_PROJECT=master-magnet-444903-u4`, `PV_ACCESS_ALLOWED_EMAILS=nitishsancs@gmail.com,nitishsancs+hr@gmail.com,nitishsancs+mgr@gmail.com,nitishsancs+analyst@gmail.com,nitishsancs+privacy@gmail.com`, `PV_ACCESS_PERSONA_EMAILS=nitishsancs+hr@gmail.com=hrbp-01,nitishsancs+mgr@gmail.com=mgr-001,nitishsancs+analyst@gmail.com=analyst-01,nitishsancs+privacy@gmail.com=privacy-01` | `.secrets/prod.env` (mode 600) | free | Access policies; persona sign-in (5 of 50 seats) | no | |
| 17 | Choice | After the first `setup:prod`, copy `PV_PSEUDONYM_MASTER_KEY` from `.secrets/worker-secrets.env` into a password manager | password manager | free | pseudonym stability; losing it orphans every pseudonym | no | |
| 18 | GitHub | `npm run setup:prod -- --only github` (asks before writing): the P1 `executor.yml` secrets; the job now also runs `pv audit export` | terminal | free (public repository) | hourly executor and the audit copy | `gh` login yes; secrets no | `gh auth status` |
| 19 | Choice | After the production eval result is committed, turn the retention cron on: `npm run setup:prod -- --only worker --retention-cron on` (the 70-subject backlog then drains at 8 a day) | terminal | free | automated retention in production | no | section 30.3.4 |

Not needed: Workers Paid, Basin Pipelines, a new Google Cloud project, any Workers Logs change, and any manual Workers AI or AI Gateway setup: Workers AI needs only the `ai` binding of the production template, and `setup:prod` creates the gateway `peoplevault` (1 of the account's 10, no stored logs, no cache, 10 requests a minute) with `PV_CF_API_TOKEN`.

## Local CLIs and logins (state on 2026-10-10)

```bash
npx wrangler whoami                                        # done: OAuth login, account dc93c3bc8aa4f9e09a0d7e7354a80873
gcloud config list                                         # done: nitishsancs@gmail.com, project master-magnet-444903-u4
gcloud auth application-default print-access-token         # done: ADC present, quota project master-magnet-444903-u4
gcloud billing projects describe master-magnet-444903-u4   # billingEnabled is false: step 11
gh auth status                                             # done
```

## Environment file

`.secrets/prod.env` (gitignored, mode 600), read by every production script:

```
CLOUDFLARE_ACCOUNT_ID=dc93c3bc8aa4f9e09a0d7e7354a80873
PV_CF_API_TOKEN=...
PV_R2_CATALOG_TOKEN=...
PV_GCP_PROJECT=master-magnet-444903-u4
PV_ACCESS_ALLOWED_EMAILS=...       # step 16
PV_ACCESS_PERSONA_EMAILS=...       # step 16
# written by setup:prod, never edited by hand:
PV_CF_ACCESS_CLIENT_ID_EXECUTOR=... / PV_CF_ACCESS_CLIENT_SECRET_EXECUTOR=...
PV_CF_ACCESS_CLIENT_ID_HR=... (and MANAGER, ANALYST, PRIVACY)
PV_CATALOG_URI=... / PV_CATALOG_WAREHOUSE=...
```

`PV_WORKERS_SUBDOMAIN` is no longer needed (the subdomain exists). Also written by setup and gitignored: `.secrets/worker-secrets.env` (`PV_PSEUDONYM_MASTER_KEY`, `GCP_GATEWAY_SA_KEY`; uploaded by `npm run deploy`), `.secrets/prod-resources.json` (resource ids, policy tag resource names; no stream id any more), `infra/cloudflare/wrangler.production.jsonc`. No executor key exists on the laptop.

## Costs (Workers Free)

| Item | Cost at this project's scale | Source |
|---|---|---|
| Workers Free: Workers, Workflows, Queues, D1, KV, Workers Logs | $0; this repo's worst-case day uses at most 65% of a 25% share of each daily allowance (section 30.4) | F1 to F13 |
| R2 | free tier (10 GB-month, 1M Class A, 10M Class B per month); under 50 MB stored | F14 |
| Basin Catalog | 1M operations per month included (about 11,000 used at the cap); compaction off; snapshot expiration free | F15 |
| Zero Trust | Free plan, $0 (payment details on file, not charged); 5 of 50 seats | F19 |
| BigQuery | inside the free tier of 1 TiB queries and 10 GiB storage per month, shared by four repos; about 30 GB of queries in the eval month; every query capped (100 MiB from the Worker, 1 GiB from Python and dbt) | F20 |
| Workers AI and AI Gateway (P1) | $0: at most 2,000 of the account's 10,000 free neurons per day; gateway features used are free | F17, F18 |
| GitHub Actions | $0 (public repository) | |
| Expected total | $0 per month; the $1 budget alert (step 12) catches surprises | estimate |

## Commands after the logins

```bash
npm run doctor -- --prod                                       # lists exactly what is missing, with the fix for each line
npm run setup:prod -- --dry-run                                # optional: shows the exact plan, secrets masked
npm run setup:prod                                             # idempotent; re-run until doctor is green; stops on a same-named resource it did not create
npm run doctor -- --prod
# IAM grants take about 30 seconds and policy tag changes up to 30 minutes to propagate (column-level access control docs); wait before the next line
uv run --project pipelines pv authz warehouse --target bigquery --write-results --ceiling-probes
uv run --project pipelines pv eval deletion --profile prod     # one DSR alone first (canary), then the other 11; 12 of the day's 16 starts
uv run --project pipelines pv audit export --target prod       # also run by the eval and by executor.yml
npm run authz:prod
# 48 hours later (BigQuery time travel window) and again after 1 day for Basin snapshot expiration
uv run --project pipelines pv residuals check --target prod
npm run readme:results
git add evals/results README.md && git commit -m "docs: production results"
npm run setup:prod -- --only worker --retention-cron on         # step 19, only after the eval result is committed
```

## What the scripts cannot do

Turning on two-factor authentication, adding the One-time PIN login method, creating the two Cloudflare tokens, enabling billing and the budget alert on the Google billing account, the OAuth consent screens of `wrangler login` and `gcloud auth`, any organization policy exception, and accepting any terms of service. Everything else (every resource in sections 15, 16 and 30, secrets, deploys, the Access application, service tokens, seeding, the audit copy, the retention cron switch, and in P1 the GitHub secrets and the AI gateway) is scripted and idempotent.

## More commands

```bash
uv run --directory pipelines pytest -m bigquery                    # the live BigQuery suite (48 cases, 37 ceiling probes, controls, time travel)
uv run --project pipelines pv executor run --target prod --drain   # the production executor from this Mac (executor.yml automates it hourly)
uv run --project pipelines pv audit status --target prod --json    # the audit copy's lag and last commit (the doctor reads this)
uv run --project pipelines pv audit export --target prod --rebuild # rebuild governance.audit_events from D1 if its last hash ever differs
uv run --project pipelines pv authz warehouse --target bigquery --cleanup   # empty the probe dataset after an interrupted ceiling-probe run
npm run bench:cpu                                                  # CPU of the Worker's hot paths over data/generated (local)
```

`pv eval deletion --profile prod` refuses to start when any data subject request exists, when a request already names one of its cohort subjects, or when fewer than 12 of the day's 16 deletion starts are left. It plants 5 residues of designed types (one per store), warms the production caches through Access with the persona service tokens, submits one deletion alone first (the canary) and stops unless it completes, then submits the other 5 deletions, the held request and the 5 planted subjects as `privacy-01`, runs the production executor in-process (5 s poll) until every request is terminal (10 s poll), runs the residual check, copies the audit chain into `governance.audit_events`, scans every production store with the independent oracle, removes the planted residues and writes `evals/results/deletion-prod-<date>.{json,md}`.

## The scheduled executor (`executor.yml`, P1)

`.github/workflows/executor.yml` runs every hour at minute 7 (and on demand from the Actions tab) once the repository variable `PV_PROD_ENABLED` is `true`. It drains the executor tasks that the Workflows queue in D1 (warehouse DML, the `headcount_monthly` rebuild, Iceberg deletes), copies the audit chain into `governance.audit_events` when 1,000 events wait or the last copy is a day old (`pv audit export --target prod --if-due`), and at 04 UTC it also runs the token-free residual check. A concurrency group keeps two runs from overlapping. It reads these repository secrets, all written by `npm run setup:prod -- --only github` with the values travelling on `gh`'s standard input, never in a command line:

| Secret | Value |
|---|---|
| `PV_BASE_URL` | `https://peoplevault.<subdomain>.workers.dev` |
| `PV_CF_ACCESS_CLIENT_ID`, `PV_CF_ACCESS_CLIENT_SECRET` | the `pv-executor` Access service token |
| `PV_GCP_PROJECT` | `master-magnet-444903-u4` |
| `PV_GCP_EXECUTOR_KEY` | a `peoplevault-executor` key created by `pv setup actions-key` and piped straight into the secret; it is never written to disk, so no `peoplevault-executor` key exists on your machine (rotate with `uv run --project pipelines pv setup actions-key --repo <owner>/<name> --rotate`) |
| `PV_R2_CATALOG_TOKEN`, `PV_CATALOG_URI`, `PV_CATALOG_WAREHOUSE` | Basin Catalog access (the Iceberg archive and the audit copy) |
| `PV_POLICY_TAGS_JSON` | the policy tag resource names `pv setup gcp` recorded |

Setup keeps a SHA-256 of each uploaded value in `.secrets/prod-resources.json`, so a rotated value (for example a rotated service token) is uploaded again on the next run and nothing else is rewritten. The pseudonym master key is not a GitHub secret: nothing in the job needs it.

The repository is public, and so are its Actions logs: the job sets `PV_PUBLIC_LOGS=true`, which prints an uncaught exception as its type and redacted message only (no traceback), sends warnings through the redacting logger and turns dbt's own console output off; the job prints counts, never rows. The key file lives in the runner's temp directory and is deleted in an `always()` step.

GitHub disables scheduled workflows in a public repository after 60 days without repository activity. `npm run doctor -- --prod` reads the workflow's state and the age of its last successful run (more than 26 hours is `[missing]`) and prints `gh workflow enable executor.yml --repo <owner>/<name>` when it has been disabled.

## What the scripted paths are, and what has run

| Path | Command | State |
|---|---|---|
| Prerequisite report | `npm run doctor -- --prod` (Google lines from `pv doctor gcp --json`) | written; runs on this Mac today and reports the missing setup; tested with fakes and recorded responses. Workers Free lines: name conflicts on the shared account, the retention cron switch, admissions today, D1 rows per probe projected at the cap, the audit copy's lag, an optional CPU p99 |
| Cloudflare resources, Worker render, migrations, deploy | `npm run setup:prod` groups `cloudflare` and `worker`, `npm run deploy`, `--retention-cron on\|off` | written, dry-run golden-tested, not yet executed; refuses to adopt a same-named bucket, database, namespace, queue or Worker that `.secrets/prod-resources.json` does not record as this repo's |
| Google Cloud | `pv setup gcp [--dry-run]` | written, dry-run golden-tested with a fake client, not yet executed: 12 `peoplevault_*` datasets (the probe and scratch datasets included, because the executor cannot create datasets in the shared project), 7 `peoplevault-*` service accounts, only `roles/bigquery.jobUser` at project level, `roles/datacatalog.viewer` on the taxonomy |
| Access application and service tokens | `npm run setup:prod -- --only access` | written, not yet executed. The `worker` destination takes the Worker's id from `GET /accounts/{id}/workers/workers`; the reference describes that field only as "the ID of the Cloudflare Worker", so the first run confirms it, and the doctor's edge check proves the result |
| Seeding | `npm run seed:prod` | written, not yet executed; refuses to run once any deletion request exists (re-uploading exports would resurrect erased data) |
| Warehouse authorization | `pv authz warehouse --target bigquery --ceiling-probes` | written, not yet executed; the probe views live in `peoplevault_authz_probe` and are removed afterwards (the dataset stays) |
| Executor, residual check, lake self-test | `pv executor run --target prod`, `pv residuals check --target prod`, `pv lake init --target prod` | written, not yet executed |
| Production deletion eval | `pv eval deletion --profile prod` | written, not yet executed; a canary deletion runs alone first; R2 objects are listed and read through `GET /accounts/{id}/r2/buckets/{bucket}/objects[/{key}]` with wrangler's OAuth token, and that endpoint's pagination fields are unverified |
| Authorization cases through Access (P1) | `npm run authz:prod [-- --allow-writes]` (`pv authz api --target prod`) | written, not yet executed. Rehearsed against the local stack with the full synthetic population (`npm run authz:api:local`). It runs every case it can with the four persona service tokens and the executor's, re-resolving subjects from the production population's ground truth (`data/generated-prod`, written by `seed:prod`), and reports the exact runnable count with a reason for each skipped case: forged, missing or unmapped tokens cannot pass Access, the fixture's other principals have no token, some selectors have no qualifying subject, and the deletion and hold cases need `--allow-writes` |
| Production warm-up (P1) | step 9 of `npm run seed:prod` (`pv warmup --target prod --with-extracts`) | written, not yet executed; creates the 6 analytics extracts as `analyst-01` and warms the cache entries whose principal has a service token (the others need an interactive sign-in) |
| Audit copy (P1) | `uv run --project pipelines pv audit export --target prod [--rebuild] [--if-due]`, hourly in `executor.yml` when due, `setup:prod` data group (first export and the table's snapshot expiration), `pv audit status --target prod --json` (doctor) | written, not yet executed against the Basin Catalog; the same code runs locally against pyiceberg's SqlCatalog in the ci eval. It pages `GET /api/v1/executor/audit-export`, checks that the chain links, and appends in one commit whose snapshot summary holds `pv.audit.last_seq` and `pv.audit.last_hash`; the table sets `commit.retry.num-retries` to 0 so a concurrent exporter's commit makes this one fail and re-read instead of appending twice |
| Privacy console (P1) | `npm run deploy` (builds `dist/web` with `npm run build:web`, then uploads it with the Worker as static assets) | written, not yet executed against Cloudflare; used locally against `wrangler dev`. The same Access application covers it (it has no route of its own): only `/api/*` and `/dev/*` invoke the Worker, static asset requests are "free and unlimited" (Cloudflare's static assets billing page), and the doctor's "console protection" line checks that an unauthenticated request for `/` is answered by Access, not by the console's HTML. A person signs in with the One-time PIN of their Access seat; the persona comes from the D1 principal whose email matches |
| Schema-drift triage (P1) | `POST /api/v1/privacy/schema-drift/:id/suggest` and `/classify`, `GET /api/v1/privacy/schema-drift/usage`; `setup:prod` group `cloudflare` creates the AI Gateway; `uv run --project pipelines pv eval drift --target prod` | written, not yet executed against Workers AI; the same route runs locally against Qwen3-1.7B on llama-server (`npm run llm:serve`) and a deterministic stub. Calls go through the gateway with `collectLog: false` and `skipCache: true`; the Worker meters neurons in D1 `ai_usage` and stops at 2,000 a UTC day (the route then answers with the rule class alone). The production eval of 120 columns needs up to 3,100 neurons, so it stops at the cap and continues the next UTC day from its checkpoint; only the complete run writes `evals/results/drift-prod-<date>.json`. The update call (PUT) that repairs a drifted gateway and the error code of a missing gateway are unverified until the first run |
| Scheduled executor (P1) | `.github/workflows/executor.yml`, `npm run setup:prod -- --only github`, `pv setup actions-key` | written, not yet executed (the repository has not been pushed); the workflow's structure, the secrets it reads and the doctor's schedule checks are tested |
