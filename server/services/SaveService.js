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
  constructor({ runtimeStateDir, runtimeSession, packageService }) {
    this.runtimeStateDir = runtimeStateDir;
    this.runtimeSession = runtimeSession;
    this.packageService = packageService;
  }

  async loadStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs();
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
    return {
      tutorial: tutorialId,
      step: step.id,
      sourceStep,
      hasOwnSave,
      inheritMode: mode,
      files,
    };
  }

  async saveStepState(tutorialId, stepId, files) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs();
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
    return { tutorial: tutorialId, step: step.id, hasOwnSave: true };
  }

  async resetStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureRuntimeDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const dest = this.saveDir(cfg, step.id);
    await writeStepTemplateToDir(step, dest);
    const files = await readHostFiles(dest);
    await this.writeFilesToWorkspace(files);
    return {
      tutorial: tutorialId,
      step: step.id,
      hasOwnSave: true,
      files,
    };
  }

  async ensureRuntimeDirs() {
    await fs.mkdir(path.join(this.runtimeStateDir, 'saves'), { recursive: true });
    await this.runtimeSession.ensureWorkspace();
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

  async loadWorkspaceFiles() {
    const files = await this.runtimeSession.readFiles();
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
    const normalizedFiles = (files || []).map(f => {
      const name = validateFileName(f.name || 'untitled');
      return { name, content: f.content || '' };
    });
    await this.runtimeSession.writeFiles(normalizedFiles, opts);
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

