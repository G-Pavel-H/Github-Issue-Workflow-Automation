import type { Probot } from 'probot';

export interface PostIssueCommentInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}

export interface InstallationTokenInput {
  installationId: number;
  owner: string;
  repo: string;
}

export interface IssueInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface IssueContent {
  title: string;
  body: string;
}

export type RepoLanguageInput = InstallationTokenInput;

export interface CommitFileInput {
  installationId: number;
  owner: string;
  repo: string;
  /** Working branch to commit on; created from the default branch if missing. */
  branch: string;
  /** Base branch to fork from. Defaults to the repo's default branch. */
  baseBranch?: string;
  path: string;
  content: string;
  message: string;
}

export interface CommitFileResult {
  commitSha: string;
  branch: string;
}

export interface CommitFilesInput {
  installationId: number;
  owner: string;
  repo: string;
  /** Working branch to commit on; created from the base branch if missing. */
  branch: string;
  baseBranch?: string;
  /** Whole-file contents to write in a single commit. */
  files: { path: string; content: string }[];
  message: string;
}

export interface CompareDiffInput {
  installationId: number;
  owner: string;
  repo: string;
  /** Head branch/ref being reviewed. */
  head: string;
  /** Base to diff against; defaults to the repo's default branch. */
  base?: string;
}

export interface OpenPullRequestInput {
  installationId: number;
  owner: string;
  repo: string;
  head: string;
  base?: string;
  title: string;
  body: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

/**
 * The GitHub actions the worker needs. Kept narrow so the worker depends on an
 * interface, not Octokit — tests inject a spy, production injects Probot auth.
 */
export interface GitHubClient {
  postIssueComment(input: PostIssueCommentInput): Promise<void>;
  /**
   * Mint a least-privilege installation token scoped to read the contents of the
   * single target repo — used only as the sandbox's git clone credential.
   */
  getInstallationToken(input: InstallationTokenInput): Promise<string>;
  getIssue(input: IssueInput): Promise<IssueContent>;
  /** GitHub's detected primary language for the repo, or null if none. */
  getRepoLanguage(input: RepoLanguageInput): Promise<string | null>;
  /** Deterministic git write: ensure the branch and create/update one file. */
  commitFile(input: CommitFileInput): Promise<CommitFileResult>;
  /** Deterministic git write: ensure the branch and commit multiple files in one commit. */
  commitFiles(input: CommitFilesInput): Promise<CommitFileResult>;
  /** Unified per-file patch text for `base...head` (base defaults to the default branch). */
  compareDiff(input: CompareDiffInput): Promise<string>;
  /** Open a PR (or reuse the open one for `head`). Base defaults to the default branch. */
  openPullRequest(input: OpenPullRequestInput): Promise<PullRequestResult>;
}

/**
 * Production GitHubClient. `probot.auth(installationId)` mints the App JWT and
 * exchanges it for a least-privilege installation token, returning an
 * authenticated Octokit — so the worker can act out-of-band from the webhook.
 */
export function createProbotGitHubClient(probot: Probot): GitHubClient {
  return {
    async postIssueComment(input: PostIssueCommentInput): Promise<void> {
      const octokit = await probot.auth(input.installationId);
      await octokit.rest.issues.createComment({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
        body: input.body,
      });
    },

    async getInstallationToken(input: InstallationTokenInput): Promise<string> {
      // App-level (JWT) Octokit, then mint a token scoped to read this one repo.
      const appOctokit = await probot.auth();
      const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
        installation_id: input.installationId,
        repositories: [input.repo],
        permissions: { contents: 'read' },
      });
      return data.token;
    },

    async getIssue(input: IssueInput): Promise<IssueContent> {
      const octokit = await probot.auth(input.installationId);
      const { data } = await octokit.rest.issues.get({
        owner: input.owner,
        repo: input.repo,
        issue_number: input.issueNumber,
      });
      return { title: data.title, body: data.body ?? '' };
    },

    async getRepoLanguage(input: RepoLanguageInput): Promise<string | null> {
      const octokit = await probot.auth(input.installationId);
      const { data } = await octokit.rest.repos.get({ owner: input.owner, repo: input.repo });
      return data.language ?? null;
    },

    async commitFile(input: CommitFileInput): Promise<CommitFileResult> {
      const octokit = await probot.auth(input.installationId);
      const { owner, repo, branch, path, content, message } = input;

      const baseBranch =
        input.baseBranch ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

      // Ensure the working branch exists, forking it from the base branch head.
      try {
        await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      } catch {
        const { data: base } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${baseBranch}`,
        });
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: base.object.sha,
        });
      }

      // If the file already exists on the branch, its blob sha is required to update it.
      let sha: string | undefined;
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
        if (!Array.isArray(data) && 'sha' in data) sha = data.sha;
      } catch {
        // File does not exist yet — create it.
      }

      const { data: result } = await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content, 'utf-8').toString('base64'),
        branch,
        sha,
      });
      return { commitSha: result.commit.sha ?? '', branch };
    },

    async commitFiles(input: CommitFilesInput): Promise<CommitFileResult> {
      const octokit = await probot.auth(input.installationId);
      const { owner, repo, branch, files, message } = input;

      const baseBranch =
        input.baseBranch ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

      // Ensure the working branch exists, forking it from the base branch head.
      try {
        await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      } catch {
        const { data: base } = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${baseBranch}`,
        });
        await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: base.object.sha });
      }

      // Build one commit over the branch head using the git Trees API.
      const { data: ref } = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
      const headSha = ref.object.sha;
      const { data: headCommit } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });

      const { data: tree } = await octokit.rest.git.createTree({
        owner,
        repo,
        base_tree: headCommit.tree.sha,
        tree: files.map((f) => ({
          path: f.path,
          mode: '100644',
          type: 'blob',
          content: f.content,
        })),
      });

      const { data: commit } = await octokit.rest.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.sha,
        parents: [headSha],
      });

      await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha });
      return { commitSha: commit.sha, branch };
    },

    async compareDiff(input: CompareDiffInput): Promise<string> {
      const octokit = await probot.auth(input.installationId);
      const { owner, repo, head } = input;
      const base = input.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;
      const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
        owner,
        repo,
        basehead: `${base}...${head}`,
      });
      return (data.files ?? [])
        .map((f) => `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch ?? '(no textual diff)'}`)
        .join('\n\n');
    },

    async openPullRequest(input: OpenPullRequestInput): Promise<PullRequestResult> {
      const octokit = await probot.auth(input.installationId);
      const { owner, repo, head, title, body } = input;
      const base = input.base ?? (await octokit.rest.repos.get({ owner, repo })).data.default_branch;

      // Idempotent: reuse an existing open PR for this head branch.
      const existing = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${head}`, state: 'open' });
      if (existing.data.length > 0) {
        const pr = existing.data[0]!;
        return { number: pr.number, url: pr.html_url };
      }

      const { data: pr } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body });
      return { number: pr.number, url: pr.html_url };
    },
  };
}
