# Tsukinome — setup guide

This walks you from nothing to a running Tsukinome that turns issues into PRs on a repo.
You install it **once** as a GitHub App; target repos need **no config files**.

## 1. Prerequisites

- Node.js ≥ 20
- A Postgres database with the **pgvector** extension available (Neon works; locally,
  `pgvector/pgvector:pg16` is the easiest). Tsukinome runs `CREATE EXTENSION vector` in a
  migration, so the extension must be installable.
- An **Anthropic API key** (model calls).
- An **E2B API key** (ephemeral sandbox that clones the repo and runs its tests).
- (Optional, for the code index) Python with CocoIndex available as a sidecar — see
  `sidecar/`. The core pipeline runs without it; it powers richer plan-time retrieval.

## 2. Create the GitHub App

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.

- **Webhook URL:** `https://<your-host>/api/github/webhooks`
- **Webhook secret:** generate one; you'll set it as `WEBHOOK_SECRET`.
- **Repository permissions:**
  - **Contents:** Read & write (commit the branch + artifacts)
  - **Issues:** Read & write (acknowledge, ask clarifications, post the cost summary)
  - **Pull requests:** Read & write (open the PR, reply to review comments)
  - **Metadata:** Read-only (default)
- **Subscribe to events:**
  - **Issues** (`issues.opened`)
  - **Issue comment** (`issue_comment.created` — clarification + plan-gate replies)
  - **Pull request review** (`pull_request_review.submitted` — `changes_requested`)
  - **Pull request review comment** (`pull_request_review_comment.created` — inline fixes)

After creating it:

1. Note the **App ID**.
2. Generate a **private key** (`.pem`); its contents become `PRIVATE_KEY`.
3. **Install the App** on the account/repos you want Tsukinome to work on.

> The runtime mints a per-run, single-repo, `contents: read` token for cloning — separate
> from the App's write credentials, and redacted from logs. See `docs/security.md`.

## 3. Configure the environment

Set these (e.g. in your host's secret manager, or a local `.env`):

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `APP_ID` | yes | — | From the App settings page. |
| `PRIVATE_KEY` | yes | — | The full `.pem` contents (newlines preserved). |
| `WEBHOOK_SECRET` | yes | — | Must match the App's webhook secret. |
| `ANTHROPIC_API_KEY` | yes | — | Model calls (Haiku/Sonnet/Opus). |
| `E2B_API_KEY` | yes | — | Sandbox for clone + test runs. |
| `DATABASE_URL` | yes | — | Postgres connection string (pgvector-capable). |
| `RUN_BUDGET_USD` | no | `1.00` | Per-run model-spend ceiling. |
| `PORT` | no | `3000` | Webhook HTTP port. |

> This environment's permission settings block editing `.env*` from the agent, so there is no
> `.env.example` in the repo — use the table above as the source of truth.

## 4. Migrate and run

```bash
npm install
npm run migrate up        # creates tables + the pgvector extension
npm start                 # webhook server + worker in one process
```

Health check: `GET /health` returns `200`. Webhooks land on `/api/github/webhooks`.

For local development without a public URL, use a webhook proxy:

```bash
npm run dev:smee          # needs SMEE_URL set to your smee.io channel
npm run dev               # tsx watch, same single-process server+worker
```

## 5. Use it

1. On a repo where the App is installed, **open an issue** describing the change.
2. Tsukinome comments to acknowledge, then commits a draft spec on `tsukinome/issue-<n>`.
3. If anything's unclear it asks **one batched set of questions** — reply on the thread.
4. It commits a `plan.md` and waits. Reply **`/approve`** to implement, **`/abort`** to stop,
   or describe changes to revise the plan.
5. It implements test-first (one commit per task) and **opens a PR** with a self-review and a
   **cost summary**. Review and merge — or leave review comments for a bounded fix loop.

Long-parked runs are nudged after ~3 days and closed after ~7 if there's no response; nothing
is ever merged without your approval.

## 6. Operating notes

- **Budget:** a run that hits `RUN_BUDGET_USD` stops gracefully with a comment. Raise the knob
  for larger changes.
- **Cost metrics:** `npm run debug:cost-metrics` prints runs, total spend, and measured average
  cost/issue.
- **Reliability:** jobs retry with exponential backoff and are dead-lettered (with a failure
  comment) after the attempt cap; a crashed worker's in-flight job is reclaimed by its lease.
- **Supported repos:** TypeScript/JavaScript only for the MVP; other languages are refused
  gracefully with a comment.
