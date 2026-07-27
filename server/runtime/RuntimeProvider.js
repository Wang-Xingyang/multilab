export class RuntimeProvider {
  constructor({ id, kind }) {
    this.id = id;
    this.kind = kind;
  }

  async startSession() {
    throw new Error('RuntimeProvider.startSession() must be implemented');
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
   * Watch the workspace filesystem for structural changes (add / delete /
   * rename of files or directories). The default implementation polls `find`
   * via exec() — works for any provider whose environment ships coreutils
   * (docker / WSL / SSH). Providers with a faster native mechanism (e.g. a
   * local provider using fs.watch, or an image that opts into inotify) may
   * override this method; the contract (return { stop }) stays the same.
   *
   * onChange() is invoked when the set of file/dir paths changes. Content
   * edits to an existing file do NOT fire onChange — the file tree only
   * reflects structure, not contents.
   *
   * @returns {{ stop: () => void }}
   */
  watchFilesystem(onChange, { intervalMs = 1000, maxDepth = 6 } = {}) {
    if (typeof onChange !== 'function') {
      throw new TypeError('watchFilesystem: onChange must be a function');
    }
    if (!this.workspaceDir) {
      throw new Error('watchFilesystem: session.workspaceDir is required by the default polling implementation');
    }
    const cmd = [
      'find', this.workspaceDir,
      '-maxdepth', String(maxDepth), '-mindepth', '1',
      '(', '-type', 'f', '-o', '-type', 'd', ')',
      '-printf', '%y\t%P\n',
    ];

    let timer = null;
    let lastSignature = null;
    let inFlight = false;
    let stopped = false;

    const tick = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const r = await this.exec(cmd, { cwd: '/' });
        if (stopped) return;
        if (r.exitCode !== 0) return; // transient (container restarting, etc.)
        const sig = r.stdout;
        if (lastSignature !== null && sig !== lastSignature) {
          onChange();
        }
        lastSignature = sig;
      } catch {
        // swallow — next tick retries
      } finally {
        inFlight = false;
      }
    };

    // Seed the signature immediately, then poll.
    tick();
    timer = setInterval(tick, intervalMs);

    return {
      stop() {
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
      },
    };
  }
}

