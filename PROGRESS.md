# Tsukinome — progress log

Keep this current. It's the source of truth for what's done and what's next.

## Phase status

- [x] Phase 0 — Project scaffolding
- [x] Phase 1 — End-to-end loop: webhook → worker → comment
- [x] Phase 2 — Sandbox: checkout & test execution
- [x] Phase 3 — LLM gateway + agent runner
- [x] Phase 4 — Intake & spec (Product Owner), committed artifacts
- [x] Phase 5 — Clarification gate (suspend/resume #1)
- [x] Phase 6 — Code index (CocoIndex retrieval)
- [x] Phase 7 — Architect & plan gate (Definition of Ready)
- [x] Phase 8 — Task decomposition & TDD execution loop (Definition of Done)
- [x] Phase 9 — Reviewer & Integrator → Pull Request  ← MVP heartbeat ✅
- [x] Phase 10 — PR comment → fix loop (bounded)
- [x] Phase 11 — Reliability, security, easy install  ← MVP done ✅

## Outstanding issues (revisit before calling go-live done)

- **⏸️ Non-recoverable transient state (reliability).** A non-budget exception thrown *after* the
  `Planning`/`Implementing` transition can't self-recover — the retry is skipped by the
  `state !== <expected>` guard, stranding the run in the transient state. Harden it (reset-to-prior-state
  on retry, or transition only after the risky step).
- **⏸️ Cost: consider Sonnet-only (drop Opus).** Opus (spec/plan/review) is the priciest tier and
  Pavel flagged per-issue cost as too high for the app. Change is trivial — the three role→model
  constants in `src/llm/models.ts` (triage=Haiku, implementation=Sonnet, review=Opus). **Before
  cutting:** pull the actual `llm_calls` cost breakdown from a real run — Opus mostly hits the
  low-token spec/plan/review calls, so it may be a small share of spend; consider keeping Opus on
  *plan only*. Decide against measured data, not a guess.
- **✅ CocoIndex re-enabled (2026-07-13).** Root cause was **not** the E2B template (CocoIndex runs
  host-side, not in the sandbox) — the host `python3` just never had the deps, and the sidecar was
  written against a **pre-1.0 CocoIndex API** that no longer exists (1.0 was a full rewrite). Fixed:
  added a `COCOINDEX_PYTHON` config knob (points the sidecar at a venv), and **rewrote
  `sidecar/cocoindex_flow.py` for the 1.0 API** — it now uses CocoIndex purely for tree-sitter
  chunking (`ops.text.RecursiveSplitter` + `ops.code.CodeSource`), embeds locally, and writes rows to
  `code_chunks` itself via psycopg (so migration 006 still owns the table; no CocoIndex target
  machinery). Verified end to end against live Neon and the gated integration test passes. See the
  2026-07-13 decision-log entry. Retrieval remains best-effort — with the venv unset the pipeline
  still runs and plans from the spec.

- **⏸️ Bad/unsatisfiable ACs should be caught up front (CocoIndex now available).** An impossible
  acceptance criterion (e.g. "wire into a field that doesn't exist") should be caught by the **Opus**
  Architect, not fail the TDD loop. CocoIndex is now working (above), so the Architect *can* see real
  code — but the AC-reshaping behavior itself isn't implemented yet; the human-help gate remains the
  stopgap. Next step: feed retrieved code into the Architect's reasoning and have it reshape/flag
  impossible ACs before the loop. (Subtler trap to keep in mind: an AC that requires changing
  **already-tested** output is un-greenable because the implementer can't edit existing tests — the
  loop could detect "my change broke a *pre-existing* test" and route back.)

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
- 2026-06-27 (Phase 4): First real agents — `intake` (Haiku) and `product-owner` (Opus) — are just `agents/*.md` instruction files + Zod schemas (`src/pipeline/schemas.ts`) + `ROLES` entries, invoked through `runAgent`. This validates the Phase 3 abstraction: a new agent is one file + one registry line; all invocation/logging/budget plumbing is reused.
- 2026-06-27 (Phase 4): The gateway is now wired into the worker (`index.ts` builds `AnthropicProvider` + `LlmGateway`, passed via `WorkerDeps`). `handleIssueOpened` chains into a new `produce_spec` job after acking; `handleProduceSpec` runs intake → PO → commit → comment.
- 2026-06-27 (Phase 4): **Began the deterministic Integrator** (`src/github/integrator.ts` + new `GitHubClient.commitFile`/`getIssue`/`getRepoLanguage`). Git writes go through deterministic code (ensure branch `tsukinome/issue-<n>` from default branch, create-or-update `.tsukinome/<n>/spec.md` via the contents API) — never an agent. Phase 9 generalizes this for the PR.
- 2026-06-27 (Phase 4): **Language refusal is deterministic in the handler** (via GitHub's detected repo language), not delegated to the intake agent — matches "deterministic where possible" and avoids spending tokens on unsupported repos. Supported = TypeScript/JavaScript; null language → proceed (can't tell). Refusal posts a graceful comment and sets run state `unsupported`.
- 2026-06-27 (Phase 4): Artifacts are persisted in a new `artifacts` table (migration 005), upserted on `(run_id, kind)` — the source of truth, re-read by later phases. `handleProduceSpec` is idempotent on the presence of a `spec` artifact (no duplicate LLM spend / commit / comment on retry).
- 2026-06-27 (Phase 4): Budget is enforced for free by the gateway — a `BudgetExhaustedError` mid-pipeline is caught, posts a "stopped — budget" comment, and sets run state `failed` (graceful stop, exit criterion 3).
- 2026-06-27 (Phase 4): New `RunState`s: `specifying`, `specified`, `unsupported`. New job type `produce_spec` (+ `ProduceSpecPayload`).
- 2026-06-27 (Phase 4): Added `Buffer` to the eslint globals (used for base64-encoding file content in `commitFile`).
- 2026-06-27 (Phase 4): **Full repo-commit path is verified manually** (needs a real repo + `contents:write`), not in an automated integration test. The gated `ANTHROPIC_API_KEY` test proves the real intake + PO agents produce confidence-tagged, GWT specs with cost logged within budget; the commit/comment orchestration is unit-tested with fakes.
- 2026-06-27 (Phase 5): **`Specified` redefined** to mean "spec finalized, clarification gate passed" (was "spec drafted"). The gate now sits between drafting and `Specified`, which makes every step idempotent via a state guard alone: `produce_spec` skips on an existing `spec` artifact and now leaves the run in `Specifying` + enqueues a `clarify` job; `clarify` runs only from `Specifying`; `resume_clarification` runs only from `AwaitingClarification`. The Phase-4 produce-spec test was updated to expect `Specifying` + a chained `clarify` job.
- 2026-06-27 (Phase 5): **Clarifier is one new agent** (`agents/clarifier.md` + `clarificationSchema` + one `ROLES` entry, tier `triage`/Haiku) — again proving "new agent = one file + one registry line". It returns *every* genuine question; the **cap (4) is enforced in code**, not by the model (LLM produces the artifact, the orchestrator decides pass / ask / bounce — per the constitution). 0 questions → `Specified`; 1–4 → one batched comment + park `AwaitingClarification`; >4 → "too underspecified" bounce → `Failed`.
- 2026-06-27 (Phase 5): **Finalize reuses the existing `product-owner` role** (no new agent) — on resume it's given the draft spec markdown + the questions asked + the human's reply and re-emits the full `Spec` with upgraded confidence tags.
- 2026-06-27 (Phase 5): **Suspend/resume primitive.** Suspend = park the run and leave no job running (the worker just finds an empty queue and goes idle); state is persisted, never in-memory. Resume is webhook-driven: `issue_comment.created` from a **human** (bot comments ignored via `comment.user.type === 'Bot'`, so we never resume on our own question) on a run in `AwaitingClarification` enqueues `resume_clarification`. New job types `clarify` / `resume_clarification` (+ payloads); deliveries deduped via `processed_events`.
- 2026-06-27 (Phase 5): **No migration** — added `Store.updateRunContext` writing the *existing* `runs.context` jsonb (mirrors `updateRunState`). Used to persist the asked questions (and spec meta `{title, classification}` saved at produce-spec time, since resume doesn't re-run Intake) so resume reloads state instead of re-deriving it. Round-trip unit-tested on `InMemoryStore`; the gated PgStore SQL test runs in CI (no local Postgres this session).
- 2026-06-27 (Phase 5): Budget is enforced for free by the gateway in both new handlers — a `BudgetExhaustedError` posts the "stopped — budget" comment and sets `Failed` (graceful stop), same as Phase 4.
- 2026-06-27 (Phase 5): **Known idempotency window (defer to Phase 11):** in `clarify`/`resume_clarification` the comment is posted before the state advances, so a crash in that narrow window can re-post on retry — the same accepted class as Phase 1/4. Run-state guards prevent any double action on a fully-completed job or duplicate webhook.
- 2026-06-27 (Phase 6): **Scope decision (founder).** Code index is **per-run**, NOT incremental: clone repo to a temp dir → CocoIndex AST-chunks + embeds → pgvector namespaced per repo/run → agents query during the run → vectors + checkout torn down after. **No incrementality / persistent checkout / tracking tables** — incremental re-embedding is explicitly **post-MVP**. `docs/implementation-plan.md` Phase 6 exit criterion #2 updated accordingly (deferred), replaced by per-run namespacing + clean teardown (no cross-repo leak). Locked decision unchanged: **CocoIndex sidecar**, now behind a `CodeIndex` interface.
- 2026-06-27 (Phase 6): **`CodeIndex` is our interface; CocoIndex is the engine behind it** — same DI split as `Store`/`SandboxProvider`/`LlmProvider`. `indexRepo` / `retrieve` / `dropNamespace`. `FakeCodeIndex` (in-memory, deterministic chunker + `FakeEmbeddingProvider`) drives CI unit tests and is what the Phase-7 worker tests will use; `PgVectorCodeIndex` is the real impl.
- 2026-06-27 (Phase 6): **Ingestion vs retrieval split for testability.** Retrieval = a pgvector cosine-ANN query owned in TS (`PgVectorCodeIndex.retrieve`, `<=>` distance → `1 - dist` score), unit-tested in CI by inserting chunks with the deterministic `FakeEmbeddingProvider` (model-agnostic) — proves ranking, per-namespace scoping (no leak), path-prefix scoping, and teardown. Ingestion (the CocoIndex Python sidecar) is a **gated integration** (`COCOINDEX_TEST=1` + a pgvector DB), verified locally/in the demo, like E2B/Anthropic — never in CI.
- 2026-06-27 (Phase 6): **Embeddings are local, in-process** (`sentence-transformers/all-MiniLM-L6-v2`, 384-dim → `vector(384)`), so indexing cost is ~$0 and stays **off** the `LlmGateway`/`llm_calls` accounting path by design (no uninstrumented *paid* call introduced — keeps the one-click-install goal too). Document + query embeddings share the model: the sidecar exposes both `index` and `query-embed` modes; `SidecarEmbeddingProvider` embeds queries via the same model for symmetry.
- 2026-06-27 (Phase 6): **Migration 006** enables `CREATE EXTENSION vector` + a `code_chunks` table (namespace, path, start/end line, content, `vector(384)`) with a btree on `namespace` and an HNSW `vector_cosine_ops` index. CI's Postgres service image switched `postgres:16` → `pgvector/pgvector:pg16` so the migration + retrieval tests run in CI.
- 2026-06-27 (Phase 6): **Host-side clone for indexing** (`src/index/checkout.ts`, `cloneToTempDir`) — distinct from Phase 2's in-sandbox clone — justified because indexing only **reads** files (chunk + embed); repo code is **never executed** here. Temp dir removed after the run; the clone token is redacted from any error (`redactToken`, unit-tested).
- 2026-06-27 (Phase 6): **Not wired into the live pipeline yet** (like the Phase 3 gateway) — `CodeIndex` is the platform; the worker consumes it in **Phase 7** (index on run start, Architect `retrieve`, teardown at run end). Wiring `index.ts` now would be dead code. Demo path is `npm run debug:index-repo -- <installationId> <owner> <repo> [ref] [query...]`.
- 2026-06-27 (Phase 6): **The CocoIndex `sidecar/cocoindex_flow.py` is the one piece not exercisable here** (no Python/pgvector in this session) — it's the Phase-6 analogue of `e2b-sandbox.ts` (verified against the live service, not CI). Its exact CocoIndex API surface is confirmed during the gated run; everything testable (interface, fakes, pgvector retrieval SQL, namespacing, teardown, token redaction) is unit/CI-tested.
- 2026-06-27 (Phase 7): **`Specified` now chains into planning.** Both transitions to `Specified` (`handleClarify` 0-questions + `handleResumeClarification` finalize) enqueue a `produce_plan` job. New states used: `Planning` (transient), `AwaitingPlanApproval` (parked), `Implementing` (approved — terminal-for-now until Phase 8), `Aborted`. New jobs `produce_plan` / `resume_plan_decision`.
- 2026-06-27 (Phase 7): **Architect is one new agent** (`agents/architect.md` + `planSchema` + one `ROLES` entry, tier `review`/Opus). Output: summary, approach, affectedFiles[{path,change,reason}], contracts[], dataChanges[], testStrategy[]. `commitPlan` added to the deterministic Integrator → `.tsukinome/<n>/plan.md` on the same working branch; artifact kind `plan`.
- 2026-06-27 (Phase 7): **Retrieval is handler-driven pre-retrieval, not a model tool.** `runAgent`'s tools are static (registry-defined, can't bind per-run state), so `runArchitectAndCommit` does one `retrieve()` (query = spec summary + requirements) and passes the ranked chunks into the Architect's single-shot prompt. Keeps retrieval scoped/cost-controlled and unit-testable. A retrieve *tool* for the tool-loop is a future option, not built.
- 2026-06-27 (Phase 7): **CodeIndex (Phase 6) wired into the live worker.** `WorkerDeps` gains `codeIndex` + `cloneRepo`; `index.ts` constructs `PgVectorCodeIndex(pool, SidecarEmbeddingProvider, CocoIndexSidecarRunner)` + `cloneToTempDir`. **Index lifecycle = per plan-production step:** clone working branch → `indexRepo` → `retrieve` → Architect → `commitPlan`, then **`finally` drops the namespace + deletes the checkout** so vectors never sit through the (possibly multi-day) approval gate. Phase 8 re-indexes when implementing. Tests inject a spy `fakeCodeIndex` + `fakeCloneRepo` (no DB/Python/git/filesystem).
- 2026-06-27 (Phase 7): **DoR is mechanical + bounded (no loop).** `definitionOfReady(spec)` checks open questions empty (critical) + ≥1 acceptance criterion + non-goals stated. On failure with open questions, `produce_plan` posts a comment and routes back to the clarification gate **once** (guarded by `context.dorReclarified`); a second failure stops gracefully (`Failed`). Structured spec is persisted in `context.specData` (produce_spec + resume) so DoR has structured access without re-parsing markdown.
- 2026-06-27 (Phase 7): **Plan gate resume.** `app.ts` `issue_comment` now routes by parked state: `AwaitingClarification` → `resume_clarification` (Phase 5), `AwaitingPlanApproval` → `resume_plan_decision`. `parsePlanDecision`: `/approve` → `Implementing`, `/abort` → `Aborted`, anything else → change request → regenerate the plan with the feedback, bounded by `PLAN_REVISION_CAP = 3` (beyond which it asks the human to /approve or /abort). Budget-aware everywhere (graceful `Failed`).
- 2026-06-27 (Phase 8): **The core TDD engine** (`src/pipeline/tdd.ts`) is pure orchestration over injected interfaces (`CodeSandbox` + the gateway), so the three exit criteria are unit-tested with fakes. Per task: Test Author → write tests → **must go red** (a test that passes pre-impl is rejected — TDD ordering enforced in code); Implementer → **must go green** (full suite); Refactor → best-effort, **reverted if it breaks green**. DoD = tests exist + red-before + green-after + suite green.
- 2026-06-27 (Phase 8): **Escalation ladder** — each stage retries on Sonnet (`SONNET_ATTEMPTS=2`) then promotes to Opus (`OPUS_ATTEMPTS=1`) via a new `runAgent` **tier override**, then **escalates to a human** (comment + graceful `Failed`) rather than looping. Budget is enforced by the gateway throughout and checked at each task boundary; exhaustion stops gracefully at a safe point.
- 2026-06-27 (Phase 8): **Whole-file edits, not diffs** — Test Author / Implementer / Refactor share `fileSetSchema` (`{ files: [{path,content}] }`); the orchestrator writes them to the sandbox. Deterministic and testable; no patch parsing.
- 2026-06-27 (Phase 8): **Per-task commits** via a new deterministic Integrator `commitFiles` (git Trees API: blobs-inline → tree → commit → update ref) on the working branch — reused by Phase 9 for the PR. One commit per task, message `Tsukinome: <task> (#<n>)`.
- 2026-06-27 (Phase 8): **Persistent sandbox session** (`src/sandbox/code-sandbox.ts`, `CodeSandbox`): clone + `npm ci` once, then write/run/read iteratively, built on the Phase-2 `SandboxProvider`/`runCommand` via base64 transfer (**no new `SandboxHandle` methods**). Real impl is gated like E2B; the engine + handler are tested with `FakeCodeSandbox` (in-memory FS + scripted red/green). The opener is **injected** (`openSandbox` in `WorkerDeps`) so handler tests script the TDD sequence the substring sandbox fake can't.
- 2026-06-27 (Phase 8): **Agent context = direct sandbox file reads** (current contents of the plan's affected paths) + spec + plan + task — **not** the vector index. Editing needs the real file, not chunks; the Phase 6/7 index stays a discovery/planning tool. No re-indexing in Phase 8 (avoids deferred incrementality). Structured plan persisted to `context.planData` (Phase 7) so the loop knows the affected paths.
- 2026-06-27 (Phase 8): **Pipeline wiring.** `/approve` → `Implementing` + enqueue `implement`. `handleImplement` decomposes (Decomposer, Sonnet) → persists `tasks` (migration 007), runs the loop committing per task, advances to `Reviewing` (terminal-for-now; Phase 9). Restartable: only runs from `Implementing`, skips `done` tasks (the fresh clone of the working branch already has their commits); escalated runs stay `Failed` (need a human). Sandbox always closed (`finally`). New job type `implement`; four new roles (decomposer/test-author/implementer/refactor) on the implementation tier.
- 2026-06-28 (Phase 9): **MVP heartbeat achieved — issue in → reviewed PR out.** `Reviewing` chains a `review` job: Reviewer (Opus) self-reviews spec + plan + diff, then the deterministic Integrator opens the PR → state `AwaitingPrReview`. One new agent (`agents/reviewer.md` + `reviewSchema` + registry entry).
- 2026-06-28 (Phase 9): **Reviewer is advisory, not a blocking gate** (avoids unbounded self-revision — change requests are Phase 10's fix loop). The verdict (`approve`/`request_changes`) + findings are recorded in the PR body and an issue comment for the **audit trail**; the PR opens regardless. The bug-fix "needs a test that fails on pre-change behavior" rule lives in the reviewer instructions and surfaces as a `blocker` finding.
- 2026-06-28 (Phase 9): **No sandbox in review** — the diff comes from the GitHub compare API (`compareCommitsWithBasehead`, base = default branch … head = working branch). Tests were already green from Phase 8 (the loop only commits green states), so no re-run is needed.
- 2026-06-28 (Phase 9): **All git/PR writes stay in the deterministic Integrator** — `GitHubClient.openPullRequest` (idempotent: reuses an existing open PR for the head branch) + `compareDiff`, wrapped by `openPullRequestForIssue`. The Reviewer agent only reads the diff; it never writes. Exit criterion "no agent has write access" holds.
- 2026-06-28 (Phase 9): Artifacts were already committed across phases (spec Phase 4, plan Phase 7, code Phase 8) on `tsukinome/issue-<n>`, so Phase 9's only repo write is opening the PR. PR body summarizes spec/plan/**assumptions** + the self-review and says `Resolves #<n>`. New job type `review`; terminal state `AwaitingPrReview` (Phase 10 resumes on PR comments). Budget-aware (graceful `Failed`).
- 2026-06-28 (Phase 10): **PR review comment → bounded test-first fix.** Triggers: `pull_request_review_comment.created` (inline) + `pull_request_review.submitted` `changes_requested`. The PR is mapped back to its run by **parsing the head branch** (`issueNumberFromBranch` reverses `specBranch`) — no extra storage. Bots ignored, deliveries deduped, only acts on a run parked at `AwaitingPrReview`.
- 2026-06-28 (Phase 10): **`fix-triage` agent (Haiku)** classifies each comment → `actionable | vague | rework`. **vague** → one clarifying reply, no code change, no round consumed (prefers asking over guessing). **rework** → reply + route back to the **plan gate** (set `AwaitingPlanApproval` + enqueue `resume_plan_decision` with the comment → Phase 7's change-request path regenerates the plan). **actionable** → fix it.
- 2026-06-28 (Phase 10): **Actionable fixes reuse the Phase-8 TDD loop** — the comment becomes a single fix `TaskSpec` run through `runTaskTdd` in a fresh `CodeSandbox` over the working branch (TDD preserved: behavior change → test red → green), committed via `commitTaskFiles`, with a thread reply. Scope = the comment's file (direct sandbox read, not vector retrieval) — "don't reload the whole repo". Pushing the commit re-runs the user's CI automatically.
- 2026-06-28 (Phase 10): **Bounded** — `FIX_ROUND_CAP = 3` per run (tracked in `context.fix.rounds`) + the shared per-run budget. Over the cap, a fix the TDD loop can't land, or budget exhaustion → **escalate to a human** (reply + graceful `Failed`), never loops. Replies go inline (`replyToReviewComment`) for inline comments, else on the PR conversation. Sandbox always closed. New job type `fix`.
- 2026-06-28 (Phase 10): **Deviation** — the standalone `/fix` PR-conversation comment trigger is deferred (it needs a PR-number→run reverse lookup the store doesn't have); the review-comment + changes-requested-review paths satisfy the exit criteria.
- 2026-06-28 (Phase 11): **Job retries = lease + backoff in the Store.** `claimNextJob(leaseMs)` now claims a due `queued` job (`available_at <= now()`) OR reclaims an `in_progress` job whose worker died (lease `locked_at` older than `leaseMs`, default 5 min) — one race-safe round trip (`FOR UPDATE SKIP LOCKED`). `failOrRetryJob` re-queues with exponential backoff (`computeBackoffMs`, base 30s, cap 5 min, in `src/worker/retry.ts`) until `MAX_JOB_ATTEMPTS = 3`, then dead-letters. Migration 008 adds `jobs.available_at` + a `(status, available_at, id)` claim index and a `(status, locked_at)` lease index. The worker's catch now calls `failOrRetryJob`; on dead-letter it posts a graceful failure comment (best-effort, via the payload's issue coords) so a crash never hangs silently.
- 2026-06-28 (Phase 11): **Stale-run sweep (ping → park → close)** lives in `src/worker/stale.ts` (`sweepStaleRuns(deps, now)`), wired into `startWorker` as an independent hourly `setInterval`. A run parked in a human gate (`AwaitingClarification`/`AwaitingPlanApproval`/`AwaitingPrReview`) gets one reminder after **3 days** and is closed (`Aborted`) after **7**. `runs.stale_pinged_at` (migration 008) tracks the ping **separately from `updated_at`**, so `markRunPinged` does NOT reset the staleness clock — a pinged run still closes on schedule. `now` is injected for deterministic tests; `Run` now carries `updatedAt`/`stalePingedAt` (epoch ms).
- 2026-06-28 (Phase 11): **Cost is surfaced + measured.** `renderCostSummary` (`src/pipeline/cost.ts`) rolls calls up per role (cache tokens counted as input, costliest role first) into a markdown block shown in the **PR body** and the **PR-opened issue comment** (founder's choice). `getCostMetrics()` aggregates `runs.spent_nano_usd` → `{runCount,totalNanoUsd,avgCostNanoUsd}` (the measured avg cost/issue that replaces the planning estimate), exposed via `npm run debug:cost-metrics`. Budget knob: `RUN_BUDGET_USD` (dollars → nano-USD in `config.ts`, default $1.00) applied via `setRunBudget` the once a run is created in `handleIssueOpened`.
- 2026-06-28 (Phase 11): **Security pass is documented + regression-tested.** `docs/security.md` records the four pillars; `test/security/boundary.test.ts` pins the load-bearing ones — no agent role carries a write-capable tool (only the `ping` stub; all real roles are schema-only), the exported `CONSTITUTION` still declares external text untrusted DATA, and `redactToken` strips the clone token. The integrator wall, least-privilege `contents:read` clone token, and bot-comment handling were already in place from earlier phases.
- 2026-06-28 (Phase 11): **Install UX needs no per-repo files.** README rewritten product-first (flow, gates, config table, observability) + `docs/setup.md` (GitHub App perms: contents/issues/PRs r-w + metadata r; events: issues, issue_comment, pull_request_review, pull_request_review_comment; env table; migrate/run/deploy). `.env.example` stays absent (blocked by this env's permission settings, as since Phase 2) — the env table is the source of truth.
- 2026-07-12 (post-go-live): **Closed the go-live blockers — the issue→PR loop now runs end to end
  and produced its first live PR.** Fixes (full detail in git history), TDD gate unchanged throughout:
  - **Decomposition right-sizing** — a cohesive change is one task; split only where pieces are
    separately observable through the public surface. Ladder raised to Sonnet 3 / Opus 2.
    (`agents/decomposer.md`, `src/pipeline/tdd.ts`)
  - **Test-failure feedback** — `runTaskTdd` threads the previous run's `outputTail` back into the
    implementer/test-author retry and surfaces it in the escalation comment (it was discarded, so
    retries were blind and failures invisible). (`tdd.ts`, `implement.ts`, `fix.ts`)
  - **Human-help gate** — a stalled task parks at `AwaitingImplHelp` and asks for guidance (or
    `/abort`) instead of dead-ending; guidance threads into the retried task, bounded by
    `IMPL_HELP_CAP = 3`; red→green gate still holds. New job `resume_implementation`; added to
    `STALE_STATES`. Fix-loop escalation still dead-ends (deferred).
  - **Sandbox Node** — `E2BSandboxProvider` takes an optional `E2B_TEMPLATE`; built the `tsukinome-node22`
    template (`e2b.Dockerfile`, `FROM node:22`) so the sandbox's `npm test` doesn't fail at import on
    old Node. `engines >=22.12`, `.nvmrc`, logs the template at sandbox creation.
  - **Test placement** — `runTaskTdd` reads the target repo's test-runner config (`readTestConventions`)
    and tells the test-author where the runner collects tests (it was writing `src/`-co-located tests
    that vitest's `include: ['test/**']` never ran → vacuously green). (`agents/test-author.md`)
  - **Ops** — console logger wired through (Probot's was null); CocoIndex retrieval made best-effort.
    All green (197 pass / 23 skip), typecheck + lint clean.
- 2026-07-13 (post-go-live): **Repo context for the agents + cheaper TDD loop.** A live run stalled
  because the test-author wrote `test/costSummary.test.ts` importing `../../src/costSummary` (correct
  is `../src/costSummary`) — it copied the `../../src/` depth from this repo's *nested* tests without
  adjusting for a top-level file. An unresolvable import fails the suite to *load*, which the loop
  reads as a valid TDD red, so the implementer is handed a task it can never green (it can't edit the
  test) → escalate. A **false red**. Fixes:
  - **Repo-map backbone** (`src/pipeline/repo-map.ts`): a cheap structural view (file tree via
    `git ls-files` + summarized package.json), distinct from CocoIndex's semantic retrieval (map =
    structure, retrieval = depth). Injected into the **Architect** (plan step — addresses "the
    architect plans blind from the issue"; it already had the checkout, so free) and the
    **test-author + implementer** (from the sandbox).
  - **Test-author gets real example test files** (`gatherRepoContext` in `tdd.ts` via a new
    `CodeSandbox.listFiles`) + an explicit **import-resolution rule** ("compute the relative import
    from your file's own location; an unresolvable import is a FALSE red the implementer can't fix").
    `agents/test-author.md` updated to match.
  - **TDD loop is Sonnet-only now**: `SONNET_ATTEMPTS=2`, `OPUS_ATTEMPTS=0` (was 3/2). Opus removed
    from the escalation ladder — too expensive for this stage; a task Sonnet can't land twice (with
    the failure fed back) is usually a context/spec problem for a human, not a job for a pricier model.
  - **Deferred (next step): spec + clarifier repo map.** Same map for intake/PO/clarifier needs a
    spec-time clone of the *default* branch (the working branch doesn't exist yet) + default-branch
    resolution — new surface on a stage that wasn't the failure, so held for a follow-up. All green
    (206 pass / 23 skip, typecheck + lint clean).
- 2026-07-13 (post-go-live): **CocoIndex re-enabled by rewriting the sidecar for the CocoIndex 1.0
  API.** The live `ModuleNotFoundError` was a host-side dep gap, not an E2B-template issue (CocoIndex
  runs host-side). Deeper cause: `sidecar/cocoindex_flow.py` was written from stale (pre-1.0)
  training knowledge — by the time it was authored CocoIndex had already shipped 1.0, a full rewrite
  that removed `flow_def`/`sources`/`functions`/`targets`/`init`. Changes:
  - **`COCOINDEX_PYTHON` config knob** (`src/config.ts`, threaded into `src/index.ts` +
    `scripts/debug-index-repo.ts` + the gated test) points the sidecar at a venv interpreter with the
    deps; unset → bare `python3` and retrieval degrades gracefully. TDD (test in `test/config.test.ts`).
  - **Sidecar rewritten for 1.0**: uses CocoIndex *only* for tree-sitter chunking
    (`cocoindex.ops.text.RecursiveSplitter` + `cocoindex.ops.code.CodeSource`), embeds locally with
    `SentenceTransformer` in a plain sequential loop (the 1.0 reactive-component `App`/`mount` model
    is overkill for a one-shot batch job, and calling the model outside CocoIndex's native parallel
    executors sidesteps a torch-on-macOS segfault), and INSERTs rows into `code_chunks` itself via
    **psycopg**. `code_chunks` stays owned by migration 006 — CocoIndex never manages the table, so
    the shared per-namespace design and TS `dropNamespace` teardown are untouched.
  - **requirements.txt** pins `cocoindex>=1.0,<2` and adds `psycopg[binary]`. `.venv/` gitignored.
  - **Verified end to end** against live Neon: indexed this repo's `src/` (40 files → 214 chunks),
    retrieval ranks `server.ts`/`index.ts` top for an http-server query; the gated integration test
    (`COCOINDEX_TEST=1`) passes in ~24s. Build stays green (200 pass / 23 skip, typecheck + lint clean).
- 2026-07-14 (post-go-live): **Test Author / Implementer context now caches — the top spender's big
  payload was being re-billed uncached.** Cost analysis had flagged `test-author` as the priciest
  stage: prompt caching only marked the *system* prefix (`CONSTITUTION` + instruction), so the large
  **user-message** it carries (spec + plan + repo map + example tests + runner config + import rule +
  current files) was billed at full input price on every ladder attempt and every task, even though
  nearly all of it is identical across them. Billing-only change — the TDD gate and all behavior are
  unchanged. Fixes:
  - **`TextBlock` now accepts `cacheControl?: 'ephemeral'`** (`src/llm/types.ts`) and
    `AnthropicProvider.toSdkBlock` maps it to `cache_control` (`src/llm/anthropic-provider.ts`),
    mirroring the existing `SystemBlock` handling. This adds a **second cache breakpoint** on the user
    message, on top of the system prefix.
  - **`runTaskTdd` splits both the Test Author and Implementer user messages** (`src/pipeline/tdd.ts`)
    into a cached **run-stable prefix** (spec, plan, repo map, example tests, conventions, import rule)
    + an **uncached tail** (per-task header + maintainer guidance, current files, retry feedback). The
    run-stable prefix is **reordered ahead of the per-task task header**, so it's byte-identical across
    every task in a run and caches across all of them — not just across a single task's retries.
  - **Example tests trimmed to file path + import lines** (`renderExampleImports`), not whole file
    bodies — the author only needs the repo's exact import style + relative-path depth; the bodies
    were dead weight re-billed on every attempt.
  - Unit tests assert the stable block ships with `cacheControl: 'ephemeral'` and the variable tail
    without it (for both roles), that the task header/current files stay out of the cached prefix, and
    that example-test bodies are dropped while imports are kept. Full suite green (**209 pass / 23
    skipped**), typecheck + lint clean. Expect `cache_read_tokens` to rise / `test-author` spend to
    fall on the next live run — verify against real `llm_calls` numbers.
- 2026-06-28 (Phase 11): **PgStore SQL (migration 008 + the five new methods) verified against a real `pgvector/pgvector:pg16` Postgres** — migrations applied clean (008 included) and all 13 gated PgStore tests pass, covering retry-backoff/dead-letter, lease recovery, stale listing + ping, and cost aggregation. They `skipIf(!DATABASE_URL)` so local `npm test` stays green with no DB; CI runs them too.

## Go-live (2026-07-12)

First bring-up against live services (Neon Postgres, Anthropic, E2B) with the GitHub App
installed on this repo as the dogfood target. Local run via `npm run dev` + smee proxy.

**What ran green.**

- Build: typecheck + lint clean; `npm test` 189 pass / 23 skip.
- Migrations: `npm run migrate up` applied all 8 migrations to Neon (incl. the `vector` extension
  and the Phase-11 reliability columns). No pooler/DDL issue on the connection string in `.env`.
- Gated integration tests (run with `.env` loaded) — **all pass in isolation**: Anthropic 4/4
  (incl. prompt-cache `cache_read > 0` and a real intake+PO spec), PgStore 13/13, pgvector 4/4,
  E2B 1/1. CocoIndex sidecar test stays skipped (needs `COCOINDEX_TEST=1` + a Python sidecar).
  Running *all* gated suites at once against the single shared Neon DB shows two false failures
  (`getCostMetrics`/`getLlmCalls` see rows from concurrent suites) — a shared-DB artifact, not a
  code defect; CI isolates per run.

**Live run.** First bring-up drove ack → draft spec → clarification → `plan.md` → `/approve` →
decomposition → TDD loop, then escalated on the first TDD task. The follow-up fixes (see the
2026-07-12 Decision log entry) closed those blockers; the loop now runs **end to end and produced its
first live PR**.

**Bugs found & fixed** (committed on branch `fix/go-live-runtime-fixes`, commit `703b129`; not yet
merged to `main`). All were gaps the scripted unit-test fakes hid:

1. **Null logger** — `probot.log` is `null` under our Probot version, so the gateway/worker/app
   crashed on the first `log.info` (the gateway recorded the LLM cost, then threw). This is why the
   first `produce_spec` charged tokens but kept failing/retrying. Fixed: added
   `createConsoleLogger()` in `src/log.ts`, wired through `src/index.ts` instead of `probot.log`.
2. **CocoIndex hard-dependency** — `produce_plan` called the Python sidecar unconditionally and
   `ModuleNotFoundError: No module named 'cocoindex'` failed the job; the retry then stranded the
   run in `planning` (state-guard skips it). Fixed: `runArchitectAndCommit` treats code retrieval
   as best-effort and plans from the spec when the index is unavailable — matching
   `docs/setup.md`'s "runs without CocoIndex" promise. (Installing the sidecar later restores
   richer plan-time retrieval; optional.)
3. **Decomposer prompt** — produced un-runnable task shapes (a test-only task, then a 17-AC
   monolith). Fixed `agents/decomposer.md`: forbid test-only tasks (the harness writes the failing
   test per task) + right-sizing guidance (3–6 tasks, ~1–3 ACs each). Improved the decomposition
   but did **not** resolve the deeper blocker (see Outstanding issues).
4. **E2B test drift** — `Sandbox.list()` now returns a paginator, not an array; fixed the
   integration assertion in `test/sandbox/e2b.integration.test.ts`.

**Cost (measured, not clean).** Issue #4 / run #2 spent **~$0.89** of budget before escalating —
inflated by go-live debugging (failed logger retries, failed CocoIndex plan retries, and three
decomposition attempts). Not a representative per-issue figure; get a clean number from a
successful run once the blocker is resolved. Per-call audit remains in `llm_calls`.

**Deviations / notes.**

- Budget for run #2 was raised to $2.00 during debugging to give the retries headroom (default is
  $1.00 via `RUN_BUDGET_USD`).
- The gated integration tests wrote a few orphan rows to the **live Neon DB** (e.g. run #1 /
  issue #42 from the Anthropic suite). Harmless (no jobs attached) but worth a cleanup pass.
- Local run helper added: `scripts/start-tsukinome.sh` (starts server + smee, Ctrl+C stops both) —
  currently untracked.
- Per `CLAUDE.md`, `docs/implementation-plan.md` was **not** modified (Phase 12 / BYO-key stays
  deferred). This was go-live, not a new build phase.

## Session log

(Append a line per phase: date, phase, outcome, demo.)

- 2026-06-26 | Phase 0 | ✅ Complete | 14 tests pass, lint + typecheck green, `/health` returns 200, Probot webhooks wired + tested, migration harness ready, CI workflow added.
- 2026-06-26 | Phase 1 | ✅ Complete | 29 tests pass (incl. 4 real PgStore integration tests verified against a local Postgres 16), lint + typecheck green. Built `jobs`/`runs`/`processed_events` schema (migration 002), `Store` interface + Pg/in-memory impls, polling worker, `issues.opened` → enqueue → worker posts "Tsukinome has picked this up" → run advances `received`→`acknowledged`. Idempotency: duplicate deliveries deduped; reprocessing a completed job posts no second comment. CI gained a Postgres service + `migrate up`. Demo: open an issue on the test repo → App comments.
- 2026-06-28 | Phase 11 | ✅ Complete (MVP done) | 189 tests pass (23 gated-skipped), lint + typecheck green. Built job retries (lease-aware `claimNextJob` + `failOrRetryJob` with exponential backoff → dead-letter + graceful comment; `src/worker/retry.ts`), the stale-run sweeper (`src/worker/stale.ts`, ping 3d → close 7d as `Aborted`, hourly in `startWorker`), cost observability (`renderCostSummary` in PR body + issue comment; `getCostMetrics` + `debug:cost-metrics`), the `RUN_BUDGET_USD` config knob (applied at run creation), a security pass (`docs/security.md` + `test/security/boundary.test.ts`), migration 008 (`jobs.available_at` + claim/lease indexes, `runs.stale_pinged_at`) with both stores implementing the expanded `Store` contract, and rewrote the README + added `docs/setup.md`. Exit criteria: fresh install needs no per-repo config (setup guide, artifacts on the working branch) (1); duplicate deliveries/worker restarts don't double-act (run-state guards + dedupe + lease reclaim, regression-tested) (2); each run emits a cost summary + measured avg cost/issue recorded (3); failures (budget, crash, abandonment) leave a clear comment + clean state, never a silent hang (4). Migration 008 + all 13 PgStore tests verified against a real pgvector Postgres (206 pass with `DATABASE_URL` set). Demo: open an issue → clarify → `/approve` → PR with a cost summary in its body + a cost comment on the issue; kill the worker mid-job → it's reclaimed and completes; `debug:cost-metrics` prints the measured avg.
- 2026-06-28 | Phase 10 | ✅ Complete | 159 tests pass (19 gated-skipped), lint + typecheck green. Built the `fix-triage` role (Haiku) + `fixTriageSchema`, `replyToReviewComment` on the client + `issueNumberFromBranch` in the Integrator, fix-loop rendering (`src/pipeline/fix.ts`, `FIX_ROUND_CAP=3`), `handleFix` (triage → actionable/vague/rework, bounded by cap + budget, reusing Phase-8 `runTaskTdd` + `commitTaskFiles` + `openCodeSandbox`), and the two PR-review webhooks (`pull_request_review_comment.created` + `pull_request_review.submitted` changes-requested) mapping the PR to its run via the head branch. Exit criteria covered by fakes: an actionable comment → test-first fix commit + thread reply within the cap (1); cap/TDD-failure/budget → escalate to a human, no loop (2); a vague comment → one clarifying question, no change (3). Demo: leave an inline review comment on an open Tsukinome PR → a test-first fix commit + thread reply appears, CI re-runs; vague → a question; a 4th round → human escalation; rework → back to the plan gate.
- 2026-06-28 | Phase 9 | ✅ Complete (MVP heartbeat) | 142 tests pass (19 gated-skipped), lint + typecheck green. Built the `reviewer` role (Opus) + `reviewSchema`, `compareDiff` + idempotent `openPullRequest` on the GitHub client + `openPullRequestForIssue` Integrator wrapper, PR/comment rendering (`src/pipeline/review.ts`), and `handleReview` (review the diff → open the PR → comment → `AwaitingPrReview`), chained from `handleImplement`. Exit criteria covered by fakes: the run opens exactly one PR with a body summarizing spec/plan/assumptions + self-review and `Resolves #<n>`; only the Integrator writes (no agent write access); advisory review opens the PR on either verdict; idempotent + budget-aware. **Issue in → reviewed PR out.** Demo: open an issue → answer clarifications → `/approve` → an open PR appears on the test repo with `spec.md`/`plan.md` + test-first commits on `tsukinome/issue-<n>`; run → `awaiting_pr_review`.
- 2026-06-28 | Phase 8 | ✅ Complete | 133 tests pass (19 gated-skipped), lint + typecheck green. Built the TDD execution engine (`src/pipeline/tdd.ts`: decompose + per-task red→green→refactor with DoD gate + Sonnet→Opus→human escalation ladder), the `CodeSandbox` persistent session (`src/sandbox/code-sandbox.ts`, base64 over Phase-2 runCommand) + `FakeCodeSandbox`, `runAgent` tier override, four roles (decomposer/test-author/implementer/refactor) + `taskListSchema`/`fileSetSchema`, `tasks` table (migration 007) + Store CRUD, deterministic `commitFiles` (git Trees API) + per-task `commitTaskFiles`, and `handleImplement` (decompose → loop → commit per task → `Reviewing`; escalation/budget → graceful `Failed`; restartable; sandbox always closed). `/approve` now enqueues `implement`. Exit criteria proven by fakes: multi-task red→green→commit per task with suite green (1); impossible task escalates instead of looping (2); a task whose tests pass pre-impl is rejected (3). Demo: approve a plan → worker commits a test-first commit per task to `tsukinome/issue-<n>`, suite green, run → `reviewing`; an impossible task escalates with a clear comment.
- 2026-06-27 | Phase 7 | ✅ Complete | 118 tests pass (18 gated-skipped), lint + typecheck green. Built the `architect` role (Opus) + `planSchema`, plan rendering + DoR + decision parsing (`src/pipeline/plan.ts`), `commitPlan` in the Integrator, the `produce_plan` + `resume_plan_decision` job types/handlers (DoR gate, scoped retrieval via the now-wired `CodeIndex`, plan commit, human approval gate with `/approve` `/abort` and bounded change-request regeneration), the `issue_comment` plan-gate routing, and wired Phase 6's `CodeIndex` + `cloneRepo` into the worker/`index.ts`. Index is indexed→retrieved→torn down per plan-production step (never across the approval park). Exit criteria covered by fakes: a plan file is produced, committed to `.tsukinome/<n>/plan.md`, presented (spec+plan) and the run parks `awaiting_plan_approval`; `/approve` → `implementing`, change request → re-generated + re-presented, `/abort` → `aborted`; a spec with open questions can't reach the gate (DoR routes back to clarification). Demo: clarified issue → plan.md committed + spec+plan comment + park; reply `/approve` to advance, describe changes to revise, `/abort` to close.
- 2026-06-27 | Phase 6 | ✅ Complete | 96 tests pass (18 gated-skipped: pgvector + CocoIndex + Anthropic + E2B), lint + typecheck green. Built the `CodeIndex` interface + types (`src/index/types.ts`), `FakeEmbeddingProvider` + `FakeCodeIndex` (deterministic, CI-tested contract), `PgVectorCodeIndex` (pgvector cosine-ANN retrieve + dropNamespace + sidecar-backed indexRepo), the CocoIndex Python sidecar (`sidecar/cocoindex_flow.py` — tree-sitter chunk + local MiniLM embed → `code_chunks`, `index`/`query-embed` modes) + `CocoIndexSidecarRunner`/`SidecarEmbeddingProvider`, host-side `cloneToTempDir` (read-only, token-redacted), migration 006 (pgvector + `code_chunks`), and `debug:index-repo`. CI Postgres → `pgvector/pgvector:pg16`. Scope is per-run (no incrementality — deferred post-MVP, plan updated). Exit criterion #1 covered: FakeCodeIndex + the gated pgvector test prove a NL query returns relevant complete code units; namespacing prevents cross-repo leak and teardown is clean (replacing the deferred incremental criterion). Demo: `npm run debug:index-repo -- <installationId> <owner> <repo>` (needs Python+CocoIndex + pgvector DB) clones, indexes, queries, prints ranked complete units, tears down.
- 2026-06-27 | Phase 5 | ✅ Complete | 86 unit tests pass (13 gated-skipped: Anthropic + PG + E2B), lint + typecheck green. Built the `clarifier` role (Haiku) + `clarificationSchema`, the clarify-gate rendering (`src/pipeline/clarify.ts`, cap 4 + batched/bounce/updated comments), `Store.updateRunContext` (existing `runs.context` jsonb, no migration), the `clarify` + `resume_clarification` job types/handlers (state-guarded, budget-aware), the redefinition of `Specified` as "gate passed", and the `issue_comment.created` resume webhook (human-only, deduped). Exit criteria covered by fake-provider unit tests: underspecified → one batched question comment + park `awaiting_clarification` (worker idle); human reply → `resume_clarification` re-runs PO, re-commits `spec.md`, posts "spec updated", advances to `specified`; fully-specified (0 questions) → straight to `specified`, no comment; >cap → graceful "too underspecified" bounce. Demo: open an underspecified feature issue → App acks, commits draft spec, posts ONE batched question comment, parks. Reply on the thread → run resumes, `spec.md` re-committed, "spec updated" comment, run `specified`.
- 2026-06-27 | Phase 4 | ✅ Complete | 66 unit tests pass (12 gated-skipped), lint + typecheck green; `artifacts` SQL verified against a local Postgres 16 (7/7). Built the `intake` (Haiku) + `product-owner` (Opus) roles, Zod spec schema (confidence-tagged requirements, Given/When/Then), spec markdown/comment rendering, the deterministic Integrator embryo (`commitFile` → `.tsukinome/<n>/spec.md` on `tsukinome/issue-<n>`), `artifacts` table (migration 005) with idempotent upsert, and the `produce_spec` worker step (deterministic language gate, graceful budget stop). Gateway wired into the worker. Exit criteria covered: unit tests prove the commit/comment/artifact orchestration; the gated real-API test proves intake+PO produce a confidence-tagged GWT spec with cost logged within budget. Demo: open a feature issue → App acks, commits `.tsukinome/<n>/spec.md` to `tsukinome/issue-<n>`, posts a spec summary with an assumptions section; `runs`/`llm_calls`/`artifacts` show state `specified` and per-call cost within budget.
- 2026-06-27 | Phase 3 | ✅ Complete | 55 unit tests pass (10 gated-skipped: Anthropic + PG + E2B), lint + typecheck green; PgStore `llm_calls`/budget SQL verified against a local Postgres 16 (6/6). Built the `LlmProvider` abstraction (`AnthropicProvider` + `FakeLlmProvider`), nano-USD cost model, `LlmGateway` (tier routing + per-call cost logging + per-run budget with `BudgetExhaustedError`), `llm_calls` table + budget columns (migration 004) with atomic `recordLlmCall`, the `runAgent` runner + role registry (single-shot structured + tool-use loop with cap), and two throwaway example roles. Exit criteria 1/2/4/5 covered by fake-provider unit tests; 3 (caching `cache_read > 0`) + real cross-tier token counts proven by the gated `ANTHROPIC_API_KEY` integration test (founder demo). Demo: run `npm test` with `ANTHROPIC_API_KEY`+`DATABASE_URL` set → real Haiku/Sonnet/Opus calls logged with token counts + dollar cost, a repeated large prefix shows `cache_read > 0`, and `example-echo`/`example-tool-pinger` run end to end with budget decrementing.
- 2026-06-27 | Phase 2 | ✅ Complete | 42 tests pass against a local Postgres 16 (37 without a DB; e2b integration test gated on `E2B_API_KEY`), lint + typecheck green. Built the `SandboxProvider`/`SandboxHandle` abstraction (`E2BSandboxProvider` + `FakeSandboxProvider`), `runTests` (clone via least-privilege token → `npm ci` → `npm test`, guaranteed teardown), `test_runs` table (migration 003) + `recordTestRun`/`getTestRuns`, `getInstallationToken` (contents:read, single repo), `run_tests` job type + `handleRunTests`, and the `debug:run-tests` trigger. Failing suites record a clean `failed` result; clone/install failures record `error`. Demo: `npm run debug:run-tests -- <installationId> <owner> <repo> <ref>` → worker clones the repo in an E2B microVM, runs its tests, writes a `test_runs` row, and `Sandbox.list()` shows none lingering.
