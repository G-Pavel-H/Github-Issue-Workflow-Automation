import { describe, it, expect } from 'vitest';
import { openCodeSandbox, classifyTestRun } from '../../src/sandbox/code-sandbox.js';
import type { Toolchain } from '../../src/toolchain/toolchain.js';
import { TYPESCRIPT_JAVASCRIPT } from '../../src/toolchain/toolchain.js';
import { FakeSandboxProvider, type ScriptedCommand } from './fake-sandbox.js';
import { silentLog } from '../helpers.js';

const input = { token: 'ghs_secret', owner: 'acme', repo: 'widgets', ref: 'tsukinome/issue-1' };

function provider(scripts: ScriptedCommand[]): FakeSandboxProvider {
  // Defaults: clone + npm ci succeed.
  return new FakeSandboxProvider(scripts);
}

describe('classifyTestRun', () => {
  it('maps exit 0 to passed and non-zero to failed', () => {
    expect(classifyTestRun(0, 10, 'ok', '').status).toBe('passed');
    const failed = classifyTestRun(1, 10, '', '1 failing');
    expect(failed.status).toBe('failed');
    expect(failed.failureStage).toBe('test');
  });
});

describe('openCodeSandbox', () => {
  it('clones, installs, writes via base64, runs tests, and reads back', async () => {
    const p = provider([
      { match: 'npm test', result: { exitCode: 1, stdout: '', stderr: '1 failing' } },
      // write commands (base64 -d) succeed by default; read returns canned base64
      { match: "base64 'repo/src/x.ts'", result: { exitCode: 0, stdout: Buffer.from('hello').toString('base64'), stderr: '' } },
    ]);
    const sandbox = await openCodeSandbox(input, { sandboxProvider: p, log: silentLog });

    await sandbox.writeFiles([{ path: 'src/x.ts', content: 'export const x = 1;' }]);
    // The write goes through a base64 -d pipe carrying the encoded content.
    const encoded = Buffer.from('export const x = 1;', 'utf-8').toString('base64');
    expect(p.only.commands.some((c) => c.cmd.includes('base64 -d') && c.cmd.includes(encoded))).toBe(true);

    const test = await sandbox.runTests();
    expect(test.status).toBe('failed');

    const files = await sandbox.readFiles(['src/x.ts']);
    expect(files).toEqual([{ path: 'src/x.ts', content: 'hello' }]);

    await sandbox.close();
    expect(p.only.killed).toBe(1);
  });

  it('uses the toolchain install/test commands and reports its testCmd label', async () => {
    // A stand-in non-TS pack proves the seam: nothing about `npm` is baked into the sandbox.
    const python: Toolchain = {
      ...TYPESCRIPT_JAVASCRIPT,
      id: 'python',
      installCmd: 'pip install -e .',
      testCmd: 'pytest',
    };
    const p = provider([
      { match: 'pip install -e .', result: { exitCode: 0, stdout: '', stderr: '' } },
      { match: 'pytest', result: { exitCode: 0, stdout: 'ok', stderr: '' } },
    ]);
    const sandbox = await openCodeSandbox(input, { sandboxProvider: p, log: silentLog, toolchain: python });

    expect(p.only.ranAny('pip install -e .')).toBe(true);
    const result = await sandbox.runTests();
    expect(p.only.ranAny('pytest')).toBe(true);
    expect(p.only.ranAny('npm')).toBe(false);
    expect(result.command).toBe('pytest');
    await sandbox.close();
  });

  it('redacts the token and tears down when the clone fails', async () => {
    const p = provider([{ match: 'git clone', result: { exitCode: 128, stdout: '', stderr: `fatal: ${input.token}` } }]);
    await expect(openCodeSandbox(input, { sandboxProvider: p, log: silentLog })).rejects.toThrow(/clone failed/);
    expect(p.only.killed).toBe(1);
    const thrown = await openCodeSandbox(input, { sandboxProvider: provider([{ match: 'git clone', result: { exitCode: 1, stdout: '', stderr: input.token } }]), log: silentLog }).catch((e: Error) => e);
    expect((thrown as Error).message).not.toContain(input.token);
  });
});
