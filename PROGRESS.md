# Tsukinome — progress log

Keep this current. It's the source of truth for what's done and what's next.

## Phase status

- [x] Phase 0 — Project scaffolding
- [x] Phase 1 — End-to-end loop: webhook → worker → comment
- [x] Phase 2 — Sandbox: checkout & test execution
- [x] Phase 3 — LLM gateway + agent runner
- [ ] Phase 4 — Intake & spec (Product Owner), committed artifacts
- [ ] Phase 5 — Clarification gate (suspend/resume #1)
- [ ] Phase 6 — Code index (CocoIndex retrieval)
- [ ] Phase 7 — Architect & plan gate (Definition of Ready)
- [ ] Phase 8 — Task decomposition & TDD execution loop (Definition of Done)
- [ ] Phase 9 — Reviewer & Integrator → Pull Request  ← MVP heartbeat
- [ ] Phase 10 — PR comment → fix loop (bounded)
- [ ] Phase 11 — Reliability, security, easy install

## Locked decisions

- Language: TypeScript throughout.
- GitHub App via Probot + Octokit (App + persistent backend, not pure Actions).
- Postgres (Neon) + pgvector for state and the code index.
- CocoIndex sidecar for AST-aware incremental code indexing.
- E2B ephemeral microVM sandbox for cloning repos and running tests.
- Anthropic API, model-tiered (Haiku/Sonnet/Opus) with prompt caching.
- Hand-rolled agent runner + role registry; no agent framework.
- MVP target repos: TypeScript only.

## Decision log

(Record any new decisions or deviations here, with date and reason.)

- 2026-06-26: Chose Vitest over Jest (native ESM/TS support, faster, no transform config needed).
- 2026-06-26: Used raw `http.createServer` with Probot's `createNodeMiddleware` rather than Probot's built-in `Server` class — gives us direct control over routing (health endpoint) and middleware composition.
- 2026-06-26: Chose `node-pg-migrate` for migrations (lightweight SQL-based, no ORM).
- 2026-06-26 (Phase 1): Persistence behind a `Store` interface with two impls — `PgStore` (production) and `InMemoryStore` (unit tests / no-DB local dev). Lets us unit-test queue/worker/idempotency fast while integration-testing the real SQL in CI.
- 2026-06-26 (Phase 1): Server + worker run in **one process** for the MVP (`startWorker` polls alongside the HTTP server). Split into separate processes later only if needed.
- 2026-06-26 (Phase 1): Job queue uses the Postgres `FOR UPDATE SKIP LOCKED` claim pattern; `findOrCreateRun` uses `INSERT ... ON CONFLICT DO UPDATE ... RETURNING (xmax = 0) AS created` to detect insert-vs-existing in one round trip.
- 2026-06-26 (Phase 1): Added a `postgres:16` service container to CI and a `npm run migrate up` step so `PgStore` integration tests run for real; they `skipIf(!DATABASE_URL)` so local `npm test` stays green with no DB.
- 2026-06-26 (Phase 1): Fixed migration 001's up/down markers to node-pg-migrate's `-- Up Migration` / `-- Down Migration` format so `migrate up` parses both files.
- 2026-06-26 (Phase 1): **Known limitation (defer to Phase 11):** acknowledgement-comment idempotency is "basic" — the comment is posted, then the run advances to `acknowledged`. A crash in that narrow window can re-post on retry. Reprocessing a fully-completed job never double-posts. Webhook redeliveries are deduped via `processed_events`. Phase 11 hardens the crash-window case.
- 2026-06-27 (Phase 2): Sandbox behind a `SandboxProvider`/`SandboxHandle` interface (mirrors Phase 1's `Store` split). `E2BSandboxProvider` is the real impl; `FakeSandboxProvider` drives unit tests. The E2B-specific quirk (`commands.run` *throws* `CommandExitError` on non-zero exit) is normalized to a plain `CommandResult` in the one thin wrapper file.
- 2026-06-27 (Phase 2): `runTests` guarantees sandbox teardown via `finally` (kill wrapped so a teardown error can't mask the result); E2B's `create({ timeoutMs })` auto-kill is the backstop. Status vocabulary: `passed` (green), `failed` (red suite — not an error), `error` (clone/install/infra failure, with `failureStage`).
- 2026-06-27 (Phase 2): Least-privilege token — `getInstallationToken` mints an installation token scoped to `{ repositories: [repo], permissions: { contents: 'read' } }`; it's used only as the sandbox git-clone credential and is **redacted** from the persisted/returned command label (test asserts the token never appears in the result).
- 2026-06-27 (Phase 2): **E2B is NOT wired into CI** (paid microVM service; per-PR spin-ups are a cost/flake risk — unlike Phase 1's free Postgres service container). CI runs fake-sandbox unit tests; the real E2B path is a `skipIf(!E2B_API_KEY)` integration test (verifies teardown via `Sandbox.list()`), run locally / in the demo.
- 2026-06-27 (Phase 2): Phase 2's sandbox run is **debug-triggered** via `npm run debug:run-tests -- <installationId> <owner> <repo> [ref] [issueNumber]`, which enqueues a `run_tests` job — no webhook/comment-parsing changes (those stay owned by Phases 5/10).
- 2026-06-27 (Phase 2): Added required `E2B_API_KEY` to config. **`.env.example` was NOT updated** — it's blocked by this environment's permission settings (can't read/write `.env*`). Add an `E2B_API_KEY=` line manually.
- 2026-06-27 (Phase 2): Harmless noise — the `e2b` SDK emits a Node `ExperimentalWarning` (its `chalk` dep is ESM loaded via `require`) during tests. Cosmetic; no action.
- 2026-06-27 (Phase 3): Anthropic SDK behind an `LlmProvider` interface (`AnthropicProvider` real impl + scriptable `FakeLlmProvider`) — same isolation pattern as Postgres (Phase 1) and E2B (Phase 2). All routing/cost/budget/caching/tool-loop logic lives in our code and is unit-tested with the fake; the real API is gated on `ANTHROPIC_API_KEY`.
- 2026-06-27 (Phase 3): Money is tracked as **integer nano-USD** (1e-9 USD), not floats. Per-token rates are whole nano-USD numbers (Opus in 5000 / out 25000 / cache-write 6250 / cache-read 500), so cost arithmetic is exact. `costNanoUsd` + `formatUsd` in `src/llm/pricing.ts`; pricing Haiku 1/5, Sonnet 3/15, Opus 5/25 per MTok.
- 2026-06-27 (Phase 3): Model tiering is a `ModelTier` → model map in `src/llm/models.ts` (`triage→claude-haiku-4-5`, `implementation→claude-sonnet-4-6`, `review→claude-opus-4-8`). Exact IDs, no date suffix (confirmed against the claude-api reference).
- 2026-06-27 (Phase 3): The **gateway is the single instrumented chokepoint** — every call resolves the model, pre-checks the run budget (refusing with `BudgetExhaustedError` before spending when remaining ≤ 0), then logs tokens + cost and atomically decrements the run's spend via `store.recordLlmCall` (one PG transaction). Never add an uninstrumented model call.
- 2026-06-27 (Phase 3): Agent = instruction file + tier + optional Zod schema + optional tool allowlist. `runAgent(role, input, ctx)` handles single-shot (schema-constrained output via `output_config.format` + Zod validation) and the tool-use loop (run tool → feed result back → repeat, **stop at `maxToolRounds`**). Adding an agent later = one `agents/<role>.md` + one `ROLES` entry. The constitution + instruction file form the cacheable stable prefix (last block marked `ephemeral`).
- 2026-06-27 (Phase 3): Schema → `output_config.format` uses the SDK's `zodOutputFormat`; confirmed working with zod v4.4.
- 2026-06-27 (Phase 3): Throwaway demo roles `agents/example-echo.md` (single-shot structured) and `agents/example-tool-pinger.md` (tool loop, `ping`→`pong`, cap 3) prove the abstraction and satisfy exit criteria 4–5; removable once real roles land in Phase 4+.
- 2026-06-27 (Phase 3): **Minor deviation from plan** — did not add a `RUN_BUDGET_NANO_USD` config var; the per-run default ($1.00 = 1e9 nano-USD) lives as the `runs.budget_nano_usd` column DEFAULT + the `DEFAULT_RUN_BUDGET_NANO_USD` constant in `store/types.ts`. A config knob would be unused dead code until an orchestrator sets budgets per run (Phase 4+).
- 2026-06-27 (Phase 3): **Not wired into `index.ts` yet** — the gateway/runner are the platform; the worker starts consuming them in Phase 4 (Intake & spec). Wiring now would be dead code. Like E2B, the real Anthropic path is **not** in CI; CI runs fake-provider unit tests only.

## Session log

(Append a line per phase: date, phase, outcome, demo.)

- 2026-06-26 | Phase 0 | ✅ Complete | 14 tests pass, lint + typecheck green, `/health` returns 200, Probot webhooks wired + tested, migration harness ready, CI workflow added.
- 2026-06-26 | Phase 1 | ✅ Complete | 29 tests pass (incl. 4 real PgStore integration tests verified against a local Postgres 16), lint + typecheck green. Built `jobs`/`runs`/`processed_events` schema (migration 002), `Store` interface + Pg/in-memory impls, polling worker, `issues.opened` → enqueue → worker posts "Tsukinome has picked this up" → run advances `received`→`acknowledged`. Idempotency: duplicate deliveries deduped; reprocessing a completed job posts no second comment. CI gained a Postgres service + `migrate up`. Demo: open an issue on the test repo → App comments.
- 2026-06-27 | Phase 3 | ✅ Complete | 55 unit tests pass (10 gated-skipped: Anthropic + PG + E2B), lint + typecheck green; PgStore `llm_calls`/budget SQL verified against a local Postgres 16 (6/6). Built the `LlmProvider` abstraction (`AnthropicProvider` + `FakeLlmProvider`), nano-USD cost model, `LlmGateway` (tier routing + per-call cost logging + per-run budget with `BudgetExhaustedError`), `llm_calls` table + budget columns (migration 004) with atomic `recordLlmCall`, the `runAgent` runner + role registry (single-shot structured + tool-use loop with cap), and two throwaway example roles. Exit criteria 1/2/4/5 covered by fake-provider unit tests; 3 (caching `cache_read > 0`) + real cross-tier token counts proven by the gated `ANTHROPIC_API_KEY` integration test (founder demo). Demo: run `npm test` with `ANTHROPIC_API_KEY`+`DATABASE_URL` set → real Haiku/Sonnet/Opus calls logged with token counts + dollar cost, a repeated large prefix shows `cache_read > 0`, and `example-echo`/`example-tool-pinger` run end to end with budget decrementing.
- 2026-06-27 | Phase 2 | ✅ Complete | 42 tests pass against a local Postgres 16 (37 without a DB; e2b integration test gated on `E2B_API_KEY`), lint + typecheck green. Built the `SandboxProvider`/`SandboxHandle` abstraction (`E2BSandboxProvider` + `FakeSandboxProvider`), `runTests` (clone via least-privilege token → `npm ci` → `npm test`, guaranteed teardown), `test_runs` table (migration 003) + `recordTestRun`/`getTestRuns`, `getInstallationToken` (contents:read, single repo), `run_tests` job type + `handleRunTests`, and the `debug:run-tests` trigger. Failing suites record a clean `failed` result; clone/install failures record `error`. Demo: `npm run debug:run-tests -- <installationId> <owner> <repo> <ref>` → worker clones the repo in an E2B microVM, runs its tests, writes a `test_runs` row, and `Sandbox.list()` shows none lingering.
