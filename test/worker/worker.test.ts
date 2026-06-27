import { describe, it, expect, beforeEach } from 'vitest';
import { processNextJob } from '../../src/worker/worker.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { FakeSandboxProvider } from '../sandbox/fake-sandbox.js';
import { FakeLlmProvider } from '../llm/fake-provider.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const sandboxProvider = new FakeSandboxProvider();

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
    expect(await processNextJob({ store, github, sandboxProvider, gateway, log: silentLog })).toBe(
      false,
    );
  });

  it('claims a queued job, runs its handler, and marks it done', async () => {
    const github = fakeGitHub();
    const job = await store.enqueueJob({ type: 'issue_opened', payload });

    const processed = await processNextJob({ store, github, sandboxProvider, gateway, log: silentLog });
    expect(processed).toBe(true);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(store.getJob(job.id)!.status).toBe('done');

    // The handler chained into the spec pipeline.
    expect((await store.claimNextJob())!.type).toBe('produce_spec');
  });

  it('marks the job failed when its handler throws, without crashing', async () => {
    const github = fakeGitHub({ fail: true });
    const job = await store.enqueueJob({ type: 'issue_opened', payload });

    const processed = await processNextJob({ store, github, sandboxProvider, gateway, log: silentLog });
    expect(processed).toBe(true);
    expect(store.getJob(job.id)!.status).toBe('failed');
  });
});
