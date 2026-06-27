import type { CommitFileResult, GitHubClient, PullRequestResult } from './client.js';

/**
 * The deterministic Integrator (Phase 4 embryo). All git writes go through here —
 * never an agent. Phase 9 generalizes it to open the PR; for now it commits the
 * spec artifact to a per-issue working branch.
 */

export function specBranch(issueNumber: number): string {
  return `tsukinome/issue-${issueNumber}`;
}

export function specPath(issueNumber: number): string {
  return `.tsukinome/${issueNumber}/spec.md`;
}

export function planPath(issueNumber: number): string {
  return `.tsukinome/${issueNumber}/plan.md`;
}

export interface CommitSpecInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  markdown: string;
}

export interface CommitSpecResult extends CommitFileResult {
  path: string;
}

export async function commitSpec(
  github: GitHubClient,
  input: CommitSpecInput,
): Promise<CommitSpecResult> {
  const branch = specBranch(input.issueNumber);
  const path = specPath(input.issueNumber);
  const result = await github.commitFile({
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    branch,
    path,
    content: input.markdown,
    message: `Tsukinome: spec for #${input.issueNumber}`,
  });
  return { ...result, path };
}

export interface CommitPlanInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  markdown: string;
}

export interface CommitPlanResult extends CommitFileResult {
  path: string;
}

export async function commitPlan(
  github: GitHubClient,
  input: CommitPlanInput,
): Promise<CommitPlanResult> {
  const branch = specBranch(input.issueNumber);
  const path = planPath(input.issueNumber);
  const result = await github.commitFile({
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    branch,
    path,
    content: input.markdown,
    message: `Tsukinome: plan for #${input.issueNumber}`,
  });
  return { ...result, path };
}

export interface CommitTaskFilesInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  files: { path: string; content: string }[];
  message: string;
}

/** Commit one task's files as a single commit on the working branch (Phase 8). */
export async function commitTaskFiles(
  github: GitHubClient,
  input: CommitTaskFilesInput,
): Promise<CommitFileResult> {
  return github.commitFiles({
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    branch: specBranch(input.issueNumber),
    files: input.files,
    message: input.message,
  });
}

export interface OpenPrInput {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
}

/** Open (or reuse) the PR for an issue's working branch (Phase 9). Deterministic — no agent. */
export async function openPullRequestForIssue(
  github: GitHubClient,
  input: OpenPrInput,
): Promise<PullRequestResult> {
  return github.openPullRequest({
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    head: specBranch(input.issueNumber),
    title: input.title,
    body: input.body,
  });
}
