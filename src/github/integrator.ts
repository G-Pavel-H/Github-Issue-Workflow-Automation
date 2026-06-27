import type { CommitFileResult, GitHubClient } from './client.js';

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
