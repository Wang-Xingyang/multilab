import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { normalizePanels, resolveStepPanels } from './PanelModel.js';

export const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
  '.sh': 'bash', '.rs': 'rust', '.go': 'go', '.java': 'java',
};

const MANIFEST_FILE = 'multilab.json';
const VALID_INHERIT_MODES = new Set(['template', 'previous_save', 'overlay_template']);
const INSTALLED_SOURCE_PREFIX = 'pkg-';

/** Tutorial Markdown images from the package (`<img src>`), including SVG. */
export const CONTENT_ASSET_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
export const MAX_CONTENT_ASSET_BYTES = 5 * 1024 * 1024;

/** Headers for GET /api/tutorials/:id/assets. CSP sandbox lets <img> paint
 *  SVG while opening the asset URL as a document cannot run package script. */
export function contentAssetResponseHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };
}

export function validateId(id) {
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id)) {
    throw Object.assign(new Error('Invalid identifier'), { statusCode: 400 });
  }
}

export function validateSafePath(id) {
  validateId(id);
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw Object.assign(new Error('Invalid path'), { statusCode: 400 });
  }
  return id;
}

export function validateFileName(name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw Object.assign(new Error('Invalid file name'), { statusCode: 400 });
  }
  return name;
}

export function validateWorkspaceRelPath(relPath) {
  const raw = String(relPath || '');
  if (!raw || raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
    throw Object.assign(new Error('Invalid workspace path'), { statusCode: 400 });
  }
  const parts = raw.split('/');
  if (parts.length > 8 || parts.some(part => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error('Invalid workspace path'), { statusCode: 400 });
  }
  for (const part of parts) validateFileName(part);
  return parts.join('/');
}

export function stepInheritMode(step) {
  const explicit = step.inherit_mode;
  if (explicit && VALID_INHERIT_MODES.has(explicit)) return explicit;
  return step.chain ? 'previous_save' : 'template';
}

export function stepNeedsEdit(step) {
  return step?.needs_edit !== false;
}

export function stepAllowsReadOnlyCommand(step, commandType) {
  return !stepNeedsEdit(step) && commandType === 'preview';
}

export function stepHasTest(step) {
  return (step?.commands || []).some(cmd => cmd && cmd.type === 'test');
}

export function stepChain(step) {
  return typeof step?.chain === 'string' && step.chain ? step.chain : null;
}

export function findStep(cfg, stepId) {
  const step = (cfg.steps || []).find(s => s.id === stepId);
  if (!step) throw Object.assign(new Error(`step not found: ${stepId}`), { statusCode: 404 });
  return step;
}

function validatePackageRelativePath(relPath) {
  if (!relPath || path.isAbsolute(relPath)) {
    throw Object.assign(new Error('Invalid package path'), { statusCode: 400 });
  }
  const normalized = path.normalize(relPath);
  if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
    throw Object.assign(new Error('Invalid package path'), { statusCode: 400 });
  }
  return normalized;
}

function resolvePackagePath(tutorialDir, relPath) {
  const safeRel = validatePackageRelativePath(relPath);
  const resolved = path.resolve(tutorialDir, safeRel);
  if (!isInsideDir(tutorialDir, resolved)) {
    throw Object.assign(new Error('Package path escapes tutorial directory'), { statusCode: 403 });
  }
  return resolved;
}

function isInsideDir(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isContentAssetUrl(relPath) {
  const raw = String(relPath || '').trim();
  return !raw || raw.includes('\0') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith('//');
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readWorkspaceTree(rootDir, languageFallback) {
  const files = [];
  async function walk(dir, relative) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
      const childRel = relative ? `${relative}/${entry.name}` : entry.name;
      try {
        validateWorkspaceRelPath(childRel);
      } catch {
        continue;
      }
      if (entry.isDirectory()) {
        files.push({ name: childRel, type: 'dir' });
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        const ext = path.extname(childRel).toLowerCase();
        files.push({
          name: childRel,
          type: 'file',
          content: await fs.readFile(path.join(dir, entry.name), 'utf8'),
          language: LANG_BY_EXT[ext] || languageFallback || 'plaintext',
        });
      }
    }
  }
  await walk(rootDir, '');
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function listPackageFiles(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listPackageFiles(rootDir, absPath));
    } else if (entry.isFile()) {
      files.push(path.relative(rootDir, absPath).split(path.sep).join('/'));
    }
  }
  return files;
}

export async function computePackageDigest(tutorialDir) {
  const hash = crypto.createHash('sha256');
  const files = await listPackageFiles(tutorialDir);
  for (const relPath of files) {
    const content = await fs.readFile(path.join(tutorialDir, relPath));
    hash.update('file\0');
    hash.update(relPath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function commandForType(step, type) {
  return (step.commands || []).find(cmd => cmd && (cmd.type === type || cmd.id === type));
}

function commandScriptPath(tutorialDir, step, type) {
  const command = commandForType(step, type);
  if (!command?.script) return null;
  return resolvePackagePath(tutorialDir, command.script);
}

export class PackageService {
  constructor({ tutorialsDir, packageLibrary = null }) {
    this.tutorialsDir = tutorialsDir;
    this.packageLibrary = packageLibrary;
  }

  async listTutorialSummaries() {
    const tutorials = [];
    const entries = await fs.readdir(this.tutorialsDir, { withFileTypes: true }).catch(e => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const { cfg, source, packageFormat, sourceFile, packageDigest } = await this.loadTutorialConfig(entry.name);
        tutorials.push({
          id: source.sourceKey,
          source_key: source.sourceKey,
          source_type: source.sourceType,
          package_id: cfg.id,
          title: cfg.title,
          description: cfg.description,
          language: cfg.language,
          version: cfg.version || '0.0.0',
          package_digest: packageDigest,
          schema_version: cfg.schema_version || 0,
          package_format: packageFormat,
          source_file: sourceFile,
          steps: (cfg.steps || []).length,
        });
      } catch {
        // Keep listing tolerant: invalid package directories are skipped.
      }
    }
    for (const source of await this.listInstalledSources()) {
      try {
        const { cfg, packageFormat, sourceFile, packageDigest } = await this.loadTutorialConfig(source.sourceKey);
        tutorials.push({
          id: source.sourceKey,
          source_key: source.sourceKey,
          source_type: source.sourceType,
          package_id: cfg.id,
          title: cfg.title,
          description: cfg.description,
          language: cfg.language,
          version: cfg.version || '0.0.0',
          package_digest: packageDigest,
          schema_version: cfg.schema_version || 0,
          package_format: packageFormat,
          source_file: sourceFile,
          steps: (cfg.steps || []).length,
        });
      } catch {
        // Keep listing tolerant: invalid installed packages are skipped.
      }
    }
    return tutorials;
  }

  async loadTutorialConfig(tutorialKey) {
    validateSafePath(tutorialKey);
    const source = await this.resolvePackageSource(tutorialKey);
    const tutorialDir = source.tutorialDir;
    const manifestPath = path.join(tutorialDir, MANIFEST_FILE);
    const cfg = await readJsonFile(manifestPath);
    cfg.id = cfg.id || source.packageId || tutorialKey;
    const packageDigest = await computePackageDigest(tutorialDir);
    return {
      cfg,
      tutorialDir,
      source,
      packageFormat: source.packageFormat,
      sourceFile: MANIFEST_FILE,
      packageDigest,
    };
  }

  async loadTutorial(tutorialKey) {
    const { cfg, tutorialDir, source, packageFormat, sourceFile, packageDigest } = await this.loadTutorialConfig(tutorialKey);
    cfg.source_key = source.sourceKey;
    cfg.source_type = source.sourceType;
    cfg.package_id = cfg.id;
    cfg.package_format = packageFormat;
    cfg.source_file = sourceFile;
    cfg.package_digest = packageDigest;
    cfg.schema_version = cfg.schema_version || 0;
    cfg.version = cfg.version || '0.0.0';
    cfg.ui_panels = normalizePanels(cfg.default_panels);

    for (const step of cfg.steps || []) {
      validateSafePath(step.id);
      const stepDir = path.join(tutorialDir, 'steps', step.id);
      step.inherit_mode = stepInheritMode(step);
      step.needs_edit = stepNeedsEdit(step);
      step.ui_panels = resolveStepPanels(cfg.ui_panels, step.panels);

      try {
        step.instructions = await fs.readFile(path.join(stepDir, 'instructions.md'), 'utf8');
      } catch {
        step.instructions = '';
      }

      step.files = await readWorkspaceTree(path.join(stepDir, 'files'), cfg.language);
      step.solution_files = await readWorkspaceTree(path.join(stepDir, 'solution'), cfg.language);
      step.has_solution = step.solution_files.some(file => file.type === 'file');

      step.commands = await Promise.all((step.commands || []).map(async command => {
        const scriptPath = command?.script ? resolvePackagePath(tutorialDir, command.script) : null;
        return {
          id: command.id,
          type: command.type,
          label: command.label || command.id || command.type,
          terminal: command.terminal || (command.type === 'run' ? 'interactive' : 'captured'),
          timeout_sec: command.timeout_sec,
          available: Boolean(scriptPath && await pathExists(scriptPath)),
        };
      }));
    }
    return cfg;
  }

  /**
   * Resolve a tutorial-panel image from the package (not the live workspace).
   * `relPath` is the Markdown/HTML src as authored. When `stepId` is set,
   * resolve relative to `steps/<stepId>/` first, then the package root so
   * both `./diagram.png` and `assets/foo.png` work.
   */
  async resolveContentAsset(tutorialKey, relPath, { stepId } = {}) {
    const raw = String(relPath || '').trim().replace(/\\/g, '/');
    if (isContentAssetUrl(raw) || path.isAbsolute(raw)) {
      throw Object.assign(new Error('Invalid content asset path'), { statusCode: 400 });
    }

    const source = await this.resolvePackageSource(tutorialKey);
    const tutorialDir = source.tutorialDir;
    const bases = [];
    if (stepId) {
      validateSafePath(stepId);
      bases.push(path.join(tutorialDir, 'steps', stepId));
    }
    bases.push(tutorialDir);

    let lastDeniedType = false;
    for (const base of bases) {
      const absPath = path.resolve(base, raw);
      if (!isInsideDir(tutorialDir, absPath)) {
        throw Object.assign(new Error('Content asset path escapes package directory'), { statusCode: 403 });
      }
      let st;
      try {
        st = await fs.stat(absPath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const ext = path.extname(absPath).toLowerCase();
      const contentType = CONTENT_ASSET_MIME[ext];
      if (!contentType) {
        lastDeniedType = true;
        continue;
      }
      if (st.size > MAX_CONTENT_ASSET_BYTES) {
        throw Object.assign(new Error('Content asset too large'), { statusCode: 413 });
      }
      return {
        absPath,
        contentType,
        bytes: st.size,
        relPath: path.relative(tutorialDir, absPath).split(path.sep).join('/'),
      };
    }

    throw Object.assign(
      new Error(lastDeniedType ? 'Unsupported content asset type' : 'Content asset not found'),
      { statusCode: lastDeniedType ? 415 : 404 }
    );
  }

  async getStepCommandScript(tutorialKey, stepId, commandIdOrType) {
    const { cfg, tutorialDir } = await this.loadTutorialConfig(tutorialKey);
    const step = findStep(cfg, stepId);
    const command = commandForType(step, commandIdOrType);
    if (!command) {
      throw Object.assign(new Error(`command not found: ${commandIdOrType}`), { statusCode: 404 });
    }
    const scriptPath = commandScriptPath(tutorialDir, step, commandIdOrType);
    if (!scriptPath || !(await pathExists(scriptPath))) {
      throw Object.assign(new Error(`command script not found: ${commandIdOrType}`), { statusCode: 404 });
    }
    return {
      cfg,
      step,
      command,
      script: await fs.readFile(scriptPath, 'utf8'),
    };
  }

  async resolvePackageSource(tutorialKey) {
    const developmentDir = path.join(this.tutorialsDir, tutorialKey);
    if (await pathExists(path.join(developmentDir, MANIFEST_FILE))) {
      return {
        sourceKey: tutorialKey,
        sourceType: 'development',
        packageId: tutorialKey,
        tutorialDir: developmentDir,
        packageFormat: 'multilab',
      };
    }

    const installedSources = await this.listInstalledSources();
    const exactInstalled = installedSources.find(source => source.sourceKey === tutorialKey);
    if (exactInstalled) return exactInstalled;

    const matchingInstalled = installedSources.filter(source => source.packageId === tutorialKey);
    if (matchingInstalled.length === 1) return matchingInstalled[0];
    if (matchingInstalled.length > 1) {
      throw Object.assign(
        new Error(`ambiguous installed package id: ${tutorialKey}`),
        { statusCode: 409 }
      );
    }

    throw Object.assign(new Error(`tutorial not found: ${tutorialKey}`), { statusCode: 404 });
  }

  async listInstalledSources() {
    if (!this.packageLibrary) return [];
    const records = await this.packageLibrary.listPackages();
    return records
      .filter(record => record?.unpacked_dir && record?.digest)
      .map(record => ({
        sourceKey: packageSourceKey(record),
        sourceType: 'installed',
        packageId: record.id,
        tutorialDir: record.unpacked_dir,
        packageFormat: record.package_format || 'mlab',
        record,
      }));
  }

  async findSourceByPackageIdentity({ id, version, digest }) {
    const packageId = String(id || '');
    const packageVersion = String(version || '0.0.0');
    const packageDigest = String(digest || '');
    if (!packageId || !packageDigest) {
      throw Object.assign(new Error('package id and digest required'), { statusCode: 400 });
    }
    const tutorials = await this.listTutorialSummaries();
    return tutorials.find(tutorial => (
      tutorial.package_id === packageId
      && (tutorial.version || '0.0.0') === packageVersion
      && tutorial.package_digest === packageDigest
    )) || null;
  }
}

export function packageSourceKey(record) {
  const digest = String(record?.digest || '');
  const match = digest.match(/^sha256:([a-fA-F0-9]{64})$/);
  if (!match) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return `${INSTALLED_SOURCE_PREFIX}${match[1].toLowerCase()}`;
}

