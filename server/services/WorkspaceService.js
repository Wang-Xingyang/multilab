import path from 'path';
import { LANG_BY_EXT, validateFileName, validateWorkspaceRelPath } from './PackageService.js';
import {
  DEFAULT_WORKSPACE_LOCATION,
  WORKSPACE_STRATEGY_KINDS,
  describeCopyStrategy,
  describeRuntimeInternalStrategy,
  resolveWorkspaceStrategy,
  usesCopyStrategy,
  usesHostFilesystem,
} from '../workspace/WorkspaceStrategy.js';
import { createFindPollingWatcher } from '../workspace/FindPollingWatcher.js';
import { createHostFsWatcher } from '../workspace/HostFsWatcher.js';
import {
  listHostWorkspaceFiles,
  listHostWorkspaceTree,
  readHostWorkspaceFile,
  readHostWorkspaceFiles,
  writeHostWorkspaceFile,
  writeHostWorkspaceFiles,
  clearHostDirContents,
  isHostPermissionError,
  wipeBindMountViaExec,
  relaxBindMountViaExec,
} from '../workspace/HostWorkspace.js';
import { parseFindTreeOutput, sortWorkspaceTreeEntries } from '../workspace/WorkspaceTree.js';

/**
 * Owns the live learner workspace: init, file IO, snapshot, tree listing,
 * and watch. Does not own package templates, save identity/progress, or
 * command execution.
 *
 * Physical placement is described by a WorkspaceStrategy chosen by the
 * runtime provider. Linux ext4 bind-mounts the host save tree and this
 * service reads/writes that path directly. Windows copies the current
 * step through RuntimeSession.
 */
export class WorkspaceService {
  #watchers = [];

  constructor({
    runtimeManager = null,
    runtimeSession = null,
    workspaceDir = DEFAULT_WORKSPACE_LOCATION,
  } = {}) {
    this.runtimeManager = runtimeManager;
    this.runtimeSession = runtimeSession;
    this.workspaceDir = workspaceDir;
    this.attachedHostPath = null;
  }

  /** Drop the live-host pointer without flushing. Used before a kernel switch. */
  forgetLiveHost() {
    this.attachedHostPath = null;
  }

  describe() {
    const base = resolveWorkspaceStrategy({
      provider: this.#providerForActiveKernel(),
      kernel: this.runtimeManager?.getActiveKernel?.() || null,
      session: this.#tryGetSession(),
      workspaceDir: this.workspaceDir,
    });
    if (this.attachedHostPath && usesHostFilesystem(base)) {
      return {
        ...base,
        hostPath: this.attachedHostPath,
        bindHostPath: base.hostPath,
      };
    }
    return base;
  }

  workspaceRoot() {
    return this.describe().location || this.workspaceDir || DEFAULT_WORKSPACE_LOCATION;
  }

  validatePath(input) {
    const root = this.workspaceRoot();
    const raw = input || root;
    const joined = String(raw).startsWith('/') ? raw : path.posix.join(root, raw);
    const resolved = path.posix.resolve(joined);
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw Object.assign(new Error('Access denied'), { statusCode: 403 });
    }
    return resolved;
  }

  async ensure({ tutorialId = null } = {}) {
    const session = await this.resolveSession(tutorialId);
    if (typeof session.ensureWorkspace === 'function') {
      await session.ensureWorkspace();
    }
    return session;
  }

  /**
   * Make this step's save directory the live workspace.
   * Bind-mount: host IO uses that directory; Docker bind-mounts the host
   * save tree once at /mlab/saves and retargets /home/student/workspace
   * with a symlink at the current step files/. Switching tutorials does
   * not recreate the container.
   * Copy (Windows): snapshot the previous live step back to host, then
   * write only this step's files into the session workspace.
   */
  async useSaveWorkspace({
    hostPath,
    containerPath = null,
    files = null,
    tutorialId = null,
  } = {}) {
    const nextHost = hostPath ? path.resolve(hostPath) : null;
    if (this.attachedHostPath && usesCopyStrategy(this.describe())) {
      await this.flushLiveToHost({ hostPath: this.attachedHostPath, tutorialId });
    }
    this.attachedHostPath = nextHost;
    await this.ensure({ tutorialId });
    const strategy = this.describe();
    if (usesHostFilesystem(strategy) && (containerPath || nextHost)) {
      const session = await this.resolveSession(tutorialId);
      if (typeof session.pointWorkspace === 'function') {
        const target = strategy.kind === WORKSPACE_STRATEGY_KINDS.HOST_LOCAL
          ? nextHost
          : containerPath;
        if (target) await session.pointWorkspace(target);
      }
      this.#restartWatchers();
      return;
    }
    await this.writeFiles(files || [], { clear: true, tutorialId });
  }

  usesHostBackedSave() {
    return usesHostFilesystem(this.describe());
  }

  /**
   * Copy the live workspace back onto a host save directory.
   * No-op on bind-mount (live is already that directory).
   */
  async flushLiveToHost({ hostPath = this.attachedHostPath, tutorialId = null } = {}) {
    const dest = hostPath ? path.resolve(hostPath) : null;
    if (!dest) return { skipped: true, reason: 'no-host' };
    if (usesHostFilesystem(this.describe())) {
      return { skipped: true, reason: 'bind-mount' };
    }
    const live = await this.snapshot({ tutorialId });
    await writeHostWorkspaceFiles({ hostPath: dest }, live, { clear: true });
    return { skipped: false, files: live };
  }

  async syncFromFiles(files, { tutorialId = null, clear = true } = {}) {
    await this.ensure({ tutorialId });
    await this.writeFiles(files, { clear });
  }

  async writeFiles(files, opts = {}) {
    const strategy = this.describe();
    if (usesHostFilesystem(strategy)) {
      if (opts.clear !== false) {
        await this.#clearBindMountWorkspace(strategy, opts.tutorialId);
      }
      try {
        await writeHostWorkspaceFiles(strategy, files, { clear: false });
      } catch (error) {
        if (!isHostPermissionError(error)) throw error;
        await this.#relaxBindMountWorkspace(strategy, opts.tutorialId);
        await writeHostWorkspaceFiles(strategy, files, { clear: false });
      }
      return;
    }
    const session = await this.resolveSession(opts.tutorialId);
    const normalized = (files || []).map(file => {
      const name = validateWorkspaceRelPath(file.name || 'untitled');
      if (file.type === 'dir') return { name, type: 'dir' };
      return { name, type: 'file', content: file.content || '' };
    });
    await session.writeFiles(normalized, opts);
  }

  async snapshot({ tutorialId = null } = {}) {
    const strategy = this.describe();
    if (usesHostFilesystem(strategy)) {
      const files = await readHostWorkspaceFiles(strategy);
      return files.map(file => annotateWorkspaceFile(file));
    }
    const session = await this.resolveSession(tutorialId);
    const files = await session.readFiles();
    return files.map(file => annotateWorkspaceFile(file));
  }

  async listFiles({ dir } = {}) {
    const strategy = this.describe();
    if (usesHostFilesystem(strategy)) {
      this.validatePath(dir || this.workspaceRoot());
      return listHostWorkspaceFiles(strategy, dir);
    }
    const session = await this.resolveSession();
    const target = this.validatePath(dir || this.workspaceRoot());
    const result = await session.exec(
      ['find', target, '-maxdepth', '1', '-mindepth', '1', '-type', 'f', '-printf', '%f\n'],
      { cwd: '/' },
    );
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || 'ls failed'), { statusCode: 500 });
    }
    const files = result.stdout.trim().split('\n').filter(Boolean).map(name => {
      validateFileName(name);
      return { name, type: 'file' };
    });
    return { path: target, files };
  }

  async listTree({ dir, depth } = {}) {
    const strategy = this.describe();
    if (usesHostFilesystem(strategy)) {
      this.validatePath(dir || this.workspaceRoot());
      return listHostWorkspaceTree(strategy, { dir, depth });
    }
    const session = await this.resolveSession();
    const target = this.validatePath(dir || this.workspaceRoot());
    const maxDepth = Math.min(6, Math.max(1, Number(depth) || 4));
    const result = await session.exec(
      [
        'find', '-H', target, '-maxdepth', String(maxDepth), '-mindepth', '1',
        '(', '-type', 'f', '-o', '-type', 'd', ')',
        '-printf', '%y\t%P\n',
      ],
      { cwd: '/' },
    );
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || 'ls tree failed'), { statusCode: 500 });
    }
    const entries = parseFindTreeOutput(result.stdout, target, abs => this.validatePath(abs));
    sortWorkspaceTreeEntries(entries);
    return { path: target, tree: true, depth: maxDepth, entries };
  }

  async readFile(filePath) {
    const strategy = this.describe();
    const target = this.validatePath(filePath);
    if (usesHostFilesystem(strategy)) {
      return readHostWorkspaceFile(strategy, target);
    }
    const session = await this.resolveSession();
    const result = await session.exec(['cat', target]);
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || 'read failed'), { statusCode: 500 });
    }
    return { path: target, content: result.stdout };
  }

  async writeFile(filePath, content) {
    const strategy = this.describe();
    const target = this.validatePath(filePath);
    if (usesHostFilesystem(strategy)) {
      try {
        return await writeHostWorkspaceFile(strategy, target, content);
      } catch (error) {
        if (!isHostPermissionError(error)) throw error;
        await this.#relaxBindMountWorkspace(strategy);
        return writeHostWorkspaceFile(strategy, target, content);
      }
    }
    const session = await this.resolveSession();
    await session.uploadScript(content, target);
    return { path: target, saved: true };
  }

  async exportArchive() {
    const session = await this.resolveSession();
    if (typeof session.exportWorkspaceArchive !== 'function') {
      throw Object.assign(new Error('workspace export is not supported by this runtime'), { statusCode: 501 });
    }
    return session.exportWorkspaceArchive();
  }

  watch(onChange, opts = {}) {
    const started = this.#startWatch(onChange, opts);
    const entry = { onChange, opts, handle: started };
    this.#watchers.push(entry);
    return {
      stop: () => {
        entry.handle?.stop?.();
        this.#watchers = this.#watchers.filter(item => item !== entry);
      },
    };
  }

  #startWatch(onChange, opts = {}) {
    const strategy = this.describe();
    const handles = [];
    if (usesHostFilesystem(strategy) && strategy.capabilities.nativeWatch) {
      try {
        handles.push(createHostFsWatcher(strategy, onChange, opts));
      } catch (error) {
        console.warn(`[workspace] host watch unavailable, using find-polling: ${error.message}`);
      }
    }
    try {
      const session = this.getSession();
      if (typeof session.exec === 'function') {
        handles.push(createFindPollingWatcher(session, onChange, {
          ...opts,
          intervalMs: handles.length ? (opts.intervalMs || 1200) : (opts.intervalMs || 1000),
          workspaceDir: session.workspaceDir || this.workspaceDir,
        }));
      } else if (!handles.length && typeof session.watchFilesystem === 'function') {
        handles.push(session.watchFilesystem(onChange, opts));
      }
    } catch (error) {
      if (!handles.length) {
        console.warn(`[workspace] find-polling unavailable: ${error.message}`);
      }
    }
    if (!handles.length) {
      return { stop() {} };
    }
    return {
      stop() {
        for (const handle of handles) {
          try { handle.stop?.(); } catch { /* already stopped */ }
        }
      },
    };
  }

  #restartWatchers() {
    for (const entry of this.#watchers) {
      try {
        entry.handle?.stop?.();
      } catch {
        // previous watcher may already be stopped
      }
      entry.handle = this.#startWatch(entry.onChange, entry.opts);
    }
  }

  async resolveSession(tutorialId = null) {
    if (this.runtimeManager) {
      if (tutorialId) {
        const ensured = await this.runtimeManager.ensureForTutorial(tutorialId);
        return ensured.session;
      }
      return this.runtimeManager.getSession();
    }
    if (!this.runtimeSession) {
      throw Object.assign(new Error('runtime session is not ready'), { statusCode: 503 });
    }
    return this.runtimeSession;
  }

  getSession() {
    if (this.runtimeManager) return this.runtimeManager.getSession();
    if (!this.runtimeSession) {
      throw Object.assign(new Error('runtime session is not ready'), { statusCode: 503 });
    }
    return this.runtimeSession;
  }

  async #clearBindMountWorkspace(strategy, tutorialId = null) {
    try {
      await clearHostDirContents(strategy.hostPath);
      return;
    } catch (error) {
      if (!isHostPermissionError(error)) throw error;
    }
    const session = await this.resolveSession(tutorialId);
    await wipeBindMountViaExec(session.exec?.bind(session), strategy.location);
    await clearHostDirContents(strategy.hostPath);
  }

  async #relaxBindMountWorkspace(strategy, tutorialId = null) {
    const session = await this.resolveSession(tutorialId);
    const relaxed = await relaxBindMountViaExec(session.exec?.bind(session), strategy.location);
    if (!relaxed) {
      throw Object.assign(new Error('workspace files are not writable from the host'), { statusCode: 500 });
    }
  }

  #tryGetSession() {
    try {
      return this.getSession();
    } catch {
      return null;
    }
  }

  #providerForActiveKernel() {
    const kernel = this.runtimeManager?.getActiveKernel?.();
    if (!kernel || !this.runtimeManager) return null;
    try {
      return this.runtimeManager.getProviderForKernel(kernel);
    } catch {
      return null;
    }
  }
}

export function annotateWorkspaceFile(file) {
  const name = validateWorkspaceRelPath(file.name);
  if (file.type === 'dir') return { name, type: 'dir' };
  const ext = path.extname(name).toLowerCase();
  return {
    name,
    type: 'file',
    content: file.content,
    language: LANG_BY_EXT[ext] || 'plaintext',
  };
}

export { parseFindTreeOutput, sortWorkspaceTreeEntries } from '../workspace/WorkspaceTree.js';
export { describeCopyStrategy, describeRuntimeInternalStrategy, DEFAULT_WORKSPACE_LOCATION };
