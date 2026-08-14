import { describeRuntimeInternalStrategy } from '../workspace/WorkspaceStrategy.js';
import { createFindPollingWatcher } from '../workspace/FindPollingWatcher.js';

export class RuntimeProvider {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind;
  }

  async startSession() {
    throw new Error('RuntimeProvider.startSession() must be implemented');
  }

  /**
   * Describe how this provider places the live learner workspace for a kernel.
   * Default is runtime-internal (files inside the session, IO via exec).
   * Providers may return bind-mount / volume-sync / host-local instead.
   */
  workspaceStrategy(kernel) {
    return describeRuntimeInternalStrategy({
      location: kernel?.workspace || this.workspaceDir,
    });
  }
}

export class RuntimeSession {
  async ensure() {
    throw new Error('RuntimeSession.ensure() must be implemented');
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
}

