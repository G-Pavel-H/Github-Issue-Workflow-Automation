---
description: Take Tsukinome from a green build to its first live issue→PR run (credentials, migrations, gated tests, end-to-end)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash
---

Bring Tsukinome up against live services for the first time. The MVP build is complete and green; this is provisioning + validation, not feature work. Follow every rule in `CLAUDE.md`. `docs/setup.md` is the source of truth for env vars and the GitHub App.

**Secrets discipline (non-negotiable):** `.env` and `*.pem` are gitignored — keep it that way. Never print a full secret value, never `git add` a secret, never paste a key into `PROGRESS.md` or a commit. When you need a missing secret, ask me for it and I'll paste it; you write it into `.env`.

Work these steps in order. Stop and report at any gate that needs my hands.

1. **Orient.** Read `CLAUDE.md`, `PROGRESS.md`, `docs/setup.md`, and the current `.env`. State which of the 6 required vars (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`, `DATABASE_URL`) are already present vs missing. Do not echo their values.

2. **Confirm the build is green.** Run `npm run typecheck`, `npm run lint`, `npm test`. Expect ~189 passed / 23 skipped (the skipped ones are the live-service tests we're about to enable). If anything is red, stop and report before going further.

3. **Fill missing credentials.**
   - For each missing var, tell me exactly where to get it and wait for me to paste it, then write it into `.env`.
   - For the **GitHub App**: walk me through `docs/setup.md` §2 — creating the App (Contents/Issues/PRs read-write, Metadata read; subscribe to `issues`, `issue_comment`, `pull_request_review`, `pull_request_review_comment`), noting the **App ID**, generating the **private key** `.pem`, setting a **webhook secret**, and **installing** it on a throwaway TypeScript repo. Store the `.pem` contents as `PRIVATE_KEY` (newlines preserved).

4. **Migrate.** Run `npm run migrate up` (creates tables + the `vector` extension on Neon). If it fails on DNS or DDL against a `-pooler` host, tell me to swap `DATABASE_URL` to Neon's **direct** (non-pooled) endpoint and retry.

5. **Run the gated integration tests.** With the keys now set, `npm test` should un-skip and exercise the real Anthropic calls, E2B sandbox teardown, and pgvector/pg-store paths. Report pass/fail per suite; debug any failures — this is where the fakes hid gaps (CocoIndex API surface, E2B behavior, prompt quality).

6. **First live issue→PR run (local + smee).** Set `SMEE_URL` to a fresh smee.io channel and point the App's webhook at it. Start `npm run dev` and `npm run dev:smee`; confirm `GET /health` returns 200 and a webhook is delivered. Then have me open a real issue on the installed test repo, and drive the pipeline: ack → draft spec → (clarify if needed) → `plan.md` → I reply `/approve` → test-first implementation (one commit per task) → self-reviewed PR with a cost summary. Watch for the budget/fix-round caps behaving.

7. **Record state.** Add a "Go-live" section to `PROGRESS.md`: what ran, integration-test results, the first-run outcome (issue #, PR link, measured cost/issue), and any deviations found. Then **stop and report** — what worked, what to fix, and the single next action.
