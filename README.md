# Tsukinome

A GitHub-native agent that turns a natural-language issue into a high-quality, test-first pull request — installable on any repo.

This repo is set up to be built by **Claude Code**, phase by phase, following `docs/implementation-plan.md`.

## Layout

- `docs/implementation-plan.md` — the full phased build plan (the spec Claude Code follows).
- `CLAUDE.md` — the working agreement and locked decisions, auto-loaded by Claude Code every session.
- `.claude/settings.json` — permission allowlist for routine dev/git commands.
- `.claude/commands/` — `/next-phase` and `/phase-report` helpers.
- `PROGRESS.md` — current status, decisions, and log.

## Getting started with Claude Code

Make sure Claude Code runs on your subscription, not API credits:

```bash
# 1. Make sure no API key is overriding your subscription
echo "$ANTHROPIC_API_KEY"      # should print nothing
unset ANTHROPIC_API_KEY        # if it printed something

# 2. Authenticate with your Pro/Max account (decline the API-credit option if prompted)
claude logout
claude login

# 3. Start in the project folder, then confirm the billing route
claude
# inside the session:
/status                        # should show your subscription plan, not an API key
```

Then drive the build:

```text
/next-phase
```

Work one phase at a time, review the PR, and only continue when you're happy.
