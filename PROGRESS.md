# Tsukinome — progress log

Keep this current. It's the source of truth for what's done and what's next.

## Phase status

- [x] Phase 0 — Project scaffolding
- [ ] Phase 1 — End-to-end loop: webhook → worker → comment
- [ ] Phase 2 — Sandbox: checkout & test execution
- [ ] Phase 3 — LLM gateway + agent runner
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

## Session log

(Append a line per phase: date, phase, outcome, demo.)

- 2026-06-26 | Phase 0 | ✅ Complete | 14 tests pass, lint + typecheck green, `/health` returns 200, Probot webhooks wired + tested, migration harness ready, CI workflow added.
