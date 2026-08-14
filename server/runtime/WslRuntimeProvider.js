import { RuntimeProvider, RuntimeSession } from './RuntimeProvider.js';
import { describeHostLocalStrategy, DEFAULT_WORKSPACE_LOCATION } from '../workspace/WorkspaceStrategy.js';
import {
  describeCapabilities,
  describeProbe,
  unimplementedProviderError,
} from './RuntimeContract.js';

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

  capabilities() {
    return describeCapabilities({
      implemented: false,
      interactiveTerminal: true,
      capturedCommands: true,
      exec: true,
      previewPorts: false,
      workspaceRetarget: false,
      nativeWatch: Boolean(this.hostSavesDir),
    });
  }

  async probe(kernel = null) {
    return describeProbe({
      ok: false,
      implemented: false,
      ready: false,
      reason: 'provider_unimplemented',
      image: kernel?.image || null,
      capabilities: this.capabilities(kernel),
    });
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
    throw unimplementedProviderError('wsl', 'applyKernel');
  }

  async startSession() {
    throw unimplementedProviderError('wsl', 'startSession');
  }
}

export class WslRuntimeSession extends RuntimeSession {
  async ensure() {
    throw unimplementedProviderError('wsl', 'ensure');
  }

  async writeFiles() {
    throw unimplementedProviderError('wsl', 'writeFiles');
  }

  async readFiles() {
    throw unimplementedProviderError('wsl', 'readFiles');
  }

  async exec() {
    throw unimplementedProviderError('wsl', 'exec');
  }

  async uploadScript() {
    throw unimplementedProviderError('wsl', 'uploadScript');
  }

  async runCaptured() {
    throw unimplementedProviderError('wsl', 'runCaptured');
  }

  async attachTerminal() {
    throw unimplementedProviderError('wsl', 'attachTerminal');
  }

  async interrupt() {
    throw unimplementedProviderError('wsl', 'interrupt');
  }

  async resize() {
    throw unimplementedProviderError('wsl', 'resize');
  }
}
