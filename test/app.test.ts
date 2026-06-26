import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Probot, ProbotOctokit } from 'probot';
import { app } from '../src/app.js';

describe('Probot app webhook handlers', () => {
  let probot: Probot;
  let logSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    logSpy = vi.fn();
    probot = new Probot({
      appId: 1,
      privateKey:
        '-----BEGIN RSA PRIVATE KEY-----\n' +
        'MIIEowIBAAKCAQEA2a2rwplBQLzHPZe5RaAkn6YRCb7VcMl0v+UYbNgP2JCbgjsT\n' +
        'pKqgEIVmkGkLMekPCqe+nBDDfBIGMIW/iKqYGT0JQm35SFLi4OUIMT0Dqz8TJno\n' +
        'yqENGa4RXt15y2GJLRy6S+jGsDdNbNlCb+cjaJuf2y8g6+nfzZ5R6jLgJ2VCBGn0\n' +
        'LRe/Fp4F3dC0okkHoeqEa2YBPnMiGxYJFSTbabWwY2p7OCtAp3MXemjn7tVh8TIp\n' +
        'RsKDtl9IUot6Di8RDM8CoviGDieTr/NDXMnGl2gOKUjuOK8RdHDBfP/kPaGdOzV1\n' +
        'x7ADqIsoSt/MqEFOdp4IBkjZAFXFJCGR1j8VrwIDAQABAoIBAFH1WfXFNMf94MnL\n' +
        'T0S3Tp4RXf4k0mIG1o2GjSOoEjHbjMN0X0z38rK0xGjsRVEJmmQOvMHJ8SHgMuuQ\n' +
        'm/HhRs/xrHz5RrOBHh54bm+MQ4W5jCPlMNiA1FgWaFYbsnm1SmP/upgHgVsFRGex\n' +
        'WJQIaFy03V6wqiGwHJjYMFREjS9eBY0JiZBTxCMgi6GfzUz9fXiRPXRBx7lhPFfe\n' +
        'Rjd1GCIKTvqCW0d2tPyQVEImOE4MG8Eq8EjW4C9X/LumaN9DEnWaKpWfLGmd4oH5\n' +
        'zKsHBi3DKFKtR/gHM1DGvBVeOAEj2K0O0s+yBfrHIl3VJQYefR7LcLBgMN1GJgt3\n' +
        'OGITURECgYEA72t+cnIDE2A3sUwDTNjSxXW0H44wAMEfMm/f+bz6GkECQOlDl7K0\n' +
        'y5p6IOKXLfxGJMrmIaqPR6Xr/CzAh4jLEKvD4Fvk/LiL7fOjcoX8hVBN3dj/O7y\n' +
        'VQCTMXxw4e3Bt7TXx/fTTTMm0fKxsEoZ2lv+NfR+L8QR6LON/wJHnOkCgYEA6J7r\n' +
        '-----END RSA PRIVATE KEY-----\n',
      secret: 'test-secret',
      logLevel: 'silent',
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });

    await probot.load(app);

    // Spy on probot's logger
    // @ts-expect-error - accessing internal log
    probot.log.info = logSpy;
  });

  it('logs when an issue is opened', async () => {
    await probot.receive({
      id: '1',
      name: 'issues',
      payload: {
        action: 'opened',
        issue: {
          number: 42,
          title: 'Test issue',
          body: 'This is a test',
          user: { login: 'testuser' },
        },
        repository: {
          full_name: 'test-owner/test-repo',
          name: 'test-repo',
          owner: { login: 'test-owner' },
        },
        installation: { id: 1 },
      } as any,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'issues.opened',
        repo: 'test-owner/test-repo',
        issue: 42,
      }),
      expect.stringContaining('Webhook received'),
    );
  });

  it('logs when an issue comment is created', async () => {
    await probot.receive({
      id: '2',
      name: 'issue_comment',
      payload: {
        action: 'created',
        issue: {
          number: 42,
          title: 'Test issue',
        },
        comment: {
          id: 1,
          body: 'A comment',
          user: { login: 'testuser' },
        },
        repository: {
          full_name: 'test-owner/test-repo',
          name: 'test-repo',
          owner: { login: 'test-owner' },
        },
        installation: { id: 1 },
      } as any,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'issue_comment.created',
        repo: 'test-owner/test-repo',
        issue: 42,
      }),
      expect.stringContaining('Webhook received'),
    );
  });

  it('logs when a PR review comment is created', async () => {
    await probot.receive({
      id: '3',
      name: 'pull_request_review_comment',
      payload: {
        action: 'created',
        pull_request: {
          number: 7,
          title: 'Test PR',
        },
        comment: {
          id: 1,
          body: 'Review comment',
          user: { login: 'reviewer' },
        },
        repository: {
          full_name: 'test-owner/test-repo',
          name: 'test-repo',
          owner: { login: 'test-owner' },
        },
        installation: { id: 1 },
      } as any,
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'pull_request_review_comment.created',
        repo: 'test-owner/test-repo',
        pr: 7,
      }),
      expect.stringContaining('Webhook received'),
    );
  });
});
