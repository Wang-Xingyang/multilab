import path from 'path';
import { LANG_BY_EXT, validateFileName } from './PackageService.js';
import {
  DEFAULT_WORKSPACE_LOCATION,
  describeRuntimeInternalStrategy,
  resolveWorkspaceStrategy,
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
} from '../workspace/HostWorkspace.js';
import { parseFindTreeOutput, sortWorkspaceTreeEntries } from '../workspace/WorkspaceTree.js';

/**
 * Owns the live learner workspace: init, file IO, snapshot, tree listing,
 * and watch. Does not own package templates, save identity/progress, or
 * command execution.
 *
 * Physical placement is described by a WorkspaceStrategy chosen by the
 * runtime provider. Docker on Linux/WSL ext4 bind-mounts a host directory
 * and this service reads/writes that path directly. Other platforms keep
 * the runtime-internal copy/sync fallback through RuntimeSession.
 */
export class WorkspaceService {
  constructor({
    runtimeManager = null,
    runtimeSession = null,
    workspaceDir = DEFAULT_WORKSPACE_LOCATION,
  } = {}) {
    this.runtimeManager = runtimeManager;
    this.runtimeSession = runtimeSession;
    this.workspaceDir = workspaceDir;
  }

  describe() {
    return resolveWorkspaceStrategy({
      provider: this.#providerForActiveKernel(),
      kernel: this.runtimeManager?.getActiveKernel?.() || null,
      session: this.#tryGetSession(),
      workspaceDir: this.workspaceDir,
    });
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

  async syncFromFiles(files, { tutorialId = null, clear = true } = {}) {
    await this.ensure({ tutorialId });
    await this.writeFiles(files, { clear });
  }

  async writeFiles(files, opts = {}) {
    const strategy = this.describe();
    if (usesHostFilesystem(strategy)) {
      await writeHostWorkspaceFiles(strategy, files, opts);
      return;
    }
    const session = await this.resolveSession(opts.tutorialId);
    const normalized = (files || []).map(file => {
      const name = validateFileName(file.name || 'untitled');
      return { name, content: file.content || '' };
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
        'find', target, '-maxdepth', String(maxDepth), '-mindepth', '1',
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
      return writeHostWorkspaceFile(strategy, target, content);
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
    const strategy = this.describe();
    if (usesHostFilesystem(strategy) && strategy.capabilities.nativeWatch) {
      try {
        return createHostFsWatcher(strategy, onChange, opts);
      } catch (error) {
        console.warn(`[workspace] host watch unavailable, using find-polling: ${error.message}`);
      }
    }
    const session = this.getSession();
    if (typeof session.watchFilesystem === 'function') {
      return session.watchFilesystem(onChange, opts);
    }
    return createFindPollingWatcher(session, onChange, {
      ...opts,
      workspaceDir: this.workspaceRoot(),
    });
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
  const name = validateFileName(file.name);
  const ext = path.extname(name).toLowerCase();
  return {
    name,
    content: file.content,
    language: LANG_BY_EXT[ext] || 'plaintext',
  };
}

export { parseFindTreeOutput, sortWorkspaceTreeEntries } from '../workspace/WorkspaceTree.js';
export { describeRuntimeInternalStrategy, DEFAULT_WORKSPACE_LOCATION };
