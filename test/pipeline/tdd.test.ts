import { describe, it, expect, beforeEach } from 'vitest';
import { runTaskTdd, decompose, SONNET_ATTEMPTS, OPUS_ATTEMPTS, type TddContext } from '../../src/pipeline/tdd.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { FakeCodeSandbox } from '../sandbox/fake-code-sandbox.js';
import { silentLog } from '../helpers.js';
import type { TestRunStatus } from '../../src/sandbox/types.js';

const key: RunKey = { installationId: 1, owner: 'acme', repo: 'widgets', issueNumber: 1 };

const task = {
  id: 'T1',
  title: 'add',
  description: 'implement add',
  acceptanceCriteria: ['adds two numbers'],
};

const files = (path: string, content: string) => JSON.stringify({ files: [{ path, content }] });

async function ctx(
  store: InMemoryStore,
  provider: FakeLlmProvider,
  sandbox: FakeCodeSandbox,
): Promise<TddContext> {
  const { run } = await store.findOrCreateRun(key, RunState.Received);
  return {
    sandbox,
    gateway: new LlmGateway(provider, store, silentLog),
    runId: run.id,
    log: silentLog,
    specMarkdown: '# spec',
    planMarkdown: '# plan',
    affectedPaths: ['src/add.ts', 'src/add.test.ts'],
  };
}

describe('runTaskTdd', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('drives a task red → green → refactor and reports it done', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('src/add.test.ts', 'test')), // test-author
      textResponse(files('src/add.ts', 'impl')), // implementer
      textResponse(files('src/add.ts', 'impl tidy')), // refactor
    ]);
    // tests fail after author, pass after impl, pass after refactor
    const sandbox = new FakeCodeSandbox(['failed', 'passed', 'passed']);

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));

    expect(outcome.status).toBe('done');
    expect(outcome.redObserved).toBe(true);
    expect(outcome.greenObserved).toBe(true);
    expect(outcome.changedPaths.sort()).toEqual(['src/add.test.ts', 'src/add.ts']);
  });

  it('treats a task whose tests pass pre-impl (suite green) as already-satisfied and skips it', async () => {
    const provider = new FakeLlmProvider();
    // Every test-author attempt yields tests; sandbox says the suite passes → behavior already exists.
    provider.always = textResponse(files('src/add.test.ts', 'test'));
    const sandbox = new FakeCodeSandbox(Array(SONNET_ATTEMPTS + OPUS_ATTEMPTS).fill('passed') as TestRunStatus[]);

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));

    expect(outcome.status).toBe('already-satisfied');
    expect(outcome.redObserved).toBe(false);
    expect(outcome.greenObserved).toBe(true);
    expect(outcome.changedPaths).toEqual([]); // nothing committed for a redundant task
  });

  it('escalates at the test stage when the author never produces any tests', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse(JSON.stringify({ files: [] })); // never any tests
    const sandbox = new FakeCodeSandbox();

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));

    expect(outcome.status).toBe('escalated');
    expect(outcome.stage).toBe('test');
    expect(outcome.redObserved).toBe(false);
  });

  it('escalates (no infinite loop) when the implementation never goes green', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse(files('src/add.ts', 'impl')); // also serves the test-author
    // test-author: red once; then every implementer attempt (whole ladder) fails.
    const sandbox = new FakeCodeSandbox([
      'failed',
      ...(Array(SONNET_ATTEMPTS + OPUS_ATTEMPTS).fill('failed') as TestRunStatus[]),
    ]);

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));

    expect(outcome.status).toBe('escalated');
    expect(outcome.stage).toBe('impl');
    expect(outcome.redObserved).toBe(true);
  });

  it('feeds the previous failing test output back to the implementer on retry', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('src/add.test.ts', 'test')), // test-author → red
      textResponse(files('src/add.ts', 'impl-1')), // implementer attempt 1 → still failing
      textResponse(files('src/add.ts', 'impl-2')), // implementer attempt 2 → green
    ]);
    // author red (call 1) → impl attempt 1 fails (call 2) → impl attempt 2 passes (call 3)
    const sandbox = new FakeCodeSandbox(['failed', 'failed', 'passed']);

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));
    expect(outcome.status).toBe('done');

    // Requests carrying the failing tests are the implementer's; the 2nd must include
    // attempt 1's failure output (the 2nd runTests call → marker "#2").
    const implReqs = provider.requests.filter((r) => JSON.stringify(r).includes('Failing tests:'));
    expect(implReqs.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(implReqs[0])).not.toContain('vitest-failure'); // 1st attempt: no prior output
    expect(JSON.stringify(implReqs[1])).toContain('vitest-failure-#2'); // retry sees the failure
  });

  it('passes the repo test-runner conventions to the test-author', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('test/add.test.ts', 'test')), // test-author writes into test/
      textResponse(files('src/add.ts', 'impl')), // implementer
      textResponse(files('src/add.ts', 'tidy')), // refactor
    ]);
    const sandbox = new FakeCodeSandbox(['failed', 'passed', 'passed']);
    const conventions = "include: ['test/**/*.test.ts']";

    await runTaskTdd(task, { ...(await ctx(store, provider, sandbox)), testConventions: conventions });

    // The first request is the test-author's — it must carry the conventions block.
    expect(JSON.stringify(provider.requests[0])).toContain("include: ['test/**/*.test.ts']");
  });

  it('gives the test-author the repo map, example tests, and the import-resolution rule', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('test/add.test.ts', 'test')), // test-author → red
      textResponse(files('src/add.ts', 'impl')), // implementer → green
      textResponse(files('src/add.ts', 'tidy')), // refactor
    ]);
    const sandbox = new FakeCodeSandbox(['failed', 'passed', 'passed']);
    // Seed the checkout so gatherRepoContext finds a real example test + package.json.
    sandbox.files.set('test/existing.test.ts', "import { x } from '../src/x';\n// example");
    sandbox.files.set('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }));

    await runTaskTdd(task, await ctx(store, provider, sandbox));

    const authorReq = JSON.stringify(provider.requests[0]);
    expect(authorReq).toContain('Repository file map');
    expect(authorReq).toContain('test/existing.test.ts'); // example test included
    expect(authorReq).toContain("import { x } from '../src/x'"); // its import style shown
    expect(authorReq).toContain('FALSE red'); // the import-resolution rule
  });

  it('sends the run-stable context as a cached block and the per-task tail uncached', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('test/add.test.ts', 'test')), // test-author → red
      textResponse(files('src/add.ts', 'impl')), // implementer → green
      textResponse(files('src/add.ts', 'tidy')), // refactor
    ]);
    const sandbox = new FakeCodeSandbox(['failed', 'passed', 'passed']);

    await runTaskTdd(task, await ctx(store, provider, sandbox));

    // Both the test-author (request 0) and the implementer (request 1) split their user message
    // into a cached run-stable prefix (spec/plan/etc.) + an uncached, per-task/per-attempt tail.
    for (const idx of [0, 1]) {
      const content = provider.requests[idx]!.messages[0]!.content;
      expect(Array.isArray(content)).toBe(true);
      const blocks = content as { type: string; text: string; cacheControl?: string }[];
      const [stable, tail] = blocks;
      // Cached run-stable prefix: carries the spec + plan, marked for prompt caching.
      expect(stable!.cacheControl).toBe('ephemeral');
      expect(stable!.text).toContain('# spec');
      expect(stable!.text).toContain('# plan');
      expect(stable!.text).not.toContain('Task T1'); // per-task header is NOT in the cached prefix
      expect(stable!.text).not.toContain('Current files:'); // variable content stays out of the cache
      // Uncached variable tail: the per-task header + the current files.
      expect(tail!.cacheControl).toBeUndefined();
      expect(tail!.text).toContain('Task T1');
      expect(tail!.text).toContain('Current files:');
    }
  });

  it('trims example tests to their import lines, not whole file bodies', async () => {
    const provider = new FakeLlmProvider([
      textResponse(files('test/add.test.ts', 'test')), // test-author → red
      textResponse(files('src/add.ts', 'impl')), // implementer → green
      textResponse(files('src/add.ts', 'tidy')), // refactor
    ]);
    const sandbox = new FakeCodeSandbox(['failed', 'passed', 'passed']);
    sandbox.files.set(
      'test/existing.test.ts',
      "import { x } from '../src/x';\n\ndescribe('x', () => { it('UNIQUEBODYMARKER', () => {}); });",
    );
    sandbox.files.set('package.json', JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }));

    await runTaskTdd(task, await ctx(store, provider, sandbox));

    const authorReq = JSON.stringify(provider.requests[0]);
    expect(authorReq).toContain("import { x } from '../src/x'"); // import lines kept
    expect(authorReq).not.toContain('UNIQUEBODYMARKER'); // file body dropped
  });

  it('carries the last failure output on an impl escalation', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse(files('src/add.ts', 'impl'));
    const sandbox = new FakeCodeSandbox([
      'failed',
      ...(Array(SONNET_ATTEMPTS + OPUS_ATTEMPTS).fill('failed') as TestRunStatus[]),
    ]);

    const outcome = await runTaskTdd(task, await ctx(store, provider, sandbox));

    expect(outcome.status).toBe('escalated');
    expect(outcome.stage).toBe('impl');
    expect(outcome.lastFailureOutput).toContain('vitest-failure');
  });

  it('stays on Sonnet across the ladder and never promotes to Opus (cost control)', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse(files('src/add.test.ts', 'test'));
    const sandbox = new FakeCodeSandbox(Array(SONNET_ATTEMPTS + OPUS_ATTEMPTS).fill('passed') as TestRunStatus[]);

    await runTaskTdd(task, await ctx(store, provider, sandbox));

    const models = provider.requests.map((r) => r.model);
    expect(models.every((m) => m === 'claude-sonnet-4-6')).toBe(true);
    expect(models).not.toContain('claude-opus-4-8'); // Opus is disabled in the loop
    expect(models.length).toBe(SONNET_ATTEMPTS); // exactly the Sonnet attempts, then escalate
  });
});

describe('decompose', () => {
  it('returns the decomposer agent tasks', async () => {
    const store = new InMemoryStore();
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    const provider = new FakeLlmProvider([
      textResponse(JSON.stringify({ tasks: [task, { ...task, id: 'T2', title: 'multiply' }] })),
    ]);
    const tasks = await decompose('# spec', '# plan', {
      runId: run.id,
      gateway: new LlmGateway(provider, store, silentLog),
      log: silentLog,
    });
    expect(tasks.map((t) => t.id)).toEqual(['T1', 'T2']);
  });
});
