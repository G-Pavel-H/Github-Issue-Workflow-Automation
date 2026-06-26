---
description: Start the next not-done phase of the Tsukinome implementation plan
allowed-tools: Read, Glob, Grep, Edit, Write, Bash
---

Work the next phase of the build.

1. Read `docs/implementation-plan.md` and `PROGRESS.md`.
2. Identify the lowest-numbered phase whose exit criteria are not yet met. State which phase you're starting and its goal + exit criteria.
3. Enter plan mode: propose the approach for **this phase only**. Do not touch later phases. Wait for my approval before editing.
4. After I approve, implement it **test-first** (write failing tests, then make them pass), keeping the suite green and `main` deployable.
5. When the phase's exit criteria are met: update `PROGRESS.md` (check the phase off, note decisions/deviations), give me a short report (what you built, how to see it work, what's next), then **stop and wait**. Do not start the next phase.

Follow every rule in `CLAUDE.md`.
