import { describe, it, expect, beforeEach } from 'vitest';
import { processNextJob } from '../../src/worker/worker.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { MissingInstallationKeyError } from '../../src/llm/provider-resolver.js';
import { RunState } from '../../src/store/types.js';
import { FakeSandboxProvider } from '../sandbox/fake-sandbox.js';
import { fakeCodeIndex, fakeCloneRepo, fakeOpenSandbox, fakeGitHub, silentLog } from '../helpers.js';

const sandboxProvider = new FakeSandboxProvider();
const codeIndex = fakeCodeIndex();
const cloneRepo = fakeCloneRepo().fn;
const openSandbox = fakeOpenSandbox().fn;

const payload = { installationId: 7, owner: 'acme', repo: 'widgets', issueNumber: 42 };

describe('processNextJob — missing installation key', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('refuses gracefully: posts guidance, fails the run, does NOT retry, no tokens spent', async () => {
    // A gateway whose resolver has no key on file for this installation.
    const gateway = new LlmGateway(
      async (installationId: number) => {
        throw new MissingInstallationKeyError(installationId);
      },
      store,
      silentLog,
    );
    const github = fakeGitHub({ language: 'TypeScript' });
    const deps = { store, github, sandboxProvider, gateway, codeIndex, cloneRepo, openSandbox, log: silentLog };

    const job = await store.enqueueJob({ type: 'produce_spec', payload });
    const processed = await processNextJob(deps);
    expect(processed).toBe(true);

    // The job is terminal (not re-queued for a backoff retry) — a missing key won't fix itself.
    expect(store.getJob(job.id)!.status).toBe('done');

    // The run is failed and the installer got a clear, key-focused message.
    const run = await store.getRun(payload);
    expect(run!.state).toBe(RunState.Failed);
    const comment = github.postIssueComment.mock.calls.at(-1)![0];
    expect(comment.issueNumber).toBe(42);
    expect(comment.body.toLowerCase()).toContain('anthropic');
    expect(comment.body.toLowerCase()).toContain('key');

    // Nothing was billed.
    expect((await store.getLlmCalls(run!.id))).toHaveLength(0);
  });
});
