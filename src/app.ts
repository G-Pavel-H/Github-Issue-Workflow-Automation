import type { Probot } from 'probot';

export function app(probot: Probot): void {
  probot.on('issues.opened', async (context) => {
    context.log.info(
      {
        event: 'issues.opened',
        repo: context.payload.repository.full_name,
        issue: context.payload.issue.number,
      },
      'Webhook received: issues.opened',
    );
  });

  probot.on('issue_comment.created', async (context) => {
    context.log.info(
      {
        event: 'issue_comment.created',
        repo: context.payload.repository.full_name,
        issue: context.payload.issue.number,
      },
      'Webhook received: issue_comment.created',
    );
  });

  probot.on('pull_request_review_comment.created', async (context) => {
    context.log.info(
      {
        event: 'pull_request_review_comment.created',
        repo: context.payload.repository.full_name,
        pr: context.payload.pull_request.number,
      },
      'Webhook received: pull_request_review_comment.created',
    );
  });
}
