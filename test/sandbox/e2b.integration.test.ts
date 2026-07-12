import { describe, it, expect } from 'vitest';
import { Sandbox } from 'e2b';
import { E2BSandboxProvider } from '../../src/sandbox/e2b-sandbox.js';

const E2B_API_KEY = process.env.E2B_API_KEY;

// Real E2B microVM. Skipped unless E2B_API_KEY is set; never runs in CI (E2B is a
// paid service). Proves the wrapper talks to E2B and that teardown leaves nothing
// lingering (exit criterion 2).
describe.skipIf(!E2B_API_KEY)('E2BSandboxProvider (integration)', () => {
  it('runs a command, normalizes non-zero exits, and tears the sandbox down', async () => {
    const provider = new E2BSandboxProvider(E2B_API_KEY!);
    const handle = await provider.create({ timeoutMs: 60_000 });
    try {
      const ok = await handle.runCommand('echo hello');
      expect(ok.exitCode).toBe(0);
      expect(ok.stdout).toContain('hello');

      // Non-zero exit must come back as a result, not a throw.
      const bad = await handle.runCommand('exit 3');
      expect(bad.exitCode).toBe(3);
    } finally {
      await handle.kill();
    }

    // No lingering sandbox with this id after teardown. Sandbox.list() returns a
    // paginator (SDK API changed from a bare array), so drain it into a flat id list.
    const paginator = Sandbox.list();
    const ids: string[] = [];
    while (paginator.hasNext) {
      const page = await paginator.nextItems();
      ids.push(...page.map((s) => s.sandboxId));
    }
    expect(ids).not.toContain(handle.id);
  }, 120_000);
});
