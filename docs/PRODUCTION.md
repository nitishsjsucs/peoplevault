# Production setup

This is section 23 of SPEC.md, kept current as the code lands. Steps marked (P1) are below the core cut line and are not needed for v1. Workers AI and AI Gateway need no setup for v1: no resume claim depends on them, and they are P1.

Everything a script can do is in `npm run setup:prod`. This section lists, in order, what only Nitish can do (accounts, payment, consent screens, logins, token creation, naming choices) and then the commands to run. The last column says where each fact was checked on 2026-10-10; "(unverified)" marks what could not be confirmed against an official page or the wrangler 4.149.0 source. `docs/PRODUCTION.md` carries this section verbatim and is kept current.

## Accounts, plans, console steps and tokens

| # | Provider | Step | Where | Cost | Needed for | Checked against |
|---|---|---|---|---|---|---|
| 1 | Cloudflare | Create or sign in to an account; turn on two-factor authentication | https://dash.cloudflare.com/sign-up | free | everything on Cloudflare | |
| 2 | Cloudflare | Upgrade the account to Workers Paid | dashboard, Workers & Pages, Plans (console path unverified) | $5/month minimum per account | Workflow steps need more than Free's 10 ms CPU and 50 subrequests per instance; `limits.cpu_ms`; (P1) Basin Pipelines | Workers pricing, Workflows limits page |
| 3 | Cloudflare | Register a workers.dev subdomain (pick the name; the Worker becomes `peoplevault.<name>.workers.dev`). Either in the dashboard, or put `PV_WORKERS_SUBDOMAIN=<name>` in `.secrets/prod.env` and let `setup:prod` register it after asking | `https://dash.cloudflare.com/<ACCOUNT_ID>/workers/onboarding` | free | wrangler refuses to deploy Workflows without one ("You need to register a workers.dev subdomain before deploying Workflows"); doctor's edge check URL | wrangler 4.149.0 `cli.js` |
| 4 | Cloudflare | Open R2 Object Storage once and activate it if the dashboard asks (unverified whether a separate activation is still required) | dashboard, R2 Object Storage | free tier covers this project | R2 buckets and Basin Catalog | |
| 5 | Cloudflare | Zero Trust onboarding: choose a team name (for example `nitish-pv`, giving `nitish-pv.cloudflareaccess.com`), choose the Free plan, enter payment details (the setup docs say Free is not charged) | dashboard, Zero Trust | $0 (Free plan seat limit of 50 reported by third parties, unverified) | Cloudflare Access in front of the Worker | Cloudflare One setup docs |
| 6 | Cloudflare | Add One-time PIN as a login method | Zero Trust, Settings, Authentication, Login methods, Add new (path unverified) | free | signing in by email as each persona | Access docs |
| 7 | Cloudflare | Create an account API token named in `.secrets/prod.env` as `PV_CF_API_TOKEN` (Custom token) with exactly: Access: Apps and Policies Edit; Access: Service Tokens Edit; Access: Organizations, Identity Providers, and Groups Read; Workers Scripts Read; Billing Read. Do not call it `CLOUDFLARE_API_TOKEN`: wrangler would use that variable instead of the OAuth login, and this token cannot create D1, R2 or Queues | My Profile, API Tokens, Create Token | free | Access app, policies and service tokens; doctor's subdomain and Workers Paid checks | API token permissions reference (names); subscriptions API reference (Billing Read) |
| 8 | Cloudflare | Create an R2 API token with Admin Read & Write; save it as `PV_R2_CATALOG_TOKEN` | R2 Object Storage, Manage API tokens, Create API token | free | pyiceberg REST access to the Basin Catalog Iceberg archive; (P1) the audit sink | Basin Catalog guide |
| 9 | Cloudflare | `npx wrangler login` in the repo and approve the OAuth consent screen | terminal, browser | free | every wrangler command; doctor's R2, KV, Queues and Basin listings (wrangler OAuth token) | `wrangler whoami --json` |
| 10 | Google | Google account; create a project (for example `peoplevault-<suffix>`) dedicated to PeopleVault | https://console.cloud.google.com | free | BigQuery; the executor's project-level read grants assume a dedicated project | |
| 11 | Google | Create or link a billing account to the project | Billing, Link a billing account, or `gcloud billing projects link` | card required; usage expected under $1/month | DML deletes (the BigQuery sandbox has no DML and expires tables after 60 days) | BigQuery sandbox docs |
| 12 | Google | Budget alert at $5 | Billing, Budgets and alerts | free | cost guard | |
| 13 | Google | Install the Google Cloud CLI and log in, including the ADC quota project (commands in 23.2) | terminal, browser consent | free | `pv setup gcp`; impersonating `pv-executor`; Data Catalog and data policy calls with user ADC | `brew info --cask gcloud-cli`; Google auth docs |
| 14 | Google | Only if `pv setup gcp` reports that organization policy `iam.disableServiceAccountKeyCreation` blocks the `pv-gateway` key: use a project outside that organization, or ask for an exception for this project | IAM, Organization policies | free | the Worker's BigQuery credential | |
| 15 | Choice | Persona sign-in emails, for example Gmail plus-addresses: `PV_ACCESS_ALLOWED_EMAILS=<you>+hr@gmail.com,<you>+mgr@gmail.com,<you>+analyst@gmail.com,<you>+privacy@gmail.com` and `PV_ACCESS_PERSONA_EMAILS=<you>+hr@gmail.com=hrbp-01,<you>+mgr@gmail.com=mgr-001,<you>+analyst@gmail.com=analyst-01,<you>+privacy@gmail.com=privacy-01` | `.secrets/prod.env` | free | signing in as each of the four personas | |
| 16 | Choice | After the first `setup:prod`, copy `PV_PSEUDONYM_MASTER_KEY` from `.secrets/worker-secrets.env` into a password manager | password manager | free | pseudonym stability; losing it orphans every pseudonym | |

Not needed for v1: Workers AI and AI Gateway (P1, no resume claim depends on them), the Basin Pipelines stream, sink and pipeline (P1; created by `setup:prod` once that code exists, no extra manual step), and GitHub repository secrets (P1 `executor.yml`; `gh` is already logged in on this Mac and `setup:prod -- --only github` asks before writing).

## Local CLIs and logins (wrangler is not logged in and gcloud is not installed on this Mac today; gh is logged in)

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

Also written by setup and gitignored: `.secrets/worker-secrets.env` (`PV_PSEUDONYM_MASTER_KEY`, `GCP_GATEWAY_SA_KEY`; uploaded by `npm run deploy`), `.secrets/prod-resources.json` (resource ids, stream id in P1, policy tag resource names), `infra/cloudflare/wrangler.production.jsonc`. No `pv-executor` key exists on the laptop.

## Costs

| Item | Cost at this project's scale | Source |
|---|---|---|
| Workers Paid | $5/month minimum; includes 10M requests and 30M CPU ms per month; Queues 1M operations; KV 10M reads; D1 25B rows read and 5 GB | Workers pricing page (verified) |
| Workflows | included: 10M requests, 30M CPU ms, 1 GB-month, 500,000 steps per month on Paid (step and storage billing started 2026-08-10) | Workflows pricing page (verified) |
| R2 | free tier 10 GB-month, 1M Class A, 10M Class B per month; this project stores under 50 MB | R2 pricing page (verified) |
| Basin Catalog | 1M catalog operations per month included, then $9 per million; compaction left off; snapshot expiration has no separate charge | Basin pricing pages (verified) |
| Basin Pipelines (P1) | stream ingress free; 50 GB sink delivery included | Basin Pipelines pricing (verified) |
| Workers Logs | invocation logs disabled; only identifier-free console logs remain (Workers Logs pricing not re-checked this session) | Workers Logs docs (retention 3 days Free, 7 days Paid) |
| Zero Trust | Free plan, $0 | setup docs (payment details required, not charged) |
| BigQuery | 1 TiB of queries and 10 GiB storage free per month (allowance stated on the sandbox page); the full production eval scans a few GB because each referenced table bills at least 10 MB (minimum unverified this session) | BigQuery docs |
| Workers AI, AI Gateway (P1, not used in v1) | not needed | |
| Expected total | about $5/month plus well under $1 on Google Cloud | estimate |

## Commands after the logins

```bash
npm run doctor -- --prod                                       # lists exactly what is missing, with the fix for each line
npm run setup:prod -- --dry-run                                # optional: shows the exact plan, secrets masked
npm run setup:prod                                             # idempotent; re-run until doctor is green
npm run doctor -- --prod
# IAM grants take about 30 seconds and policy tag changes up to 30 minutes to propagate (column-level access control docs); wait before the next line
uv run --project pipelines pv authz warehouse --target bigquery --write-results --ceiling-probes
uv run --directory pipelines pytest -m bigquery                    # the live BigQuery suite (48 cases, 37 ceiling probes, controls, time travel)
uv run --project pipelines pv executor run --target prod --drain   # P0: the production executor runs from this Mac (P1 executor.yml automates it)
# 48 hours later (BigQuery time travel window) and again after 1 day for Basin snapshot expiration
uv run --project pipelines pv residuals check --target prod
npm run readme:results
git add evals/results README.md && git commit -m "docs: production results"
```

`pv eval deletion --profile prod` (the deletion eval against the deployed Worker, BigQuery and the Basin Catalog) is not built yet; until it is, deletions in production are exercised through the API (`POST /api/v1/privacy/deletion-requests` with the privacy persona's service token) and `pv executor run --target prod --drain`.

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
| Production deletion eval | `pv eval deletion --profile prod` | not built |

## What the scripts cannot do

Account creation, the Workers Paid upgrade, payment details, Zero Trust onboarding, adding the One-time PIN login method, creating the two Cloudflare tokens, choosing the workers.dev subdomain name (registration itself can be scripted once the name is set), the OAuth consent screens of `wrangler login` and `gcloud auth`, linking billing, the budget alert, any organization policy exception, and accepting any terms of service. Everything else (every resource in sections 15 and 16, secrets, deploys, the Access application, service tokens, seeding, and in P1 GitHub secrets) is scripted and idempotent.
