import path from 'path';
import fs from 'fs/promises';
import {
  LANG_BY_EXT,
  findStep,
  stepInheritMode,
  validateFileName,
  validateSafePath,
} from './PackageService.js';

export class SaveService {
  constructor({ runtimeStateDir, runtimeSession = null, runtimeManager = null, packageService }) {
    this.runtimeStateDir = runtimeStateDir;
    this.runtimeSession = runtimeSession;
    this.runtimeManager = runtimeManager;
    this.packageService = packageService;
  }

  async loadStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs(tutorialId);
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const ownSaveDir = this.saveDir(cfg, step.id);
    const mode = stepInheritMode(step);
    let sourceStep = step.id;
    let hasOwnSave = await dirExists(ownSaveDir);
    let files;

    if (hasOwnSave) {
      files = await readHostFiles(ownSaveDir);
    } else if (mode === 'template') {
      await writeStepTemplateToDir(step, ownSaveDir);
      files = await readHostFiles(ownSaveDir);
      hasOwnSave = true;
    } else {
      const chain = stepChain(step);
      const steps = cfg.steps || [];
      const idx = steps.findIndex(s => s.id === step.id);
      let sourceDir = null;
      for (let i = idx - 1; i >= 0; i--) {
        if (stepChain(steps[i]) !== chain) continue;
        const prevSaveDir = this.saveDir(cfg, steps[i].id);
        if (await dirExists(prevSaveDir)) {
          sourceDir = prevSaveDir;
          sourceStep = steps[i].id;
          break;
        }
      }
      if (!sourceDir) {
        const first = findChainFirstStep(cfg, chain) || step;
        sourceDir = this.saveDir(cfg, first.id);
        sourceStep = first.id;
        if (!(await dirExists(sourceDir))) {
          await writeStepTemplateToDir(first, sourceDir);
        }
        hasOwnSave = first.id === step.id;
      }

      files = await readHostFiles(sourceDir);

      if (mode === 'overlay_template') {
        const byName = new Map(files.map(f => [f.name, f]));
        for (const templateFile of step.files || []) {
          if (!byName.has(templateFile.name)) byName.set(templateFile.name, templateFile);
        }
        files = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
      }
    }

    await this.writeFilesToWorkspace(files);
    const progress = await this.recordStepVisit(cfg, step.id);
    return {
      tutorial: tutorialId,
      step: step.id,
      sourceStep,
      hasOwnSave,
      inheritMode: mode,
      files,
      progress,
    };
  }

  async saveStepState(tutorialId, stepId, files) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs(tutorialId);
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const dest = this.saveDir(cfg, step.id);
    const providedFiles = Array.isArray(files) ? files : null;
    const normalizedFiles = (providedFiles || []).map(f => ({
      name: validateFileName(f.name || 'untitled'),
      content: f.content || '',
    }));
    if (providedFiles) await this.writeFilesToWorkspace(normalizedFiles, { clear: false });
    const workspaceFiles = await this.loadWorkspaceFiles();
    await writeHostFiles(dest, workspaceFiles);
    const progress = await this.recordStepVisit(cfg, step.id);
    return { tutorial: tutorialId, step: step.id, hasOwnSave: true, progress };
  }

  async resetStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs(tutorialId);
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const dest = this.saveDir(cfg, step.id);
    await writeStepTemplateToDir(step, dest);
    const files = await readHostFiles(dest);
    await this.writeFilesToWorkspace(files);
    const progress = await this.recordStepVisit(cfg, step.id);
    return {
      tutorial: tutorialId,
      step: step.id,
      hasOwnSave: true,
      files,
      progress,
    };
  }

  async ensureRuntimeDirs(tutorialId = null) {
    await this.ensureSaveRootDirs();
    const session = await this.resolveRuntimeSession(tutorialId);
    await session.ensureWorkspace();
  }

  async ensureSaveRootDirs() {
    await fs.mkdir(path.join(this.runtimeStateDir, 'saves'), { recursive: true });
  }

  async resolveRuntimeSession(tutorialId = null) {
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

  saveDir(cfg, stepId) {
    return path.join(this.packageSaveRoot(cfg), 'steps', validateSafePath(stepId), 'files');
  }

  packageSaveRoot(cfg) {
    const packageId = validateSafePath(cfg.id);
    const version = validateStorageSegment(cfg.version || '0.0.0', 'package version');
    const digest = digestPathSegment(cfg.package_digest);
    return path.join(this.runtimeStateDir, 'saves', packageId, version, digest);
  }

  async recordStepVisit(cfg, stepId) {
    const metadata = await this.readSaveMetadata(cfg);
    const visited = new Set(Array.isArray(metadata.visited) ? metadata.visited : []);
    visited.add(validateSafePath(stepId));
    return this.writeSaveMetadata(cfg, {
      ...metadata,
      current_step: stepId,
      visited: Array.from(visited),
    });
  }

  async recordTestResult(tutorialId, stepId, passed) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const metadata = await this.recordStepVisit(cfg, step.id);
    return this.writeSaveMetadata(cfg, {
      ...metadata,
      test_passed: {
        ...(metadata.test_passed || {}),
        [step.id]: Boolean(passed),
      },
    });
  }

  async readSaveMetadata(cfg) {
    const metadataPath = this.saveMetadataPath(cfg);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      return {
        ...defaultSaveMetadata(cfg),
        ...metadata,
        package: defaultSaveMetadata(cfg).package,
        visited: Array.isArray(metadata.visited) ? metadata.visited : [],
        test_passed: metadata.test_passed && typeof metadata.test_passed === 'object'
          ? metadata.test_passed
          : {},
      };
    } catch (e) {
      if (e.code === 'ENOENT') return defaultSaveMetadata(cfg);
      throw e;
    }
  }

  async writeSaveMetadata(cfg, metadata) {
    const root = this.packageSaveRoot(cfg);
    await fs.mkdir(root, { recursive: true });
    const next = {
      ...defaultSaveMetadata(cfg),
      ...metadata,
      package: defaultSaveMetadata(cfg).package,
      visited: Array.isArray(metadata.visited) ? metadata.visited : [],
      test_passed: metadata.test_passed && typeof metadata.test_passed === 'object'
        ? metadata.test_passed
        : {},
      updated_at: new Date().toISOString(),
    };
    await fs.writeFile(this.saveMetadataPath(cfg), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return next;
  }

  saveMetadataPath(cfg) {
    return path.join(this.packageSaveRoot(cfg), 'save.json');
  }

  async collectSaveBundle(tutorialKey) {
    validateSafePath(tutorialKey);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialKey);
    const metadata = await this.readSaveMetadata(cfg);
    const root = this.packageSaveRoot(cfg);
    const files = new Map();
    files.set('save.json', Buffer.from(JSON.stringify(metadata, null, 2) + '\n', 'utf8'));

    const stepsRoot = path.join(root, 'steps');
    for (const stepId of await listStepIds(stepsRoot)) {
      validateSafePath(stepId);
      const filesDir = path.join(stepsRoot, stepId, 'files');
      if (!(await dirExists(filesDir))) continue;
      const stepFiles = await readHostFiles(filesDir);
      for (const file of stepFiles) {
        files.set(`steps/${stepId}/files/${file.name}`, Buffer.from(file.content || '', 'utf8'));
      }
    }

    return {
      tutorial: tutorialKey,
      source_key: cfg.source_key || tutorialKey,
      package: metadata.package,
      metadata,
      files,
    };
  }

  async applySaveBundle({ metadata, files }) {
    const packageInfo = metadata?.package;
    if (!packageInfo?.id || !packageInfo?.digest) {
      throw Object.assign(new Error('save.json missing package identity'), { statusCode: 400 });
    }

    const match = await this.packageService.findSourceByPackageIdentity({
      id: packageInfo.id,
      version: packageInfo.version || '0.0.0',
      digest: packageInfo.digest,
    });
    if (!match) {
      throw Object.assign(
        new Error(
          `matching package not found: ${packageInfo.id}@${packageInfo.version || '0.0.0'}@${packageInfo.digest}; import the original .mlab first`
        ),
        {
          statusCode: 404,
          code: 'package_missing',
          package: {
            id: packageInfo.id,
            version: packageInfo.version || '0.0.0',
            digest: packageInfo.digest,
          },
        }
      );
    }

    const cfg = await this.packageService.loadTutorial(match.source_key || match.id);
    const root = this.packageSaveRoot(cfg);
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });

    const stepFiles = new Map();
    for (const [relPath, content] of files || []) {
      if (relPath === 'save.json') continue;
      const parsed = parseSaveStepFilePath(relPath);
      if (!parsed) {
        throw Object.assign(new Error(`unsupported save archive path: ${relPath}`), { statusCode: 400 });
      }
      if (!stepFiles.has(parsed.stepId)) stepFiles.set(parsed.stepId, []);
      stepFiles.get(parsed.stepId).push({
        name: parsed.fileName,
        content: Buffer.isBuffer(content) ? content.toString('utf8') : String(content || ''),
      });
    }

    for (const [stepId, stepFileList] of stepFiles) {
      const dest = this.saveDir(cfg, stepId);
      await writeHostFiles(dest, stepFileList);
    }

    const progress = await this.writeSaveMetadata(cfg, {
      ...defaultSaveMetadata(cfg),
      current_step: metadata.current_step || null,
      visited: Array.isArray(metadata.visited) ? metadata.visited : [],
      test_passed: metadata.test_passed && typeof metadata.test_passed === 'object'
        ? metadata.test_passed
        : {},
    });

    return {
      source_key: cfg.source_key || match.source_key || match.id,
      package: progress.package,
      progress,
      steps: Array.from(stepFiles.keys()).sort(),
    };
  }

  async loadWorkspaceFiles() {
    const session = await this.resolveRuntimeSession();
    const files = await session.readFiles();
    return files.map(file => {
      const name = validateFileName(file.name);
      const ext = path.extname(name).toLowerCase();
      return {
        name,
        content: file.content,
        language: LANG_BY_EXT[ext] || 'plaintext',
      };
    });
  }

  async writeFilesToWorkspace(files, opts = {}) {
    const session = await this.resolveRuntimeSession();
    const normalizedFiles = (files || []).map(f => {
      const name = validateFileName(f.name || 'untitled');
      return { name, content: f.content || '' };
    });
    await session.writeFiles(normalizedFiles, opts);
  }
}

function digestPathSegment(digest) {
  const segment = String(digest || '').replace(/^sha256:/, 'sha256-');
  if (!/^[a-zA-Z0-9_.-]+$/.test(segment)) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return segment;
}

function validateStorageSegment(value, fieldName) {
  const segment = String(value || '');
  if (!segment || segment.includes('..') || !/^[a-zA-Z0-9_.+-]+$/.test(segment)) {
    throw Object.assign(new Error(`Invalid ${fieldName}`), { statusCode: 400 });
  }
  return segment;
}

function stepChain(step) {
  return step.chain || step.id;
}

function findChainFirstStep(cfg, chain) {
  return (cfg.steps || []).find(s => stepChain(s) === chain);
}

async function dirExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function clearHostDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function writeStepTemplateToDir(step, destDir) {
  await clearHostDir(destDir);
  for (const f of step.files || []) {
    const name = validateFileName(f.name || 'untitled');
    await fs.writeFile(path.join(destDir, name), f.content || '', 'utf8');
  }
}

async function readHostFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries.filter(e => e.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    validateFileName(name);
    const ext = path.extname(name).toLowerCase();
    files.push({
      name,
      content: await fs.readFile(path.join(dir, name), 'utf8'),
      language: LANG_BY_EXT[ext] || 'plaintext',
    });
  }
  return files;
}

async function writeHostFiles(dir, files) {
  await clearHostDir(dir);
  for (const f of files || []) {
    const name = validateFileName(f.name || 'untitled');
    await fs.writeFile(path.join(dir, name), f.content || '', 'utf8');
  }
}

function defaultSaveMetadata(cfg) {
  return {
    package: {
      id: cfg.id,
      version: cfg.version || '0.0.0',
      digest: cfg.package_digest,
    },
    current_step: null,
    visited: [],
    test_passed: {},
    updated_at: null,
  };
}

async function listStepIds(stepsRoot) {
  try {
    const entries = await fs.readdir(stepsRoot, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function parseSaveStepFilePath(relPath) {
  const match = String(relPath || '').match(/^steps\/([^/]+)\/files\/([^/]+)$/);
  if (!match) return null;
  return {
    stepId: validateSafePath(match[1]),
    fileName: validateFileName(match[2]),
  };
}

