import { describe, it, expect, beforeEach } from 'vitest';
import { handleProduceSpec } from '../../src/worker/handlers.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const job: Job = {
  id: 9,
  type: 'produce_spec',
  status: 'in_progress',
  attempts: 1,
  payload: { installationId: 7, owner: 'acme', repo: 'widgets', issueNumber: 42 },
};

const intakeJson = JSON.stringify({
  classification: 'feature',
  title: 'Add a dark mode toggle',
  problemStatement: 'Users want to switch the UI to a dark theme from settings.',
});

const specJson = JSON.stringify({
  summary: 'Add a dark mode toggle to settings.',
  requirements: [
    { id: 'R1', statement: 'A toggle switches light/dark.', confidence: 'explicit' },
    { id: 'R2', statement: 'The choice persists.', confidence: 'inferred' },
  ],
  acceptanceCriteria: [
    { id: 'AC1', given: 'on settings', when: 'toggle clicked', then: 'theme switches' },
  ],
  nonGoals: ['Theming engine'],
  edgeCases: ['OS theme change'],
  assumptions: ['Stored in localStorage'],
  openQuestions: [],
});

function specProvider(): FakeLlmProvider {
  return new FakeLlmProvider([
    textResponse(intakeJson, { inputTokens: 200, outputTokens: 60 }),
    textResponse(specJson, { inputTokens: 400, outputTokens: 200 }),
  ]);
}

describe('handleProduceSpec', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('produces & commits a spec, posts a summary comment, and records cost', async () => {
    const provider = specProvider();
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(provider, store, silentLog);

    await handleProduceSpec(job, { store, github, gateway, log: silentLog });

    // Spec committed to the working branch at the right path, with GWT + tags.
    expect(github.commitFile).toHaveBeenCalledTimes(1);
    const commit = github.commitFile.mock.calls[0]![0];
    expect(commit.branch).toBe('tsukinome/issue-42');
    expect(commit.path).toBe('.tsukinome/42/spec.md');
    expect(commit.content).toMatch(/Given/);
    expect(commit.content).toContain('explicit');

    // Summary comment posted with an assumptions section.
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.calls[0]!.body.toLowerCase()).toContain('assumptions i');

    // Artifact + cost persisted; run advanced to Specifying (clarification gate is next).
    const run = await store.getRun(job.payload);
    expect(run!.state).toBe(RunState.Specifying);
    const artifact = await store.getArtifact(run!.id, 'spec');
    expect(artifact!.path).toBe('.tsukinome/42/spec.md');
    expect((await store.getLlmCalls(run!.id)).length).toBe(2);
    // The resolved language pack is persisted for implement/fix to reload.
    expect(run!.context.toolchainId).toBe('typescript-javascript');

    // A `clarify` job is chained to run the clarification gate.
    const clarifyJob = await store.claimNextJob();
    expect(clarifyJob!.type).toBe('clarify');
    expect(clarifyJob!.payload).toMatchObject({ owner: 'acme', repo: 'widgets', issueNumber: 42 });
  });

  it('is idempotent — a second run does no LLM, commit, or comment', async () => {
    const github = fakeGitHub({ language: 'TypeScript' });
    await handleProduceSpec(job, {
      store,
      github,
      gateway: new LlmGateway(specProvider(), store, silentLog),
      log: silentLog,
    });

    const provider2 = specProvider();
    const github2 = fakeGitHub({ language: 'TypeScript' });
    await handleProduceSpec(job, {
      store,
      github: github2,
      gateway: new LlmGateway(provider2, store, silentLog),
      log: silentLog,
    });

    expect(provider2.requests).toHaveLength(0);
    expect(github2.commitFile).not.toHaveBeenCalled();
    expect(github2.postIssueComment).not.toHaveBeenCalled();
  });

  it('refuses unsupported languages gracefully without any LLM calls', async () => {
    const provider = specProvider();
    // Ruby has no language pack — Python/TS/JS are supported (Phase 13a/13b).
    const github = fakeGitHub({ language: 'Ruby' });

    await handleProduceSpec(job, {
      store,
      github,
      gateway: new LlmGateway(provider, store, silentLog),
      log: silentLog,
    });

    expect(provider.requests).toHaveLength(0);
    expect(github.commitFile).not.toHaveBeenCalled();
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    const run = await store.getRun(job.payload);
    expect(run!.state).toBe(RunState.Unsupported);
  });

  it('accepts a Python repo and persists the python toolchain', async () => {
    const github = fakeGitHub({ language: 'Python' });
    await handleProduceSpec(job, {
      store,
      github,
      gateway: new LlmGateway(specProvider(), store, silentLog),
      log: silentLog,
    });

    const run = await store.getRun(job.payload);
    expect(run!.state).toBe(RunState.Specifying);
    expect(run!.context.toolchainId).toBe('python');
    expect(github.commitFile).toHaveBeenCalledTimes(1);
  });

  it('stops gracefully when the run budget is exhausted mid-pipeline', async () => {
    const provider = specProvider();
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(provider, store, silentLog);

    const { run } = await store.findOrCreateRun(job.payload, RunState.Received);
    await store.setRunBudget(run.id, 1); // tiny — exhausts after the first call

    await handleProduceSpec(job, { store, github, gateway, log: silentLog });

    expect(github.commitFile).not.toHaveBeenCalled();
    expect((await store.getRunById(run.id))!.state).toBe(RunState.Failed);
    // The budget comment was posted.
    expect(github.postIssueComment).toHaveBeenCalled();
  });
});
