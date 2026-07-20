# Project Tsukinome — MVP Implementation Plan

A GitHub-native agent that takes a natural-language issue, turns it into a high-quality spec, resolves genuine ambiguity with a human, plans the work, implements it test-first, and opens a pull request — installable on any repo with as little setup as possible.

This document is the build plan. It is written to be worked through **in order, one phase at a time**, by Claude Code. Each phase is a shippable slice with explicit exit criteria. Do not advance to the next phase until the current phase's exit criteria pass.

---

## 1. MVP scope

**In scope (the MVP must do all of this):**

- Trigger on a GitHub issue, run autonomously, and open a PR.
- Produce a structured functional spec with testable acceptance criteria.
- Ask the human clarifying questions **only when something genuinely isn't inferable**, in the issue thread.
- Require human approval of the implementation plan before writing code.
- Implement each task test-first (red → green → refactor), running tests in an isolated sandbox.
- Self-review, then open a PR with the spec, plan, and tests committed.
- Respond to bounded, actionable PR review comments by fixing them (test-first), within a capped number of rounds.
- Track token and dollar cost per run, enforce a per-run budget, and stop gracefully when it's hit.
- Install on a repo via a GitHub App with no required config files in the user's repo.

**Explicitly out of scope for the MVP (defer; do not build):**

- Restricting *who* may comment / trigger the agent (treat all installers' repo members as trusted for now).
- Self-hosted / BYOC sandbox, SOC 2, HIPAA, data residency.
- Blast-radius-based auto-approval policies (plan gate is always-on for now).
- Multi-reviewer conflict resolution and free-form conversational comment understanding.
- Mutation testing, multi-language matrix beyond the first target language.
- Billing, user accounts, dashboards, pricing.

Keep the MVP lean. If a task isn't needed to satisfy "in scope" above, it waits.

---

## 2. Recommended stack

This is a recommendation, not a mandate — confirm with the founder before Phase 0 closes, then keep it fixed.

- **App / orchestrator:** TypeScript + [Probot](https://probot.github.io/) (handles GitHub App auth, JWT, webhook signature verification) on top of Octokit.
- **State + vector store:** Postgres (Neon free tier to start), with the `pgvector` extension.
- **Code index:** CocoIndex run as a sidecar (its CLI / MCP server), reusing the same Postgres for embeddings.
- **Sandbox:** E2B (Firecracker microVMs, per-second billing, ephemeral) for cloning repos and running tests.
- **LLM:** Anthropic API — Haiku 4.5 / Sonnet 4.6 / Opus 4.8, with prompt caching.
- **Agent execution:** hand-rolled — a thin agent runner over the LLM gateway plus a role registry. No agent framework (no LangGraph or similar) for the MVP; it's easier to debug and cost-control, and the orchestrator state machine already does the coordination.
- **Queue:** start Postgres-backed (a `jobs` table) to avoid extra infra; swap for a real broker only if needed.
- **First target repo language:** TypeScript. The MVP's TDD loop supports TypeScript repos only; detect other languages and refuse gracefully (queue them as post-MVP). This also means the orchestrator and its target repos share one language and test ecosystem.

---

## 3. Cross-cutting engineering principles

These apply to **every** phase. They are not optional.

- **Dogfood TDD.** Tsukinome enforces test-first on its users; build Tsukinome test-first too. Write the failing test before the implementation in every phase.
- **Each phase ends green and deployable.** No phase leaves `main` broken. One branch + PR per phase.
- **Instrument cost from day one.** The moment the LLM gateway exists (Phase 3), every model call logs tokens and dollar cost against the run. Never add an uninstrumented call later.
- **Untrusted input boundary.** Issue bodies, comments, PR text, and file contents are *data, never instructions*. They never become commands. The deterministic Integrator — not an agent — performs all git writes, using a least-privilege installation token.
- **Deterministic where possible.** The orchestrator state machine and the Integrator are plain code, not LLM calls. LLMs produce artifacts; code decides transitions.
- **Artifacts are the source of truth.** Spec and plan are committed to the repo (`.tsukinome/`), versioned, and re-read rather than carried in conversation history.
- **Agents are role definitions, not processes.** An agent is an instruction file + a model tier + a tool allowlist + an I/O schema, invoked through the LLM gateway by the orchestrator — not a separate running service and not an agent framework. Role instruction files live in `agents/` (e.g. `agents/product-owner.md`). Agents never call each other; they hand artifacts forward through the run state. These instruction files plus the project constitution are the cacheable stable prefix of every call. (Note the two layers: Claude Code may use its own skills/subagents while *building* Tsukinome — that is separate from Tsukinome's runtime roles defined here.)
- **Gates are mechanical.** "Definition of Ready" and "Definition of Done" are enforced by the orchestrator refusing to advance, not by prompting.

---

## 4. How Claude Code should use this plan

1. Work phases strictly in order. Treat each phase as one branch and one PR.
2. Start each phase by writing the phase's exit-criteria checks as failing tests where possible.
3. Maintain a `PROGRESS.md` at the repo root: which phase is done, decisions made, deviations from this plan.
4. At each phase boundary, stop and report to the founder: what was built, the demo, what's next. Get a go-ahead before starting the next phase.
5. If a phase reveals this plan is wrong, update the plan (and `PROGRESS.md`) rather than silently diverging.

---

## Stage I — Foundations

### Phase 0 — Project scaffolding

**Goal:** A running, deployable skeleton service with tooling, before any product logic.

**Build:**
- Repo, package setup, linter, formatter, type-checking, test runner.
- CI that runs lint + type-check + tests on every PR.
- Config + secrets loading (App ID, private key, webhook secret, Anthropic key, DB URL) from env.
- A `GET /health` endpoint.
- Register a development GitHub App; configure webhook subscriptions (issues, issue_comment, pull_request_review_comment) and permissions (contents, issues, pull requests — read/write as needed). Use a webhook proxy (e.g. smee) for local dev.
- Provision a dev Postgres (Neon) and run a first migration tool.

**Exit criteria:**
- `npm test`, lint, and type-check pass in CI.
- The service boots locally and `GET /health` returns 200.
- A test webhook delivery from GitHub reaches the local service and is logged.

**Notes:** No queue, no DB schema beyond a migrations harness, no AI. This phase is about making the next phases fast.

---

## Stage II — Walking skeleton & infra de-risking

### Phase 1 — End-to-end loop: webhook → worker → comment

**Goal:** Prove the entire integration loop with zero AI. This de-risks auth, webhooks, queue, worker, and API callback in one shot.

**Build:**
- Webhook receiver: verify signature, enqueue a job, return 200 within seconds.
- `jobs` table + a worker process that pulls jobs.
- `runs` table: one row per issue being worked, with a `state` column and a JSON `context` blob. Define the state-machine enum (even if most states are stubs).
- App auth: mint JWT → exchange for installation token → authenticated Octokit client.
- On `issues.opened` (or a trigger label), the worker posts a comment back to the issue: "Tsukinome has picked this up." Move the run to a known state.

**Exit criteria:**
- Opening an issue on the test repo results in a comment posted by the App, end to end.
- The `runs` row exists with the expected state; the `jobs` row is marked done.
- Restarting the worker mid-job does not duplicate the comment (basic idempotency via a processed-event check).

**Notes:** This is the heartbeat. Everything later hangs off this loop.

### Phase 2 — Sandbox: checkout & test execution

**Goal:** Validate the scariest infra piece — running untrusted code — early, still with no AI.

**Build:**
- Integrate the sandbox SDK (E2B). Spin up an ephemeral sandbox, clone the target repo using the installation token, install deps, run the repo's existing test command, capture pass/fail + output, tear down.
- A `runTests(repo, ref)` service with a hard timeout and resource limits.
- Wire it into the worker as a callable step (triggered manually or by a debug command for now).

**Exit criteria:**
- For the test repo, the worker can clone, run the test suite in the sandbox, and record structured results (passed/failed/duration).
- Sandboxes are always torn down (verify no lingering sandboxes after a run).
- A repo whose tests fail produces a clean "tests failed" result, not a crash.

**Notes:** Confirm ephemeral teardown rigorously — idle sandboxes are a cost leak. The sandbox receives only a least-privilege token.

---

## Stage III — Intelligence platform

### Phase 3 — LLM gateway + agent runner: routing, caching, cost control

**Goal:** A single instrumented chokepoint for all model calls, plus the agent-runner abstraction every pipeline phase will reuse — built *before* any agent exists.

**Build:**
- An `llm.call({ role, messages, ... })` wrapper around the Anthropic SDK.
- Model routing by phase/role: Haiku for triage/classification, Sonnet for implementation/tests, Opus for spec/plan/review.
- Prompt caching: structure prompts so the stable prefix (constitution, conventions, agent instruction file, spec) is cacheable and byte-identical across calls; mark cache breakpoints.
- Per-call usage logging (input/output/cached tokens, model, dollar cost) written to a `llm_calls` table keyed by run.
- Per-run budget: a ceiling stored on the run; decrement as calls complete; expose `run.budgetRemaining`. When near zero, the orchestrator must be able to stop at the next safe point.
- A structured-output helper (schema-constrained responses) for agents that return structured data.
- **Agent runner:** a thin `runAgent(role, input)` over the gateway that loads the role's instruction file, applies its model tier, exposes its allowed tools, and returns its structured output. Support both single-shot roles (one call → one artifact) and tool-use-loop roles (model requests a tool → run it → feed the result back → repeat until done or a cap is hit).
- **Role registry:** a map from role name to `{ instructionFile, model, tools, schema }`, with instruction files in `agents/`. Adding an agent in a later phase = author one `agents/<role>.md` file + add one registry entry; never reinvent invocation plumbing.

**Exit criteria:**
- A test issues calls across all three tiers and verifies each is logged with token counts and cost.
- A run with a tiny budget hits the cap and the gateway signals "budget exhausted" rather than continuing.
- Prompt caching demonstrably reduces input cost on a repeated-prefix call (assert cached-token count > 0 on the second call).
- A throwaway role defined purely by an `agents/*.md` file plus a registry entry runs end to end via `runAgent`, returning its schema-valid output, logged and budgeted.
- A tool-use-loop role calls a stub tool, receives the result, continues, and terminates at its cap (verify the loop and the cap).

**Notes:** This phase directly owns the project's "not expensive to run" requirement, and it sets the agent pattern for everything after it. From Phase 4 on, each new agent is just an instruction file + a registry entry run through `runAgent` — get this abstraction clean here and the pipeline phases stay thin.

---

## Stage IV — The pipeline

> Milestone: by the end of Phase 9, opening an issue produces a reviewed PR. That is the MVP.

### Phase 4 — Intake & spec (Product Owner), committed artifacts

**Goal:** First real intelligence. Turn an issue into a structured, testable spec and establish the committed-artifact pattern.

**Build:**
- Intake agent (Haiku): parse the issue, classify it (bug/feature/refactor/chore), emit a clean structured problem statement. Refuse unsupported languages gracefully.
- Product Owner agent (Opus): produce a functional spec — user-facing behavior, acceptance criteria as Given/When/Then, explicit non-goals, edge cases. Tag each requirement with a confidence level: explicit / inferred / assumption / unknown.
- Write the spec to `.tsukinome/<issue>/spec.md` on a working branch; post a summary as an issue comment, including an "assumptions I'm making" section.

**Exit criteria:**
- For a sample feature issue, a spec file is produced with Given/When/Then criteria and an assumptions list, and a summary comment is posted.
- Confidence tags are present on requirements.
- Cost for the run is logged and within budget.

### Phase 5 — Clarification gate (suspend / resume #1)

**Goal:** The first human gate and the suspend/resume primitive.

**Build:**
- Clarifier agent: from the spec's confidence tags, select only `unknown` items and risky `assumption` items as questions; cap at ~3–4; batch into one comment. Inferred items pass silently (surfaced in the assumptions list, not asked).
- Suspend: persist full run state, exit the worker, leave the run parked in `awaiting_clarification`.
- Resume: on `issue_comment` from a human in that thread, reload state, feed answers back, finalize the spec, advance.
- If the Clarifier wants more than the cap, bounce the issue back as "too underspecified" rather than interrogate.

**Exit criteria:**
- An underspecified issue parks with a single batched question comment; the worker is idle (not blocking).
- A human reply resumes the run and updates `spec.md`.
- A fully-specified issue passes this gate with no questions asked.

### Phase 6 — Code index (CocoIndex retrieval)

**Goal:** Give downstream agents scoped code context instead of whole files.

**Build:**
- Stand up CocoIndex against the target repo: AST-aware chunking, embeddings into pgvector (per-run).
- A `retrieve(query, scope)` service the agents call, returning ranked code chunks.
- ~~Re-index incrementally as the agent edits files within a run.~~ **Deferred (post-MVP).** See note.

**Exit criteria:**
- Indexing the test repo produces queryable chunks; a natural-language query returns relevant, complete (non-fragmented) code units.
- ~~Editing one file re-embeds only the changed chunks (verify incremental behavior).~~ → **Deferred (post-MVP).** Replaced for the MVP by: chunks are namespaced per run and torn down at run end (no cross-repo leakage; clean teardown).

**Notes:** Placed here because the Architect is the first heavy consumer. Keep retrieval per-agent scoped — it's a cost control, not only a quality one.

**2026-06-27 decision (Phase 6 scope):** The code index is **per-run** — clone → CocoIndex AST-chunks + embeds (with a **local, in-process** model, no API key) into pgvector namespaced per repo/run → agents query during the run → vectors + checkout torn down after. **No incrementality, no persistent checkout, no tracking tables** (incremental re-embedding is post-MVP). CocoIndex stays the locked engine, behind a `CodeIndex` interface; ingestion is a gated integration (verified locally/in the demo, like E2B), retrieval is a pgvector ANN query owned in TS and run in CI.

### Phase 7 — Architect & plan gate (Definition of Ready)

**Goal:** A technical plan, plus the always-on human approval gate before any code.

**Build:**
- Architect agent (Opus): using retrieval, produce a technical plan — affected files, interfaces/contracts, data changes, test strategy. Convention-aware (follow the repo's existing patterns).
- Write `.tsukinome/<issue>/plan.md`.
- Definition of Ready gate: zero open clarification questions + all criteria testable + non-goals stated.
- Plan gate: present spec + plan together; suspend in `awaiting_plan_approval`; resume on `/approve`, `request changes` (→ regenerate with feedback, bounded retries), or `/abort` (→ close run).

**Exit criteria:**
- A plan file is produced and presented for approval; the run parks.
- `/approve` advances; a change request regenerates and re-presents; `/abort` closes the run cleanly.
- The run cannot reach this gate with open questions (DoR enforced mechanically).

### Phase 8 — Task decomposition & TDD execution loop (Definition of Done)

**Goal:** The core engine. Turn the plan into small tasks and implement each test-first.

**Build:**
- Decomposer: break the plan into small, independently testable tasks with per-task acceptance criteria and ordering/dependencies.
- Per task, run the TDD trio:
  - Test Author (Sonnet): write tests from the criteria; orchestrator runs them in the sandbox and **asserts they fail** (red). A test that passes pre-implementation is rejected.
  - Implementer (Sonnet): write minimum code to pass; accepted only when the new tests pass **and** the full suite stays green.
  - Refactor (Sonnet): clean up while keeping green.
- Definition of Done gate per task: required tests exist, failed before, pass after, full suite green.
- Escalation ladder: retry on the cheaper model first; promote to Opus after N failures; bounded, then escalate to a human.
- Enforce the per-run budget throughout; stop at a safe task boundary if exhausted.

**Exit criteria:**
- A multi-task plan produces commits where, per task, tests were observed failing then passing, with the suite green at the end.
- A task the agent can't complete within the retry/budget caps escalates to a human instead of looping.
- TDD ordering is enforced by code (prove it: a task that skips the failing-test step is rejected).

### Phase 9 — Reviewer & Integrator → Pull Request

**Goal:** Close the loop. First real issue → PR.

**Build:**
- Reviewer agent (Opus): self-review against spec, conventions, and security. For bug-fix tasks, require a test that fails on pre-change behavior; if it can't be written, the fix is incomplete.
- Integrator (deterministic, no LLM): create branch, commit the work + `spec.md` + `plan.md`, open a PR whose body summarizes the spec, plan, and assumptions; link the issue.
- Audit trail: gate decisions and assumptions recorded in the PR/issue history.

**Exit criteria:**
- A sample feature issue runs end to end and results in an open PR with passing tests and the artifacts committed.
- The Integrator performs all git writes; no agent has write access to the repo.
- **MVP heartbeat achieved:** issue in → reviewed PR out.

---

## Stage V — Collaboration loop

### Phase 10 — PR comment → fix loop (bounded)

**Goal:** Make the PR feel alive without unbounded scope.

**Build:**
- Resume on `pull_request_review_comment` / a "changes requested" review / an explicit `/fix` trigger.
- Scope the fix to the comment's hunk/file + spec + retrieval; do not reload the whole repo.
- Preserve TDD: a behavior-change request updates/adds a test first, then makes it pass.
- Push fixes as new commits to the same branch; reply on the resolved thread; re-run CI.
- Caps: per-PR fix-round cap (~3) and the shared per-run budget. A vague comment triggers one clarifying question, not a guess. A rework-sized request routes back to the plan gate rather than being patched inline.

**Exit criteria:**
- An actionable review comment produces a test-first fix commit and a thread reply, within the round cap.
- Exceeding the cap escalates to a human rather than continuing.
- A vague comment yields a clarifying question, not a speculative change.

---

## Stage VI — Hardening & drop-in readiness

### Phase 11 — Reliability, security, and easy install

**Goal:** Make it robust and genuinely one-click to adopt.

**Build:**
- Reliability: webhook dedupe/idempotency, job retries with backoff, stale-run handling (ping → park → close), graceful failure comments on the issue.
- Observability: structured logging and tracing per run; a cost summary per run; basic metrics (runs, failures, avg cost/issue — replace the planning estimate with measured data).
- Security pass: confirm the untrusted-input boundary end to end; least-privilege token scopes; the deterministic-integrator wall; secrets handling.
- Install UX: GitHub App listing prep, install flow that needs no repo config files, a README and a short setup guide. Config knobs (budget cap, gate policy) with sane defaults.

**Exit criteria:**
- A fresh install on a brand-new repo works end to end with no manual config in that repo.
- Duplicate webhook deliveries and worker restarts never double-act.
- Each run emits a cost summary; the measured average cost/issue is recorded.
- A failure (e.g. sandbox error, budget exhaustion) leaves a clear comment and a clean run state, never a silent hang.

---

## 5. Risk register (watch these throughout)

- **Cost runaway** — unbounded loops/retries or missing prompt caching. Mitigated by Phase 3 instrumentation + caps; verify in 8 and 10.
- **Prompt injection** — malicious issue/comment/file text. Mitigated by the untrusted-input boundary; verify in 11.
- **Sandbox cost/security** — idle sandboxes or weak isolation. Verify ephemeral teardown (Phase 2) and least-privilege tokens.
- **Long-parked runs** — human gates mean runs sit for days; never rely on in-memory state. Suspend/resume is load-bearing from Phase 5 on.
- **Gate fatigue** — too much human friction kills adoption. Keep it to the clarification gate (conditional) + plan gate (always) + the PR they'd review anyway.
- **Agent-PR quality** — small tasks and hard TDD gates are the defense; resist large unscoped tasks in Phase 8.

## 6. Definition of MVP done

A person installs the GitHub App on a fresh repo, opens an issue, answers at most a few clarifying questions, approves the plan, and receives a PR implemented test-first — with the run's cost measured and within budget, and the whole thing reviewable in GitHub with no external dashboard. Everything beyond that is post-MVP.

---

## 7. Post-MVP backlog

> Deferred beyond the MVP heartbeat. Not blocking the first live demo. To be revisited after a successful end-to-end run.

### Phase 12 — Bring-your-own-key (per-installation credentials)

**Goal:** Stop the platform operator from paying for every installation's model and sandbox usage. Each installation supplies its own `ANTHROPIC_API_KEY` (and optionally `E2B_API_KEY`), so inference cost accrues to the party that opened the issue, not to whoever hosts Tsukinome.

**Why now (context):** As of the MVP, `loadConfig()` reads a single global `ANTHROPIC_API_KEY`/`E2B_API_KEY` from the process environment, and `src/index.ts` constructs one `AnthropicProvider` and one `E2BSandboxProvider` at startup, shared across all installations. That is single-tenant: the host pays for everything. This phase makes credentials per-installation. The existing cost instrumentation (Phase 3) and per-run budget cap are the groundwork — they start metering per installation rather than globally.

**Build:**
- **Secret storage:** a per-installation credentials table (reuse the existing Postgres), keyed by `installationId`, with the API keys encrypted at rest. Introduce a `MASTER_ENCRYPTION_KEY` env var for envelope encryption; never store plaintext keys or log them.
- **Key intake:** a way for an installer to submit their key without it touching an agent or a commit. Decide between (a) a minimal settings page served by the existing server (post-install redirect → form → encrypted write), or (b) reading a designated repo/org secret. Option (a) is the recommended default; capture the decision here before building.
- **Per-run credential resolution:** move `new AnthropicProvider(...)` / `new E2BSandboxProvider(...)` out of startup and into per-run construction, resolving the key from the run's `installationId` via the store. The provider interfaces do not change — only where/when they are instantiated and where the key comes from.
- **Fallback / gating policy:** if an installation has no key on file, refuse gracefully with an issue comment explaining how to add one (mirrors the unsupported-language gate) — do **not** silently fall back to a platform key. Optionally support an operator-provided default key behind an explicit `ALLOW_PLATFORM_KEY_FALLBACK` flag for single-tenant/self-host use.
- **Security:** treat stored keys under the same untrusted-input and least-privilege invariants; redact them from logs and error surfaces; rotate/revoke path (delete on uninstall via the `installation.deleted` webhook).
- **Tests (dogfood TDD):** fake secret store with encrypt/decrypt round-trip; per-run resolution picks the right installation's key; missing-key path refuses without spending tokens; uninstall purges stored secrets.

**Exit criteria:**
- Two installations with different keys run concurrently, each billed to its own key; no cross-tenant leakage.
- An installation with no key on file is refused gracefully with clear guidance, before any model call.
- Keys are encrypted at rest, never logged, and purged on uninstall.
- Single-tenant/self-host still works via the explicit platform-key fallback flag.

**Open decisions (resolve before implementing):** key-intake mechanism (settings page vs repo secret); whether E2B is also BYO or stays platform-provided; whether to add usage metering/billing on top (separate phase).

### Phase 13 — Multi-language support (beyond TypeScript/JavaScript)

**The problem we're solving:** Today Tsukinome only works on TypeScript/JavaScript repos — it refuses everything else at the language gate. We want it to accept the general stack (Python, Java, C#, Go, and similar — broadly the languages CocoIndex/tree-sitter already understands, or at least most of them), so it can turn an issue into a test-first PR regardless of the repo's language.

**Why it's not a rewrite (context):** The lock-in is concentrated and additive, not architectural. The main TS/JS assumptions live in a handful of places:
- **Build/test execution** is hardcoded to the Node toolchain — `npm ci` + `npm test` in `src/sandbox/code-sandbox.ts` and `src/sandbox/run-tests.ts`. This is the core thing that must vary by language.
- **The sandbox image** (`src/sandbox/e2b-sandbox.ts` + the template knob in `config.ts`) is a Node template so `npm test` runs; other languages need their runtime available.
- **Project detection / repo map** (`src/pipeline/repo-map.ts`, and the test-runner config probe in `src/pipeline/tdd.ts`) reads `package.json` / vitest/jest config specifically.
- **Agent prompts** (`agents/test-author.md`, implementer/architect/refactor) carry TS idioms (e.g. `vitest.config.ts`, `.test.ts` path conventions) that bias the models toward TypeScript.
- **The language gate** (`SUPPORTED_LANGUAGES` in `src/worker/handlers.ts`) is a deliberate narrow guardrail.
- **Good news — the code index is already language-agnostic:** the CocoIndex sidecar uses `detect_code_language()` + tree-sitter chunking and language-neutral embeddings; the only TS/JS-specific bit is the `SOURCE_EXT` extension filter (kept in sync between the sidecar and the fake index). Widening that list is most of the work at the retrieval layer.

**Ideas for the solution (to refine — not final technical decisions):**
- Introduce a single **`Toolchain` abstraction**: `detect(repo) → { language, installCmd, testCmd, testFileConventions, sandboxTemplate }`. Thread it through the sandbox runner (replacing the two hardcoded commands), the test-runner-config probe, the repo map, and the agent prompts.
- Ship support as per-language **"language packs"**, each bundling: its install/test commands, the sandbox image/runtime it needs, its test-file conventions, prompt conventions to inject, and its source-file extensions. Add packs incrementally (start with Python, then Java/C#/Go).
- **Parameterize the agent prompts by detected language** instead of hardcoding TS idioms — inject the pack's conventions as variables so the same roles work across languages.
- **Sandbox images:** decide between per-language templates vs one image carrying multiple toolchains (the template id is already a config knob).
- **Turn the language gate into a capability check** — "do we have a Toolchain/language pack for this repo's primary language?" — rather than a fixed TS/JS set. Keep refusing gracefully when there's no pack.
- Extend the code index's `SOURCE_EXT` (sidecar + fake) to the supported languages.

**Rough exit criteria (per language pack):** a repo in the target language, with its conventional test runner, goes issue → clarify/plan → **test-first, green PR** end to end; unsupported languages (no pack) are still refused gracefully; the TS/JS path is unchanged.

**Delivery — split into two PRs (decided with Claude Code CLI, 2026-07-20).** Phase 13 is too large for one green-and-deployable branch, so it ships as two sub-phases, one branch/PR each:

#### Phase 13a — `Toolchain` abstraction (behaviour-neutral refactor) ✅

Introduce the `Toolchain` interface + a `typescript-javascript` pack encoding today's exact behaviour, plus `toolchainForLanguage(language)` / `detectToolchain(files)` resolvers, and route the previously-hardcoded TS/JS commands through it. No new language, no behaviour change — the existing test suite is the neutrality guard.

- **Build:** `src/toolchain/toolchain.ts` (interface, TS/JS pack, registry, resolvers). Thread the pack through the two sandbox sites (`code-sandbox.ts`, `run-tests.ts` — install/test commands + the result's `command` label), the test-conventions probe (`readTestConventions`), and turn the language gate into a capability check (`SUPPORTED_LANGUAGES` set → `toolchainForLanguage`).
- **Exit criteria:** whole suite still green with zero behaviour change; a non-TS stand-in pack drives the sandbox's commands in a unit test (proves the seam); the Python-refusal gate test still passes against the capability check.
- **Deliberately deferred to 13b (kept out of 13a to stay behaviour-neutral):** per-run *selection* wiring (passing a detected toolchain from the handler through `openSandbox`/`TddContext` — pointless with one pack), the repo-map manifest generalization (still reads `package.json` directly), prompt parameterization, and the sidecar `SOURCE_EXT` widening. The pack already carries `projectManifest`/`sourceExts`/`sandboxTemplate` as the seams those will read.

#### Phase 13b — first non-TS pack: **Python**

Add the Python pack (pip/pytest, its test conventions + source extensions + sandbox runtime), wire per-run toolchain selection through the pipeline, widen the sidecar `SOURCE_EXT`, and parameterize the agent prompts by the detected pack's conventions. Exit = a real Python repo goes issue → green, test-first PR; TS/JS unchanged; unsupported languages still refused.

**Open questions (to review with Claude Code CLI):** ~~which language to do first~~ **Python** (decided 2026-07-20); per-language sandbox templates vs one multi-toolchain image (leaning one multi-toolchain image for the MVP); how much the test-first loop's grain needs to change per ecosystem (test conventions differ a lot); interaction with the TDD-gate policy work (some ecosystems/issues may fit "direct" better than strict red→green).
