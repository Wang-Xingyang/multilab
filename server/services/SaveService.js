import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import {
  LANG_BY_EXT,
  findStep,
  stepInheritMode,
  stepNeedsEdit,
  stepHasTest,
  stepChain,
  validateSafePath,
  validateWorkspaceRelPath,
} from './PackageService.js';
import { SAVES_BIND_TARGET } from '../workspace/WorkspaceStrategy.js';

const UI_MAX_BYTES = 8192;

export class SaveService {
  #exclusive = Promise.resolve();

  constructor({ runtimeStateDir, workspaceService, packageService }) {
    this.runtimeStateDir = runtimeStateDir;
    this.workspaceService = workspaceService;
    this.packageService = packageService;
    this.activeStep = null;
    this.activeCommand = null;
    this.nextGeneration = 1;
  }

  runExclusive(fn) {
    const run = this.#exclusive.then(fn, fn);
    this.#exclusive = run.then(() => undefined, () => undefined);
    return run;
  }

  async loadStepState(tutorialId, stepId) {
    this.assertNoCommandInProgress();
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    await this.workspaceService.flushLiveToHost();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    const mode = stepInheritMode(step);
    let metadata = await this.readSaveMetadata(cfg);

    const needsEdit = stepNeedsEdit(step);
    const previousComplete = await this.arePreviousStepsComplete(cfg, step, metadata);
    const wasEditable = Boolean(metadata.editable?.[step.id]);
    let editable = needsEdit ? await this.isStepEditable(cfg, step, metadata) : false;
    if (needsEdit && editable && !wasEditable) {
      metadata = await this.writeSaveMetadata(cfg, {
        ...metadata,
        editable: { ...metadata.editable, [step.id]: true },
      });
    }
    if (!needsEdit && await this.arePreviousStepsComplete(cfg, step, metadata)) {
      metadata = await this.writeSaveMetadata(cfg, {
        ...metadata,
        completed: { ...metadata.completed, [step.id]: true },
      });
    }
    if (needsEdit && editable && !stepHasTest(step) && !metadata.entered_editable[step.id]) {
      metadata = await this.writeSaveMetadata(cfg, {
        ...metadata,
        entered_editable: { ...metadata.entered_editable, [step.id]: true },
      });
    }

    const commandsAllowed = needsEdit ? Boolean(editable && previousComplete) : true;

    let files;
    let sourceStep = step.id;
    let workspaceHostPath;
    let workspaceContainerPath;
    let hasOwnSave = false;

    if (needsEdit && editable) {
      const ownSaveDir = this.saveDir(cfg, step.id);
      const dirThere = await dirExists(ownSaveDir);
      const justUnlocked = !wasEditable && previousComplete;
      if (previousComplete && (!dirThere || justUnlocked)) {
        const built = await this.constructArchiveFiles(cfg, step);
        files = built.files;
        sourceStep = built.sourceStep;
        await writeHostFiles(ownSaveDir, files);
        if (!(await fileExists(this.stepUiPath(cfg, step.id)))) {
          await writeStepUi(this.stepUiPath(cfg, step.id), defaultStepUi(step));
        }
        metadata = await this.markArchiveBuilt(cfg, metadata, step.id);
        hasOwnSave = true;
      } else if (dirThere) {
        files = await readHostFiles(ownSaveDir);
        hasOwnSave = true;
        if (!metadata.archive_built?.[step.id]) {
          metadata = await this.markArchiveBuilt(cfg, metadata, step.id);
        }
      }
    }

    if (hasOwnSave) {
      workspaceHostPath = this.saveDir(cfg, step.id);
      workspaceContainerPath = this.containerSavePath(cfg, step.id);
    } else {
      files = cloneWorkspaceFiles(step.files);
      const previewDir = this.previewDir(cfg, step.id);
      await writeHostFiles(previewDir, files);
      workspaceHostPath = previewDir;
      workspaceContainerPath = this.containerPreviewPath(cfg, step.id);
    }

    await this.workspaceService.useSaveWorkspace({
      tutorialId,
      hostPath: workspaceHostPath,
      containerPath: workspaceContainerPath,
      files,
    });
    const generation = this.activateStep({
      tutorialKey: tutorialId,
      packageId: cfg.id,
      stepId: step.id,
      editable,
      commandsAllowed,
    });
    const progress = await this.recordStepVisit(cfg, step.id);
    return this.stepStatePayload(cfg, step, {
      files,
      sourceStep,
      inheritMode: mode,
      editable,
      commandsAllowed,
      hasOwnSave,
      generation,
      progress,
    });
  }

  async saveStepState(tutorialId, stepId, files, { ui, generation } = {}) {
    this.assertNoCommandInProgress();
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    this.assertStepWritable(tutorialId, step.id, { generation });
    const dest = this.saveDir(cfg, step.id);
    const providedFiles = Array.isArray(files) ? files : null;
    const normalizedFiles = (providedFiles || []).map(f => normalizeWorkspaceEntry(f));
    await this.workspaceService.ensure({ tutorialId });
    const liveHost = this.workspaceService.attachedHostPath;
    const savingLive = !liveHost || path.resolve(liveHost) === path.resolve(dest);
    if (savingLive) {
      if (providedFiles) await this.workspaceService.writeFiles(normalizedFiles, { clear: false });
      await this.workspaceService.flushLiveToHost({ hostPath: dest, tutorialId });
    } else if (providedFiles) {
      await mergeHostFiles(dest, normalizedFiles);
    }
    const nextUi = ui !== undefined
      ? normalizeStepUi(ui, step)
      : await readStepUi(this.stepUiPath(cfg, step.id), step);
    await writeStepUi(this.stepUiPath(cfg, step.id), nextUi);
    await this.markArchiveBuilt(cfg, await this.readSaveMetadata(cfg), step.id);
    const progress = await this.recordStepVisit(cfg, step.id);
    return this.stepStatePayload(cfg, step, {
      files: await readHostFiles(dest),
      hasOwnSave: true,
      editable: true,
      commandsAllowed: this.activeStep?.commandsAllowed,
      progress,
      ui: nextUi,
    });
  }

  async resetStepState(tutorialId, stepId, { generation } = {}) {
    this.assertNoCommandInProgress();
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    this.assertStepWritable(tutorialId, step.id, { generation });
    const dest = this.saveDir(cfg, step.id);
    const built = await this.constructArchiveFiles(cfg, step);
    await writeHostFiles(dest, built.files);
    await writeStepUi(this.stepUiPath(cfg, step.id), defaultStepUi(step));
    const metadata = await this.readSaveMetadata(cfg);
    const testPassed = { ...(metadata.test_passed || {}) };
    const testHash = { ...(metadata.test_hash || {}) };
    delete testPassed[step.id];
    delete testHash[step.id];
    await this.writeSaveMetadata(cfg, {
      ...metadata,
      test_passed: testPassed,
      test_hash: testHash,
      archive_built: { ...metadata.archive_built, [step.id]: true },
    });
    await this.workspaceService.useSaveWorkspace({
      tutorialId,
      hostPath: dest,
      containerPath: this.containerSavePath(cfg, step.id),
      files: built.files,
    });
    const progress = await this.recordStepVisit(cfg, step.id);
    return this.stepStatePayload(cfg, step, {
      files: built.files,
      sourceStep: built.sourceStep,
      inheritMode: stepInheritMode(step),
      hasOwnSave: true,
      editable: true,
      commandsAllowed: this.activeStep?.commandsAllowed,
      progress,
    });
  }

  async applySolution(tutorialId, stepId, { generation } = {}) {
    this.assertNoCommandInProgress();
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    await this.ensureSaveRootDirs();
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    this.assertStepWritable(tutorialId, step.id, { generation });
    if (!step.has_solution) {
      throw Object.assign(new Error('this step has no solution'), { statusCode: 404, code: 'no_solution' });
    }
    const dest = this.saveDir(cfg, step.id);
    const files = cloneWorkspaceFiles(step.solution_files);
    await writeHostFiles(dest, files);
    const metadata = await this.readSaveMetadata(cfg);
    const testPassed = { ...(metadata.test_passed || {}) };
    const testHash = { ...(metadata.test_hash || {}) };
    delete testPassed[step.id];
    delete testHash[step.id];
    await this.writeSaveMetadata(cfg, {
      ...metadata,
      test_passed: testPassed,
      test_hash: testHash,
      archive_built: { ...metadata.archive_built, [step.id]: true },
    });
    await this.workspaceService.useSaveWorkspace({
      tutorialId,
      hostPath: dest,
      containerPath: this.containerSavePath(cfg, step.id),
      files,
    });
    const progress = await this.recordStepVisit(cfg, step.id);
    return this.stepStatePayload(cfg, step, {
      files,
      hasOwnSave: true,
      editable: true,
      commandsAllowed: this.activeStep?.commandsAllowed,
      progress,
    });
  }

  async constructArchiveFiles(cfg, step) {
    const mode = stepInheritMode(step);
    const template = cloneWorkspaceFiles(step.files);
    if (mode === 'template' || !stepChain(step)) {
      return { files: template, sourceStep: step.id };
    }
    const previous = await this.findPreviousChainArchive(cfg, step);
    if (!previous) {
      return { files: template, sourceStep: step.id };
    }
    let files = previous.files;
    if (mode === 'overlay_template') {
      const byName = new Map(files.map(f => [f.name, f]));
      for (const templateFile of template) {
        if (!byName.has(templateFile.name)) byName.set(templateFile.name, templateFile);
      }
      files = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
    }
    return { files, sourceStep: previous.stepId };
  }

  async findPreviousChainArchive(cfg, step) {
    const chain = stepChain(step);
    if (!chain) return null;
    const steps = cfg.steps || [];
    const idx = steps.findIndex(item => item.id === step.id);
    for (let i = idx - 1; i >= 0; i--) {
      if (stepChain(steps[i]) !== chain) continue;
      const dir = this.saveDir(cfg, steps[i].id);
      if (await dirExists(dir)) {
        return { stepId: steps[i].id, files: await readHostFiles(dir) };
      }
    }
    return null;
  }

  async isStepEditable(cfg, step, metadata) {
    if (!stepNeedsEdit(step)) return false;
    if (metadata.editable?.[step.id]) return true;
    const steps = cfg.steps || [];
    const idx = steps.findIndex(item => item.id === step.id);
    if (idx <= 0) return idx === 0;
    return this.arePreviousStepsComplete(cfg, step, metadata);
  }

  async arePreviousStepsComplete(cfg, step, metadata) {
    const steps = cfg.steps || [];
    const idx = steps.findIndex(item => item.id === step.id);
    if (idx <= 0) return true;
    for (let i = 0; i < idx; i++) {
      if (!(await this.isStepComplete(cfg, steps[i], metadata))) return false;
    }
    return true;
  }

  async isStepComplete(cfg, step, metadata) {
    if (!stepNeedsEdit(step)) return Boolean(metadata.completed?.[step.id]);
    if (stepHasTest(step)) {
      if (metadata.test_passed?.[step.id] !== true) return false;
      const dir = this.saveDir(cfg, step.id);
      if (!(await dirExists(dir))) return false;
      const files = await readHostFiles(dir);
      return hashWorkspaceFiles(files) === metadata.test_hash?.[step.id];
    }
    return Boolean(metadata.entered_editable?.[step.id]);
  }

  async decorateProgress(cfg, metadata) {
    const completed = { ...(metadata.completed || {}) };
    const editable = { ...(metadata.editable || {}) };
    for (const step of cfg.steps || []) {
      if (await this.isStepComplete(cfg, step, metadata)) completed[step.id] = true;
      else delete completed[step.id];
      if (stepNeedsEdit(step) && await this.isStepEditable(cfg, step, metadata)) {
        editable[step.id] = true;
      }
    }
    return {
      ...metadata,
      completed,
      editable,
    };
  }

  async stepStatePayload(cfg, step, {
    files,
    sourceStep = step.id,
    inheritMode = stepInheritMode(step),
    editable,
    commandsAllowed,
    hasOwnSave,
    generation = this.activeStep?.generation || null,
    progress,
    ui,
  } = {}) {
    const metadata = progress || await this.readSaveMetadata(cfg);
    const decorated = await this.decorateProgress(cfg, metadata);
    const resolvedEditable = editable !== undefined
      ? Boolean(editable)
      : Boolean(decorated.editable[step.id]);
    const previousComplete = await this.arePreviousStepsComplete(cfg, step, decorated);
    const resolvedCommandsAllowed = commandsAllowed !== undefined
      ? Boolean(commandsAllowed)
      : (stepNeedsEdit(step) ? Boolean(resolvedEditable && previousComplete) : true);
    return {
      tutorial: cfg.source_key || cfg.id,
      step: step.id,
      sourceStep,
      inheritMode,
      needs_edit: stepNeedsEdit(step),
      has_solution: Boolean(step.has_solution),
      editable: resolvedEditable,
      commands_allowed: resolvedCommandsAllowed,
      complete: Boolean(decorated.completed[step.id]),
      hasOwnSave: Boolean(hasOwnSave),
      generation,
      files,
      ui: ui || await readStepUi(this.stepUiPath(cfg, step.id), step),
      progress: decorated,
    };
  }

  activateStep({ tutorialKey, packageId, stepId, editable, commandsAllowed }) {
    const generation = this.nextGeneration++;
    this.activeStep = {
      tutorialKey,
      packageId,
      stepId,
      editable: Boolean(editable),
      commandsAllowed: commandsAllowed !== undefined ? Boolean(commandsAllowed) : Boolean(editable),
      generation,
    };
    return generation;
  }

  assertNoCommandInProgress() {
    if (this.activeCommand) {
      throw Object.assign(new Error('a command is already running'), {
        statusCode: 409,
        code: 'command_busy',
      });
    }
  }

  assertActiveStep(tutorial, step, generation) {
    if (!this.activeStep || this.activeStep.tutorialKey !== tutorial || this.activeStep.stepId !== step) {
      throw Object.assign(new Error('this step is not the active workspace'), {
        statusCode: 409,
        code: 'step_inactive',
      });
    }
    if (generation !== undefined && generation !== null && generation !== this.activeStep.generation) {
      throw Object.assign(new Error('step workspace is stale; reload the step'), {
        statusCode: 409,
        code: 'step_stale',
      });
    }
  }

  assertStepWritable(tutorial, step, { generation } = {}) {
    this.assertActiveStep(tutorial, step, generation);
    if (!this.activeStep.editable) {
      throw notEditableError('this step cannot be edited yet');
    }
  }

  assertStepCommand(tutorial, step, { generation, requireEditable = false } = {}) {
    this.assertActiveStep(tutorial, step, generation);
    if (!requireEditable) return;
    if (!this.activeStep.editable || !this.activeStep.commandsAllowed) {
      throw notEditableError('complete earlier steps before running this command');
    }
  }

  assertShellInput(tutorial, step, { generation } = {}) {
    if (this.activeCommand) {
      this.assertActiveStep(tutorial, step, generation);
      return;
    }
    this.assertActiveStep(tutorial, step, generation);
    if (!this.activeStep.editable || !this.activeStep.commandsAllowed) {
      throw notEditableError('this step cannot be edited yet');
    }
  }

  beginCommand({ tutorial, step, generation, token }) {
    this.assertNoCommandInProgress();
    this.assertActiveStep(tutorial, step, generation);
    this.activeCommand = { tutorial, step, generation, token };
  }

  finishCommand(token) {
    if (!this.activeCommand) return;
    if (token && this.activeCommand.token !== token) return;
    this.activeCommand = null;
  }

  async ensureSaveRootDirs() {
    await fs.mkdir(path.join(this.runtimeStateDir, 'saves'), { recursive: true });
  }

  saveDir(cfg, stepId) {
    return path.join(this.stepDir(cfg, stepId), 'files');
  }

  previewDir(cfg, stepId) {
    return path.join(this.packageSaveRoot(cfg), 'preview', validateSafePath(stepId), 'files');
  }

  containerSavePath(cfg, stepId) {
    return this.containerRelPath(cfg, ['steps', validateSafePath(stepId), 'files']);
  }

  containerPreviewPath(cfg, stepId) {
    return this.containerRelPath(cfg, ['preview', validateSafePath(stepId), 'files']);
  }

  containerRelPath(cfg, parts) {
    const rel = [
      validateSafePath(cfg.id),
      validateStorageSegment(cfg.version || '0.0.0', 'package version'),
      digestPathSegment(cfg.package_digest),
      ...parts,
    ].join('/');
    return `${SAVES_BIND_TARGET}/${rel}`;
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

  async markArchiveBuilt(cfg, metadata, stepId) {
    if (metadata.archive_built?.[stepId]) return metadata;
    return this.writeSaveMetadata(cfg, {
      ...metadata,
      archive_built: { ...metadata.archive_built, [stepId]: true },
    });
  }

  async recordStepVisit(cfg, stepId) {
    const metadata = await this.readSaveMetadata(cfg);
    const visited = new Set(Array.isArray(metadata.visited) ? metadata.visited : []);
    visited.add(validateSafePath(stepId));
    const written = await this.writeSaveMetadata(cfg, {
      ...metadata,
      current_step: stepId,
      visited: Array.from(visited),
    });
    return this.decorateProgress(cfg, written);
  }

  async getProgress(cfg) {
    const metadata = await this.readSaveMetadata(cfg);
    return this.decorateProgress(cfg, metadata);
  }

  async recordTestResult(tutorialId, stepId, passed) {
    validateSafePath(tutorialId);
    validateSafePath(stepId);
    const cfg = await this.packageService.loadTutorial(tutorialId);
    const step = findStep(cfg, stepId);
    this.assertStepWritable(tutorialId, step.id);
    const dest = this.saveDir(cfg, step.id);
    const files = await readHostFiles(dest);
    await this.recordStepVisit(cfg, step.id);
    const metadata = await this.readSaveMetadata(cfg);
    const testPassed = { ...(metadata.test_passed || {}) };
    const testHash = { ...(metadata.test_hash || {}) };
    testPassed[step.id] = Boolean(passed);
    testHash[step.id] = hashWorkspaceFiles(files);
    const written = await this.writeSaveMetadata(cfg, {
      ...metadata,
      test_passed: testPassed,
      test_hash: testHash,
    });
    return this.decorateProgress(cfg, written);
  }

  async readSaveMetadata(cfg) {
    const metadataPath = this.saveMetadataPath(cfg);
    try {
      const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      return normalizeSaveMetadata(cfg, metadata);
    } catch (e) {
      if (e.code === 'ENOENT') return defaultSaveMetadata(cfg);
      throw e;
    }
  }

  async writeSaveMetadata(cfg, metadata) {
    const root = this.packageSaveRoot(cfg);
    await fs.mkdir(root, { recursive: true });
    const next = {
      ...normalizeSaveMetadata(cfg, metadata),
      package: defaultSaveMetadata(cfg).package,
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
    await this.workspaceService.flushLiveToHost();
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

    const progress = await this.writeSaveMetadata(cfg, normalizeSaveMetadata(cfg, {
      ...defaultSaveMetadata(cfg),
      current_step: metadata.current_step || null,
      visited: Array.isArray(metadata.visited) ? metadata.visited : [],
      test_passed: metadata.test_passed && typeof metadata.test_passed === 'object'
        ? metadata.test_passed
        : {},
      test_hash: metadata.test_hash && typeof metadata.test_hash === 'object'
        ? metadata.test_hash
        : {},
      completed: metadata.completed && typeof metadata.completed === 'object'
        ? metadata.completed
        : {},
      editable: metadata.editable && typeof metadata.editable === 'object'
        ? metadata.editable
        : {},
      entered_editable: metadata.entered_editable && typeof metadata.entered_editable === 'object'
        ? metadata.entered_editable
        : {},
      archive_built: metadata.archive_built && typeof metadata.archive_built === 'object'
        ? metadata.archive_built
        : {},
    }));

    return {
      source_key: cfg.source_key || match.source_key || match.id,
      package: progress.package,
      progress: await this.decorateProgress(cfg, progress),
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

function notEditableError(message) {
  return Object.assign(new Error(message), { statusCode: 403, code: 'not_editable' });
}

function cloneWorkspaceFiles(files) {
  return (files || []).map(file => (
    file.type === 'dir'
      ? { name: file.name, type: 'dir' }
      : {
        name: file.name,
        type: 'file',
        content: file.content || '',
        language: file.language,
      }
  ));
}

function ignoreHashPath(name) {
  const base = String(name || '').split('/').pop();
  if (!base) return true;
  if (base === 'a.out' || base === '.keep' || base === '.gitkeep' || base === '.DS_Store') return true;
  if (base === '__pycache__' || String(name).includes('__pycache__/')) return true;
  return /\.(o|obj|exe|pyc)$/i.test(base);
}

export function hashWorkspaceFiles(files) {
  const hash = crypto.createHash('sha256');
  const entries = (files || [])
    .filter(file => file?.name && !ignoreHashPath(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const file of entries) {
    if (file.type === 'dir') {
      hash.update('dir\0');
      hash.update(file.name);
      hash.update('\0');
    } else {
      const content = file.content || '';
      hash.update('file\0');
      hash.update(file.name);
      hash.update('\0');
      hash.update(String(Buffer.byteLength(content)));
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

async function dirExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function clearHostDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
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

async function mergeHostFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
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

function objectMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
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
    test_hash: {},
    completed: {},
    editable: {},
    entered_editable: {},
    archive_built: {},
    updated_at: null,
  };
}

function normalizeSaveMetadata(cfg, metadata = {}) {
  const defaults = defaultSaveMetadata(cfg);
  return {
    ...defaults,
    ...metadata,
    package: defaults.package,
    visited: Array.isArray(metadata.visited) ? metadata.visited : [],
    test_passed: objectMap(metadata.test_passed),
    test_hash: objectMap(metadata.test_hash),
    completed: objectMap(metadata.completed),
    editable: objectMap(metadata.editable),
    entered_editable: objectMap(metadata.entered_editable),
    archive_built: objectMap(metadata.archive_built),
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
