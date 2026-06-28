# Tsukinome — security model

Tsukinome reads untrusted text from the internet (issues, comments, PR threads, repo
files) and turns it into commits and pull requests. This document records the boundaries
that keep that safe. The load-bearing ones are pinned by regression tests in
`test/security/boundary.test.ts` — weakening them turns a test red.

## 1. Untrusted-input boundary

**Invariant:** issue bodies, comments, PR text, and file contents are **data, never
instructions.**

- Every agent runs behind a fixed *constitution* (`CONSTITUTION` in
  `src/agents/runner.ts`) that states external text is untrusted DATA and only the
  system prompt + role instructions are authoritative. It is the stable, cached prefix
  of every model call, so no role can be invoked without it.
- Untrusted text is always passed as a `user` message — never concatenated into the
  system prompt or role instructions.
- Webhook handling (`src/app.ts`) ignores comments authored by bots
  (`comment.user.type === 'Bot'`), so Tsukinome never resumes a run on its own output,
  and treats every human comment body as data fed into triage/finalize — not as a command.

## 2. Least-privilege tokens

- The sandbox clone credential is minted per run by `getInstallationToken`
  (`src/github/client.ts`), scoped to a **single repository** with **`contents: read`**
  only. It can clone, nothing else.
- That token is used solely as the git-clone credential inside the E2B sandbox and the
  host-side index checkout; it is **redacted** from every persisted/returned command
  label and error (`redactToken`, `src/index/checkout.ts`).
- Write operations use the installation's own credentials through Octokit inside the
  Integrator only (see §3), not a long-lived broadly-scoped token.

## 3. The deterministic-integrator wall

**Invariant:** no agent (LLM) can write to a repo. Every git/PR mutation goes through
deterministic code.

- All repo writes — branch creation, file commits (`commitFile`/`commitFiles` via the
  git Trees API), and opening the PR (`openPullRequest`) — live in
  `src/github/integrator.ts` + `src/github/client.ts`. They are plain TypeScript: no model
  decides what bytes land.
- Agents are **output-only**. Every real pipeline role
  (intake, product-owner, clarifier, architect, decomposer, test-author, implementer,
  refactor, reviewer, fix-triage) is schema-constrained with **no tools** in its registry
  entry (`src/agents/registry.ts`). The only tool any role may call is the harmless `ping`
  stub used by the Phase-3 demo role. `test/security/boundary.test.ts` fails if a
  write-capable tool is ever attached to a role.
- The Reviewer reads the diff; it cannot approve-and-merge or push. Its verdict is
  advisory and recorded in the PR body / an issue comment for the audit trail.

## 4. Secrets handling

- Secrets (`APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `E2B_API_KEY`,
  `DATABASE_URL`) come from the environment via `loadConfig` (`src/config.ts`); none are
  committed. `.env` is git-ignored.
- The clone token is never logged or persisted — it is redacted at the one boundary where
  it could leak (clone command label + git errors).
- Webhook payloads are verified against `WEBHOOK_SECRET` by Probot before any handler runs.

## 5. Cost & loop safety (defence against runaway spend)

- Every model call is instrumented and budget-checked at the single gateway chokepoint
  (`src/llm/gateway.ts`); a run refuses further spend once its budget is exhausted and
  stops gracefully.
- Bounded loops everywhere: the plan-revision cap, the fix-round cap, the TDD escalation
  ladder (Sonnet → Opus → human), and — as of Phase 11 — a job-retry cap with exponential
  backoff and a stale-run sweeper that closes abandoned runs. Nothing loops unbounded.

## 6. Reporting

This is an MVP. If you find a security issue, open a private advisory on the repository
rather than a public issue.
