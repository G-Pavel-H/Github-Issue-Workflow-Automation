import { Sandbox, CommandExitError } from 'e2b';
import type { Logger } from '../log.js';
import type {
  CommandResult,
  CreateSandboxOptions,
  RunCommandOptions,
  SandboxHandle,
  SandboxProvider,
} from './types.js';

/**
 * Thin wrapper isolating all E2B-API quirks. The most important one: E2B's
 * `commands.run` *throws* `CommandExitError` on a non-zero exit; we normalize that
 * back into a plain `CommandResult` so the orchestration in run-tests.ts only ever
 * inspects exit codes. This file is the one piece verified against the live service
 * (the integration test), not in CI.
 */
class E2BSandboxHandle implements SandboxHandle {
  constructor(private readonly sandbox: Sandbox) {}

  get id(): string {
    return this.sandbox.sandboxId;
  }

  async runCommand(cmd: string, opts?: RunCommandOptions): Promise<CommandResult> {
    try {
      const res = await this.sandbox.commands.run(cmd, {
        cwd: opts?.cwd,
        timeoutMs: opts?.timeoutMs,
      });
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr };
      }
      throw err;
    }
  }

  async kill(): Promise<void> {
    await this.sandbox.kill();
  }
}

export class E2BSandboxProvider implements SandboxProvider {
  /**
   * @param apiKey   E2B API key.
   * @param template Optional template id/name. Unset → E2B's base image (old Node); set to a
   *                 Node ≥ 22 template (see e2b.Dockerfile) so `npm test` doesn't fail at import.
   */
  constructor(
    private readonly apiKey: string,
    private readonly template?: string,
    private readonly log?: Logger,
  ) {}

  async create(opts?: CreateSandboxOptions): Promise<SandboxHandle> {
    const sandboxOpts = { apiKey: this.apiKey, timeoutMs: opts?.timeoutMs };
    const sandbox = this.template
      ? await Sandbox.create(this.template, sandboxOpts)
      : await Sandbox.create(sandboxOpts);
    // Surface which template booted — unset means E2B's base image (old Node), a common foot-gun.
    this.log?.info(
      { sandboxId: sandbox.sandboxId, template: this.template ?? 'base-image' },
      'E2B sandbox created',
    );
    return new E2BSandboxHandle(sandbox);
  }
}
