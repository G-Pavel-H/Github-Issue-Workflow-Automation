import { vi } from 'vitest';
import type {
  CommitFileInput,
  GitHubClient,
  IssueInput,
  PostIssueCommentInput,
  RepoLanguageInput,
} from '../src/github/client.js';
import type { Logger } from '../src/log.js';

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
}

/** A GitHubClient whose methods are spies, with an optional failure mode. */
export function fakeGitHub(opts: FakeGitHubOpts = {}): GitHubClient & {
  calls: PostIssueCommentInput[];
  postIssueComment: ReturnType<typeof vi.fn>;
  getInstallationToken: ReturnType<typeof vi.fn>;
  getIssue: ReturnType<typeof vi.fn>;
  getRepoLanguage: ReturnType<typeof vi.fn>;
  commitFile: ReturnType<typeof vi.fn>;
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
  return {
    calls,
    postIssueComment,
    getInstallationToken,
    getIssue,
    getRepoLanguage,
    commitFile,
  };
}
