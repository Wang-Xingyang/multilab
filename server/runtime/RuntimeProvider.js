import { describeCopyStrategy } from '../workspace/WorkspaceStrategy.js';
import { createFindPollingWatcher } from '../workspace/FindPollingWatcher.js';
import { describeCapabilities } from './RuntimeContract.js';

/**
 * RuntimeProvider / RuntimeSession contract.
 *
 * Required on every provider:
 *   capabilities(kernel), probe(kernel), workspaceStrategy(kernel),
 *   planKernelSession(kernel), applyKernel(kernel), startSession()
 *
 * Required on every session:
 *   ensure, ensureWorkspace, writeFiles, readFiles, uploadScript,
 *   runCaptured(script, { timeoutMs }), attachTerminal, interrupt, resize,
 *   tempScriptPath, getPortMap, exec (fallback IO), watchFilesystem,
 *   pointWorkspace (retarget workspace at a save dir), dispose
 *
 * CommandService / SaveService must not import dockerode.
 */
export class RuntimeProvider {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind;
  }

  capabilities() {
    return describeCapabilities({ implemented: true });
  }

  async probe() {
    throw new Error('RuntimeProvider.probe() must be implemented');
  }

  /**
   * Describe how this provider places the live learner workspace for a kernel.
   * Default is copy into the session. Docker on Linux ext4 returns bind-mount.
   * Windows uses copy. Do not bind-mount NTFS.
   */
  workspaceStrategy(kernel) {
    return describeCopyStrategy({
      location: kernel?.workspace || this.workspaceDir,
    });
  }

  planKernelSession(kernel) {
    throw new Error('RuntimeProvider.planKernelSession() must be implemented');
  }

  async applyKernel() {
    // Optional. Docker mutates the reused session from the planned kernel.
  }

  async startSession() {
    throw new Error('RuntimeProvider.startSession() must be implemented');
  }
}

export class RuntimeSession {
  async ensure() {
    throw new Error('RuntimeSession.ensure() must be implemented');
  }

  async ensureWorkspace() {
    // Optional. Bind-mount providers create the save bind and align uids.
  }

  async exec() {
    throw new Error('RuntimeSession.exec() must be implemented');
  }

  async writeFiles() {
    throw new Error('RuntimeSession.writeFiles() must be implemented');
  }

  async readFiles() {
    throw new Error('RuntimeSession.readFiles() must be implemented');
  }

  async uploadScript() {
    throw new Error('RuntimeSession.uploadScript() must be implemented');
  }

  async runCaptured() {
    throw new Error('RuntimeSession.runCaptured() must be implemented');
  }

  async attachTerminal() {
    throw new Error('RuntimeSession.attachTerminal() must be implemented');
  }

  async interrupt() {
    throw new Error('RuntimeSession.interrupt() must be implemented');
  }

  async resize() {
    throw new Error('RuntimeSession.resize() must be implemented');
  }

  tempScriptPath(stepId, commandId) {
    return `/tmp/${stepId}.${commandId}.sh`;
  }

  getPortMap() {
    return {};
  }

  async pointWorkspace() {
    // Optional. Bind-mount sessions retarget /home/student/workspace
    // at the current step files/ directory (symlink, not an inner bind).
  }

  /**
   * Watch the workspace filesystem for structural changes. Default is the
   * find-polling fallback owned by WorkspaceService. Providers with native
   * watch should override this method; the contract (return { stop }) stays
   * the same.
   *
   * @returns {{ stop: () => void }}
   */
  watchFilesystem(onChange, opts = {}) {
    return createFindPollingWatcher(this, onChange, {
      ...opts,
      workspaceDir: opts.workspaceDir || this.workspaceDir,
    });
  }

  async exportWorkspaceArchive() {
    const error = new Error('workspace export is not supported by this runtime');
    error.statusCode = 501;
    throw error;
  }

  async dispose() {
    // Optional. Docker reuses one session/container; dropping the manager
    // handle must not stop the container.
  }
}
