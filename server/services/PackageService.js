import crypto from 'crypto';
import path from 'path';
import fs from 'fs/promises';

export const LANG_BY_EXT = {
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.py': 'python', '.js': 'javascript', '.ts': 'typescript',
  '.sh': 'bash', '.rs': 'rust', '.go': 'go', '.java': 'java',
};

const MANIFEST_FILE = 'multilab.json';
const VALID_INHERIT_MODES = new Set(['template', 'previous_save', 'overlay_template']);
const INSTALLED_SOURCE_PREFIX = 'pkg-';

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

export function stepInheritMode(step) {
  const explicit = step.inherit_mode;
  if (explicit && VALID_INHERIT_MODES.has(explicit)) return explicit;
  return step.chain ? 'previous_save' : 'template';
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
  if (resolved !== tutorialDir && !resolved.startsWith(tutorialDir + path.sep)) {
    throw Object.assign(new Error('Package path escapes tutorial directory'), { statusCode: 403 });
  }
  return resolved;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

    for (const step of cfg.steps || []) {
      validateSafePath(step.id);
      const stepDir = path.join(tutorialDir, 'steps', step.id);
      step.inherit_mode = stepInheritMode(step);

      try {
        step.instructions = await fs.readFile(path.join(stepDir, 'instructions.md'), 'utf8');
      } catch {
        step.instructions = '';
      }

      step.files = [];
      const filesDir = path.join(stepDir, 'files');
      try {
        const entries = await fs.readdir(filesDir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isFile()) continue;
          validateFileName(e.name);
          const content = await fs.readFile(path.join(filesDir, e.name), 'utf8');
          const ext = path.extname(e.name).toLowerCase();
          step.files.push({
            name: e.name,
            content,
            language: LANG_BY_EXT[ext] || cfg.language || 'plaintext',
          });
        }
      } catch {
        // files/ is optional for now; empty steps are represented as [].
      }

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

