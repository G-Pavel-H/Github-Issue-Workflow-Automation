import type { Probot } from 'probot';
import type { Logger } from './log.js';
import { RunState, type Store } from './store/types.js';

export interface AppDeps {
  store: Store;
  log: Logger;
}

/**
 * Build the Probot app. Webhook handlers do the minimum — dedupe the delivery,
 * enqueue a job, return — so the request returns 200 fast and all real work
 * happens in the worker. Probot handles signature verification and the response.
 */
export function createApp(deps: AppDeps): (probot: Probot) => void {
  const { store, log } = deps;

  return (probot: Probot): void => {
    probot.on('issues.opened', async (context) => {
      const deliveryId = context.id;
      const repository = context.payload.repository;
      const installationId = context.payload.installation?.id;
      const issueNumber = context.payload.issue.number;

      if (installationId === undefined) {
        log.warn(
          { deliveryId, repo: repository.full_name, issue: issueNumber },
          'issues.opened without an installation id; ignoring',
        );
        return;
      }

      // Dedupe redelivered webhooks: only the first delivery enqueues.
      const fresh = await store.tryMarkEventProcessed(deliveryId);
      if (!fresh) {
        log.info({ deliveryId }, 'Duplicate webhook delivery; already enqueued');
        return;
      }

      await store.enqueueJob({
        type: 'issue_opened',
        payload: {
          installationId,
          owner: repository.owner.login,
          repo: repository.name,
          issueNumber,
          deliveryId,
        },
      });

      log.info(
        { deliveryId, repo: repository.full_name, issue: issueNumber },
        'Enqueued issue_opened job',
      );
    });

    // Phase 5: a human reply on an issue thread can resume a run parked for clarification.
    // (PR review-comment fixes are Phase 10 and handled by a different event.)
    probot.on('issue_comment.created', async (context) => {
      const deliveryId = context.id;
      const { repository, issue, comment, installation } = context.payload;
      const issueNumber = issue.number;

      // Treat issue bodies/comments as untrusted DATA; ignore bot comments outright so we
      // never resume on our own question comment.
      if (comment.user?.type === 'Bot') {
        log.info({ deliveryId, repo: repository.full_name, issue: issueNumber }, 'Ignoring bot comment');
        return;
      }

      const installationId = installation?.id;
      if (installationId === undefined) {
        log.warn(
          { deliveryId, repo: repository.full_name, issue: issueNumber },
          'issue_comment without an installation id; ignoring',
        );
        return;
      }

      // Dedupe redelivered webhooks: only the first delivery acts.
      const fresh = await store.tryMarkEventProcessed(deliveryId);
      if (!fresh) {
        log.info({ deliveryId }, 'Duplicate comment delivery; already handled');
        return;
      }

      const key = {
        installationId,
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber,
      };
      const run = await store.getRun(key);
      if (!run || run.state !== RunState.AwaitingClarification) {
        log.info(
          { deliveryId, repo: repository.full_name, issue: issueNumber, state: run?.state },
          'Comment not on a run awaiting clarification; ignoring',
        );
        return;
      }

      await store.enqueueJob({
        type: 'resume_clarification',
        payload: { ...key, commentBody: comment.body ?? '' },
      });

      log.info(
        { deliveryId, repo: repository.full_name, issue: issueNumber, runId: run.id },
        'Enqueued resume_clarification job',
      );
    });

    probot.on('pull_request_review_comment.created', async (context) => {
      log.info(
        {
          event: 'pull_request_review_comment.created',
          repo: context.payload.repository.full_name,
          pr: context.payload.pull_request.number,
        },
        'Webhook received: pull_request_review_comment.created (no-op in Phase 1)',
      );
    });
  };
}
