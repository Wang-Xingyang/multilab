import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';
import { describeHostLocalStrategy, DEFAULT_WORKSPACE_LOCATION } from '../workspace/WorkspaceStrategy.js';

function notImplemented(method) {
  const error = new Error(
    `WSL runtime provider is a placeholder; ${method} is not implemented yet`
  );
  error.statusCode = 501;
  error.code = 'provider_unimplemented';
  error.provider = 'wsl';
  return error;
}

/**
 * Placeholder WSL provider. The session contract matches Docker/local:
 * the step save directory is the workspace. A later implementation should
 * exec into a WSL distro with cwd at that host path — no Docker mount,
 * no GNU-to-PowerShell mapping.
 */
export class WslRuntimeProvider extends RuntimeProvider {
  constructor({
    workspaceDir = DEFAULT_WORKSPACE_LOCATION,
    hostSavesDir = null,
  } = {}) {
    super({ id: 'wsl', kind: 'wsl' });
    this.workspaceDir = workspaceDir;
    this.hostSavesDir = hostSavesDir;
  }

  planKernelSession(kernel) {
    return {
      kernel,
      fingerprint: `wsl:${kernel.id}:unimplemented`,
      workspaceDir: kernel.workspace || this.workspaceDir,
      workspaceStrategy: this.workspaceStrategy(kernel),
    };
  }

  workspaceStrategy(kernel) {
    if (!this.hostSavesDir) {
      return super.workspaceStrategy(kernel);
    }
    return describeHostLocalStrategy({
      location: kernel?.workspace || this.workspaceDir,
      hostPath: this.hostSavesDir,
      reason: 'wsl-placeholder',
    });
  }

  async applyKernel() {
    throw notImplemented('applyKernel');
  }

  async startSession() {
    throw notImplemented('startSession');
  }
}

export class WslRuntimeSession extends RuntimeSession {
  async ensure() {
    throw notImplemented('ensure');
  }

  async writeFiles() {
    throw notImplemented('writeFiles');
  }

  async readFiles() {
    throw notImplemented('readFiles');
  }

  async uploadScript() {
    throw notImplemented('uploadScript');
  }

  async runCaptured() {
    throw notImplemented('runCaptured');
  }

  async attachTerminal() {
    throw notImplemented('attachTerminal');
  }

  async interrupt() {
    throw notImplemented('interrupt');
  }

  async resize() {
    throw notImplemented('resize');
  }
}
