import path from 'path';
import fs from 'fs/promises';
import {
  LANG_BY_EXT,
  findStep,
  stepInheritMode,
  validateSafePath,
  validateWorkspaceRelPath,
} from './PackageService.js';

const UI_MAX_BYTES = 8192;

export class SaveService {
  constructor({ runtimeStateDir, workspaceService, packageService }) {
    this.runtimeStateDir = runtimeStateDir;
    this.workspaceService = workspaceService;
    this.packageService = packageService;
  }

  async loadStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
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
      await writeStepUi(this.stepUiPath(cfg, step.id), defaultStepUi(step));
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

      if (!hasOwnSave) {
        await writeHostFiles(ownSaveDir, files);
        await writeStepUi(this.stepUiPath(cfg, step.id), defaultStepUi(step));
        hasOwnSave = true;
        files = await readHostFiles(ownSaveDir);
      }
    }

    await this.workspaceService.useSaveWorkspace({
      tutorialId,
      hostPath: ownSaveDir,
      containerPath: this.containerSavePath(cfg, step.id),
      files,
    });
    const progress = await this.recordStepVisit(cfg, step.id);
    return {
      tutorial: tutorialId,
      step: step.id,
      sourceStep,
      hasOwnSave,
      inheritMode: mode,
      files,
      ui: await readStepUi(this.stepUiPath(cfg, step.id), step),
      progress,
    };
  }

  async saveStepState(tutorialId, stepId, files, { ui } = {}) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const dest = this.saveDir(cfg, step.id);
    const providedFiles = Array.isArray(files) ? files : null;
    const normalizedFiles = (providedFiles || []).map(f => normalizeWorkspaceEntry(f));
    await this.workspaceService.ensure({ tutorialId });
    if (providedFiles) await this.workspaceService.writeFiles(normalizedFiles, { clear: false });
    if (!this.workspaceService.usesHostBackedSave()) {
      const workspaceFiles = await this.workspaceService.snapshot();
      await writeHostFiles(dest, workspaceFiles);
    }
    const nextUi = ui !== undefined
      ? normalizeStepUi(ui, step)
      : await readStepUi(this.stepUiPath(cfg, step.id), step);
    await writeStepUi(this.stepUiPath(cfg, step.id), nextUi);
    const progress = await this.recordStepVisit(cfg, step.id);
    return { tutorial: tutorialId, step: step.id, hasOwnSave: true, ui: nextUi, progress };
  }

  async resetStepState(tutorialId, stepId) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const dest = this.saveDir(cfg, step.id);
    await writeStepTemplateToDir(step, dest);
    await writeStepUi(this.stepUiPath(cfg, step.id), defaultStepUi(step));
    const files = await readHostFiles(dest);
    await this.workspaceService.useSaveWorkspace({
      tutorialId,
      hostPath: dest,
      containerPath: this.containerSavePath(cfg, step.id),
      files,
    });
    const progress = await this.recordStepVisit(cfg, step.id);
    return {
      tutorial: tutorialId,
      step: step.id,
      hasOwnSave: true,
      files,
      ui: await readStepUi(this.stepUiPath(cfg, step.id), step),
      progress,
    };
  }

  async ensureSaveRootDirs() {
    await fs.mkdir(path.join(this.runtimeStateDir, 'saves'), { recursive: true });
  }

  saveDir(cfg, stepId) {
    return path.join(this.stepDir(cfg, stepId), 'files');
  }

  containerSavePath(cfg, stepId) {
    const rel = [
      validateSafePath(cfg.id),
      validateStorageSegment(cfg.version || '0.0.0', 'package version'),
      digestPathSegment(cfg.package_digest),
      'steps',
      validateSafePath(stepId),
      'files',
    ].join('/');
    return `/home/student/.mlab-saves/${rel}`;
  }

  stepDir(cfg, stepId) {
    return path.join(this.packageSaveRoot(cfg), 'steps', validateSafePath(stepId));
  }

  stepUiPath(cfg, stepId) {
    return path.join(this.stepDir(cfg, stepId), 'ui.json');
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

  // 读取进度 metadata,不写回 (不记录 visit, 不覆盖 current_step)。
  // 用于 tutorial detail 让前端 resume, 避免探测 step 0 时把 current_step 覆盖成 0。
  async getProgress(cfg) {
    return this.readSaveMetadata(cfg);
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
        if (file.type === 'dir') {
          files.set(`steps/${stepId}/files/${file.name}/`, Buffer.alloc(0));
        } else {
          files.set(`steps/${stepId}/files/${file.name}`, Buffer.from(file.content || '', 'utf8'));
        }
      }
      const uiPath = path.join(stepsRoot, stepId, 'ui.json');
      try {
        files.set(`steps/${stepId}/ui.json`, await fs.readFile(uiPath));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
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
    const stepUi = new Map();
    for (const [relPath, content] of files || []) {
      if (relPath === 'save.json') continue;
      const parsed = parseSaveArchivePath(relPath);
      if (!parsed) {
        throw Object.assign(new Error(`unsupported save archive path: ${relPath}`), { statusCode: 400 });
      }
      if (parsed.kind === 'ui') {
        stepUi.set(parsed.stepId, Buffer.isBuffer(content) ? content.toString('utf8') : String(content || ''));
        continue;
      }
      if (!stepFiles.has(parsed.stepId)) stepFiles.set(parsed.stepId, []);
      stepFiles.get(parsed.stepId).push({
        name: parsed.fileName,
        type: parsed.kind === 'dir' ? 'dir' : 'file',
        content: parsed.kind === 'dir'
          ? ''
          : (Buffer.isBuffer(content) ? content.toString('utf8') : String(content || '')),
      });
    }

    const stepIds = new Set([...stepFiles.keys(), ...stepUi.keys()]);
    for (const stepId of stepIds) {
      const dest = this.saveDir(cfg, stepId);
      await writeHostFiles(dest, stepFiles.get(stepId) || []);
      if (!stepUi.has(stepId)) continue;
      let parsedUi;
      try {
        parsedUi = JSON.parse(stepUi.get(stepId));
      } catch {
        throw Object.assign(new Error(`invalid ui.json for step ${stepId}`), { statusCode: 400 });
      }
      const step = (cfg.steps || []).find(item => item.id === stepId) || { id: stepId };
      await writeStepUi(this.stepUiPath(cfg, stepId), normalizeStepUi(parsedUi, step));
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
      steps: Array.from(stepIds).sort(),
    };
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
    const rel = validateWorkspaceRelPath(f.name || 'untitled');
    const dest = path.join(destDir, ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content || '', 'utf8');
  }
}

async function readHostFiles(dir) {
  const files = [];
  await collectSaveEntries(dir, '', files);
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function collectSaveEntries(dir, relative, out) {
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
      out.push({ name: childRel, type: 'dir' });
      await collectSaveEntries(path.join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      const ext = path.extname(childRel).toLowerCase();
      out.push({
        name: childRel,
        type: 'file',
        content: await fs.readFile(path.join(dir, entry.name), 'utf8'),
        language: LANG_BY_EXT[ext] || 'plaintext',
      });
    }
  }
}

async function writeHostFiles(dir, files) {
  await clearHostDir(dir);
  for (const f of files || []) {
    const entry = normalizeWorkspaceEntry(f);
    const dest = path.join(dir, ...entry.name.split('/'));
    if (entry.type === 'dir') {
      await fs.mkdir(dest, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, entry.content || '', 'utf8');
  }
}

function normalizeWorkspaceEntry(file) {
  const name = validateWorkspaceRelPath(file.name || 'untitled');
  if (file.type === 'dir') return { name, type: 'dir' };
  return { name, type: 'file', content: file.content || '' };
}

function defaultStepUi(step) {
  let entry = null;
  if (typeof step?.entry_file === 'string' && step.entry_file) {
    try {
      entry = validateWorkspaceRelPath(step.entry_file);
    } catch {
      entry = null;
    }
  }
  return {
    open_files: entry ? [entry] : [],
    active_file: entry,
  };
}

function normalizeStepUi(ui, step) {
  const defaults = defaultStepUi(step);
  const raw = ui && typeof ui === 'object' && !Array.isArray(ui) ? ui : {};
  let openFiles;
  if (Array.isArray(raw.open_files)) {
    const seen = new Set();
    openFiles = [];
    for (const item of raw.open_files.slice(0, 40)) {
      if (typeof item !== 'string') continue;
      try {
        const name = validateWorkspaceRelPath(item);
        if (seen.has(name)) continue;
        seen.add(name);
        openFiles.push(name);
      } catch {
        // skip invalid tab paths
      }
    }
  } else {
    openFiles = defaults.open_files;
  }

  let active = defaults.active_file;
  if (typeof raw.active_file === 'string' && raw.active_file) {
    try {
      active = validateWorkspaceRelPath(raw.active_file);
    } catch {
      active = defaults.active_file;
    }
  }
  if (active && !openFiles.includes(active)) active = openFiles[0] || null;

  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'open_files' || key === 'active_file') continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    extra[key] = value;
  }

  const next = { ...extra, open_files: openFiles, active_file: active };
  try {
    const encoded = JSON.stringify(next);
    if (encoded.length > UI_MAX_BYTES) return { open_files: openFiles, active_file: active };
    JSON.parse(encoded);
    return next;
  } catch {
    return { open_files: openFiles, active_file: active };
  }
}

async function readStepUi(uiPath, step) {
  try {
    return normalizeStepUi(JSON.parse(await fs.readFile(uiPath, 'utf8')), step);
  } catch (e) {
    if (e.code === 'ENOENT') return defaultStepUi(step);
    throw e;
  }
}

async function writeStepUi(uiPath, ui) {
  await fs.mkdir(path.dirname(uiPath), { recursive: true });
  await fs.writeFile(uiPath, JSON.stringify(ui, null, 2) + '\n', 'utf8');
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

function parseSaveArchivePath(relPath) {
  const uiMatch = String(relPath || '').match(/^steps\/([^/]+)\/ui\.json$/);
  if (uiMatch) {
    return { kind: 'ui', stepId: validateSafePath(uiMatch[1]) };
  }
  const raw = String(relPath || '');
  const isDir = raw.endsWith('/');
  const trimmed = raw.replace(/\/+$/, '');
  const match = trimmed.match(/^steps\/([^/]+)\/files\/(.+)$/);
  if (!match) return null;
  return {
    kind: isDir ? 'dir' : 'file',
    stepId: validateSafePath(match[1]),
    fileName: validateWorkspaceRelPath(match[2]),
  };
}

