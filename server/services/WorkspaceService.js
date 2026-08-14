import path from 'path';
import { LANG_BY_EXT, validateFileName } from './PackageService.js';
import {
  DEFAULT_WORKSPACE_LOCATION,
  describeRuntimeInternalStrategy,
  resolveWorkspaceStrategy,
} from '../workspace/WorkspaceStrategy.js';
import { createFindPollingWatcher } from '../workspace/FindPollingWatcher.js';

/**
 * Owns the live learner workspace: init, file IO, snapshot, tree listing,
 * and watch. Does not own package templates, save identity/progress, or
 * command execution.
 *
 * Physical placement is described by a WorkspaceStrategy chosen by the
 * runtime provider. The current Docker provider uses runtime-internal
 * IO through RuntimeSession (copy in/out via exec). Bind-mount / volume
 * / host-local strategies can replace that later without changing callers.
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
    const session = await this.resolveSession(opts.tutorialId);
    const normalized = (files || []).map(file => {
      const name = validateFileName(file.name || 'untitled');
      return { name, content: file.content || '' };
    });
    await session.writeFiles(normalized, opts);
  }

  async snapshot({ tutorialId = null } = {}) {
    const session = await this.resolveSession(tutorialId);
    const files = await session.readFiles();
    return files.map(file => annotateWorkspaceFile(file));
  }

  async listFiles({ dir } = {}) {
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
    const session = await this.resolveSession();
    const target = this.validatePath(filePath);
    const result = await session.exec(['cat', target]);
    if (result.exitCode !== 0) {
      throw Object.assign(new Error(result.stderr || 'read failed'), { statusCode: 500 });
    }
    return { path: target, content: result.stdout };
  }

  async writeFile(filePath, content) {
    const session = await this.resolveSession();
    const target = this.validatePath(filePath);
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

export function parseFindTreeOutput(stdout, dir, validatePath) {
  const entries = [];
  for (const line of String(stdout || '').trim().split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kind = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    if (!rel || rel.includes('\0') || rel.split('/').some(part => part === '..')) continue;
    const abs = path.posix.join(dir, rel);
    validatePath(abs);
    entries.push({
      name: path.posix.basename(rel),
      path: abs,
      relative: rel,
      type: kind === 'd' ? 'dir' : 'file',
    });
  }
  return entries;
}

export function sortWorkspaceTreeEntries(entries) {
  const dirRels = new Set(entries.filter(entry => entry.type === 'dir').map(entry => entry.relative));
  entries.sort((a, b) => {
    const pa = a.relative.split('/');
    const pb = b.relative.split('/');
    const len = Math.min(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      if (pa[i] !== pb[i]) {
        const aIsDir = dirRels.has(pa.slice(0, i + 1).join('/'));
        const bIsDir = dirRels.has(pb.slice(0, i + 1).join('/'));
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return pa[i].localeCompare(pb[i]);
      }
    }
    return pa.length - pb.length;
  });
  return entries;
}

export { describeRuntimeInternalStrategy, DEFAULT_WORKSPACE_LOCATION };
