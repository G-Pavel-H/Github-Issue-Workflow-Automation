import { vi } from 'vitest';
import type {
  CommitFileInput,
  CommitFilesInput,
  GitHubClient,
  IssueInput,
  OpenPullRequestInput,
  PostIssueCommentInput,
  RepoLanguageInput,
} from '../src/github/client.js';
import type { Logger } from '../src/log.js';
import type { CodeChunk, CodeIndex } from '../src/index/types.js';
import type { Checkout, CloneInput } from '../src/index/checkout.js';
import type { OpenCodeSandboxFn } from '../src/sandbox/code-sandbox.js';
import { FakeCodeSandbox } from './sandbox/fake-code-sandbox.js';

export const silentLog: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface FakeGitHubOpts {
  fail?: boolean;
  token?: string;
  language?: string | null;
  issueTitle?: string;
  issueBody?: string;
  diff?: string;
}

/** A GitHubClient whose methods are spies, with an optional failure mode. */
export function fakeGitHub(opts: FakeGitHubOpts = {}): GitHubClient & {
  calls: PostIssueCommentInput[];
  postIssueComment: ReturnType<typeof vi.fn>;
  getInstallationToken: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  getRepoLanguage: ReturnType<typeof vi.fn>;
  commitFile: ReturnType<typeof vi.fn>;
  commitFiles: ReturnType<typeof vi.fn>;
  compareDiff: ReturnType<typeof vi.fn>;
  openPullRequest: ReturnType<typeof vi.fn>;
} {
  const calls: PostIssueCommentInput[] = [];
  const postIssueComment = vi.fn(async (input: PostIssueCommentInput) => {
    if (opts.fail) throw new Error('github exploded');
    calls.push(input);
  });
  const getInstallationToken = vi.fn(async () => opts.token ?? 'ghs_faketoken');
  const getIssue = vi.fn(async (_input: IssueInput) => ({
    title: opts.issueTitle ?? 'Add a dark mode toggle',
    body: opts.issueBody ?? 'Users want to switch the UI to a dark theme.',
  }));
  const getRepoLanguage = vi.fn(async (_input: RepoLanguageInput) =>
    opts.language === undefined ? 'TypeScript' : opts.language,
  );
  const commitFile = vi.fn(async (input: CommitFileInput) => ({
    commitSha: 'deadbeefcafe',
    branch: input.branch,
  }));
  let commitSeq = 0;
  const commitFiles = vi.fn(async (input: CommitFilesInput) => ({
    commitSha: `commit${++commitSeq}`,
    branch: input.branch,
  }));
  const compareDiff = vi.fn(async () => opts.diff ?? '--- src/x.ts (modified)\n+ added a line');
  const openPullRequest = vi.fn(async (_input: OpenPullRequestInput) => ({
    number: 7,
    url: 'https://github.com/acme/widgets/pull/7',
  }));
  return {
    calls,
    postIssueComment,
    getInstallationToken,
    getIssue,
    getRepoLanguage,
    commitFile,
    commitFiles,
    compareDiff,
    openPullRequest,
  };
}

/** A spy CodeIndex with canned retrieval results (no DB, no Python, no filesystem). */
export function fakeCodeIndex(chunks: CodeChunk[] = []): CodeIndex & {
  indexRepo: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  dropNamespace: ReturnType<typeof vi.fn>;
} {
  return {
    indexRepo: vi.fn(async () => ({ fileCount: 1, chunkCount: chunks.length })),
    retrieve: vi.fn(async () => chunks),
    dropNamespace: vi.fn(async () => {}),
  };
}

/** An openSandbox fn that always yields the given FakeCodeSandbox (no E2B). */
export function fakeOpenSandbox(sandbox: FakeCodeSandbox = new FakeCodeSandbox()): {
  fn: OpenCodeSandboxFn;
  sandbox: FakeCodeSandbox;
} {
  const fn: OpenCodeSandboxFn = async () => sandbox;
  return { fn, sandbox };
}

/** A spy clone fn returning a stub checkout — no git involved. */
export function fakeCloneRepo(dir = '/tmp/tsukinome-fake-checkout'): {
  fn: (input: CloneInput) => Promise<Checkout>;
  cleanup: ReturnType<typeof vi.fn>;
} {
  const cleanup = vi.fn();
  const fn = vi.fn(async (_input: CloneInput) => ({ dir, cleanup }));
  return { fn, cleanup };
}
