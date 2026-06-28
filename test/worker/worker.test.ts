import { describe, it, expect, beforeEach } from 'vitest';
import { processNextJob } from '../../src/worker/worker.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { FakeSandboxProvider } from '../sandbox/fake-sandbox.js';
import { FakeLlmProvider } from '../llm/fake-provider.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { fakeCodeIndex, fakeCloneRepo, fakeOpenSandbox, fakeGitHub, silentLog } from '../helpers.js';

const sandboxProvider = new FakeSandboxProvider();
const codeIndex = fakeCodeIndex();
const cloneRepo = fakeCloneRepo().fn;
const openSandbox = fakeOpenSandbox().fn;

const payload = {
  installationId: 7,
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
  deliveryId: 'd-1',
};

describe('processNextJob', () => {
  let store: InMemoryStore;
  let gateway: LlmGateway;
  beforeEach(() => {
    store = new InMemoryStore();
    gateway = new LlmGateway(new FakeLlmProvider(), store, silentLog);
  });

  it('returns false when there is no job to process', async () => {
    const github = fakeGitHub();
    expect(await processNextJob({ store, github, sandboxProvider, gateway, codeIndex, cloneRepo, openSandbox, log: silentLog })).toBe(
      false,
    );
  });

  it('claims a queued job, runs its handler, and marks it done', async () => {
    const github = fakeGitHub();
    const job = await store.enqueueJob({ type: 'issue_opened', payload });

    const processed = await processNextJob({ store, github, sandboxProvider, gateway, codeIndex, cloneRepo, openSandbox, log: silentLog });
    expect(processed).toBe(true);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(store.getJob(job.id)!.status).toBe('done');

    // The handler chained into the spec pipeline.
    expect((await store.claimNextJob())!.type).toBe('produce_spec');
  });

  it('retries a throwing handler with backoff instead of failing outright', async () => {
    const github = fakeGitHub({ fail: true }); // postIssueComment throws → handler throws
    const job = await store.enqueueJob({ type: 'issue_opened', payload });

    const processed = await processNextJob({ store, github, sandboxProvider, gateway, codeIndex, cloneRepo, openSandbox, log: silentLog });
    expect(processed).toBe(true);
    // Re-queued for retry (attempt 1 < cap), not dead-lettered.
    expect(store.getJob(job.id)!.status).toBe('queued');
  });

  it('dead-letters after the attempt cap and posts a graceful failure comment', async () => {
    let now = 1_000_000;
    const clockStore = new InMemoryStore({ now: () => now });
    const clockGateway = new LlmGateway(new FakeLlmProvider(), clockStore, silentLog);
    const github = fakeGitHub({ fail: true });
    const deps = { store: clockStore, github, sandboxProvider, gateway: clockGateway, codeIndex, cloneRepo, openSandbox, log: silentLog };
    const job = await clockStore.enqueueJob({ type: 'issue_opened', payload });

    // MAX_JOB_ATTEMPTS = 3: process, then jump past the backoff so the retry is due.
    for (let i = 0; i < 3; i++) {
      await processNextJob(deps);
      now += 60 * 60 * 1000;
    }
    expect(clockStore.getJob(job.id)!.status).toBe('failed');
    // The dead-letter comment was attempted with the run's issue coordinates.
    expect(github.postIssueComment).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumber: 42, body: expect.stringContaining('unexpected error') }),
    );
  });
});
