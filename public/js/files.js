/**
 * Core editor coordination: file tabs, editor switching, step save/reset,
 * and openFileFromContainer (the single entry point for opening a workspace
 * file from either the file-tree or the file-picker).
 *
 * file-tree.js and file-picker.js are decoupled siblings; they receive
 * openFileFromContainer via setFileTreeOpenHandler / setPickerOpenHandler
 * so neither imports this module (no circular dependency).
 *
 * This module re-exports the file-tree / file-picker public API so that
 * app.js keeps importing everything from './files.js'.
 */
import { state, currentStepObj, currentTutorialKey, stepAccessWritable, stepCommandsAllowed } from './state.js';
import { apiJson } from './api.js';
import { toast } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { applyProgress, panelDeclared } from './panels.js';
import { applyStepAccess } from './progress.js';
import { handleError } from './errors.js';
import {
  setFileTreeOpenHandler,
  highlightFileTreePath,
  refreshFileTree,
} from './file-tree.js';
import { setPickerOpenHandler, closeFilePicker } from './file-picker.js';
import { confirmDialog } from './dialog.js';
import {
  appendViewTabs,
  deactivateEditorView,
  clearStepEditorViews,
  setViewTabsChangedHandler,
} from './editor-views.js';
import { fileTabIcon, tabCloseIcon } from './tab-icons.js';

function langForName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const langMap = { c:'c', h:'c', cpp:'cpp', cc:'cpp', hpp:'cpp', py:'python', js:'javascript', ts:'typescript', sh:'shell', bash:'shell', go:'go', rs:'rust' };
  return langMap[ext] || state.currentTutorial?.language || 'plaintext';
}

function syncActiveEditor() {
  if (state.editor && state.currentFiles[state.activeFileIndex]) {
    state.currentFiles[state.activeFileIndex].content = state.editor.getValue();
  }
}

function setEditorEmpty(message = t('files.emptyEditor')) {
  if (!state.editor) return;
  state.suppressModified = true;
  state.editor.setValue(message);
  monaco.editor.setModelLanguage(state.editor.getModel(), state.currentTutorial?.language || 'plaintext');
  state.editor.updateOptions({ readOnly: !state.currentStepAccess?.editable });
  state.suppressModified = false;
}

function loadFilesIntoEditor(files, { ui, entryFile } = {}) {
  const all = (files || []).filter(f => f.type !== 'dir');
  const byName = new Map(all.map(f => [f.name, f]));
  const requested = Array.isArray(ui?.open_files) ? ui.open_files : null;
  let names;
  if (requested) {
    names = requested.filter(name => byName.has(name));
    if (names.length === 0 && requested.length > 0) {
      names = entryFile && byName.has(entryFile) ? [entryFile] : (all[0] ? [all[0].name] : []);
    }
  } else if (entryFile && byName.has(entryFile)) {
    names = [entryFile];
  } else {
    names = all[0] ? [all[0].name] : [];
  }

  state.currentFiles = names.map(name => {
    const f = byName.get(name);
    return {
      name: f.name,
      language: f.language || langForName(f.name),
      content: f.content || '',
      originalContent: f.content || '',
    };
  });
  state.fileModified = state.currentFiles.map(() => false);
  const activeName = (ui?.active_file && names.includes(ui.active_file))
    ? ui.active_file
    : (names[0] || null);
  state.activeFileIndex = activeName ? names.indexOf(activeName) : -1;
  state.fileListCache = null;
  clearStepEditorViews();
  renderFileTabs();
  if (state.activeFileIndex >= 0) {
    switchFile(state.activeFileIndex, true);
  } else {
    setEditorEmpty();
  }
  if (state.editor) {
    state.editor.updateOptions({ readOnly: !state.currentStepAccess?.editable });
  }
  if (panelDeclared('file-tree')) refreshFileTree(true);
}

function currentStepUi() {
  const open_files = state.currentFiles.map(f => f.name);
  const active = state.currentFiles[state.activeFileIndex]?.name || open_files[0] || null;
  return { open_files, active_file: active };
}

// ========== 文件标签栏 ==========
function renderFileTabs() {
  const container = document.getElementById('file-tabs');
  container.querySelectorAll('.tab').forEach(el => el.remove());
  const fragment = document.createDocumentFragment();
  state.currentFiles.forEach((f, i) => {
    const tab = document.createElement('div');
    const fileActive = !state.activeViewId && i === state.activeFileIndex;
    tab.className = 'tab' + (fileActive ? ' active' : '');
    tab.appendChild(fileTabIcon(f.name));
    const name = document.createElement('span');
    name.textContent = f.name || t('files.untitled');
    tab.appendChild(name);
    if (state.fileModified[i]) {
      const dot = document.createElement('span');
      dot.className = 'tab-modified';
      dot.textContent = '●';
      tab.appendChild(dot);
    }
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.title = t('files.closeTab');
    close.appendChild(tabCloseIcon());
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(i); });
    tab.appendChild(close);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchFile(i);
    });
    fragment.appendChild(tab);
  });
  appendViewTabs(fragment);
  const treeBtn = document.getElementById('tab-show-tree-btn');
  if (treeBtn && treeBtn.parentElement === container) {
    container.insertBefore(fragment, treeBtn);
  } else {
    container.appendChild(fragment);
  }
}

setViewTabsChangedHandler(renderFileTabs);

function closeFile(idx) {
  if (idx < 0 || idx >= state.currentFiles.length) return;
  syncActiveEditor();
  state.currentFiles.splice(idx, 1);
  state.fileModified.splice(idx, 1);
  if (state.currentFiles.length === 0) {
    state.activeFileIndex = -1;
    renderFileTabs();
    setEditorEmpty();
    return;
  }
  if (state.activeFileIndex > idx) state.activeFileIndex--;
  state.activeFileIndex = Math.min(state.activeFileIndex, state.currentFiles.length - 1);
  const newIdx = state.activeFileIndex;
  state.activeFileIndex = -1;
  switchFile(newIdx, true);
}

// ========== 保存 / Reset / 打开容器文件 ==========
// Persist this step: Monaco buffers → live workspace, then snapshot the
// whole live dir (including terminal-created files) into the step save.
// The Save button uses force:true. Step switch / run / export should too,
// otherwise a not-dirty editor would skip snapshot and drop `touch` files.
async function saveCurrentStep(opts = {}) {
  const step = currentStepObj();
  if (!state.currentTutorial || !step) return;
  if (!state.currentStepAccess?.editable) return;
  if (state.commandBusy && !opts.force) return;
  syncActiveEditor();
  const hasDirty = state.fileModified.some(Boolean);
  if (!hasDirty && !opts.force) return;
  const result = await apiJson('/api/steps/save', {
    tutorial: currentTutorialKey(),
    step: step.id,
    files: state.currentFiles.map(f => ({ name: f.name, content: f.content })),
    ui: currentStepUi(),
    generation: state.currentStepAccess?.generation,
  });
  state.currentFiles.forEach(f => { f.originalContent = f.content; });
  state.fileModified = state.currentFiles.map(() => false);
  renderFileTabs();
  applyProgress(result.progress);
  refreshFileTree(false);
  if (!opts.silent) toast(t('save.saved'));
}

async function saveFile() {
  try {
    await saveCurrentStep({ force: true });
  } catch (e) {
    handleError(e, {
      feature: 'files',
      message: t('save.saveFailed', { error: e.message }),
      notify: true,
    });
  }
}

async function resetCurrentStep() {
  const step = currentStepObj();
  if (!state.currentTutorial || !step || !stepCommandsAllowed()) return;
  const ok = await confirmDialog({
    title: t('save.resetTitle'),
    body: t('save.resetBody', { title: step.title || step.id }),
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await apiJson('/api/steps/reset', {
      tutorial: currentTutorialKey(),
      step: step.id,
      generation: state.currentStepAccess?.generation,
    });
    applyStepAccess(result);
    loadFilesIntoEditor(result.files || [], {
      ui: result.ui,
      entryFile: step.entry_file,
    });
    applyProgress(result.progress);
    appendSessionLog(t('save.resetLog', { id: step.id }), 'warn');
    toast(t('save.resetDone'));
  } catch (e) {
    handleError(e, {
      feature: 'files',
      message: t('save.resetFailed', { error: e.message }),
      notify: true,
    });
  }
}

async function applySolution() {
  const step = currentStepObj();
  if (!state.currentTutorial || !step || !stepCommandsAllowed() || !state.currentStepAccess?.has_solution) return;
  const ok = await confirmDialog({
    title: t('save.solutionTitle'),
    body: t('save.solutionBody', { title: step.title || step.id }),
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await apiJson('/api/steps/solution', {
      tutorial: currentTutorialKey(),
      step: step.id,
      generation: state.currentStepAccess?.generation,
    });
    applyStepAccess(result);
    loadFilesIntoEditor(result.files || [], {
      ui: result.ui,
      entryFile: step.entry_file,
    });
    applyProgress(result.progress);
    appendSessionLog(t('save.solutionLog', { id: step.id }), 'warn');
    toast(t('save.solutionDone'));
  } catch (e) {
    handleError(e, {
      feature: 'files',
      message: t('save.solutionFailed', { error: e.message }),
      notify: true,
    });
  }
}

function workspaceRelativeName(filePath) {
  const root = '/home/student/workspace/';
  const abs = String(filePath || '');
  if (abs.startsWith(root)) return abs.slice(root.length);
  return abs.split('/').pop();
}

async function openFileFromContainer(filename) {
  try {
    const { content } = await apiJson('/api/fs/read', { path: filename });
    const name = workspaceRelativeName(filename);
    const existing = state.currentFiles.findIndex(f => f.name === name || f.path === filename);
    if (existing >= 0) {
      state.currentFiles[existing].content = content;
      state.currentFiles[existing].originalContent = content;
      state.currentFiles[existing].path = filename;
      state.fileModified[existing] = false;
      state.activeFileIndex = existing;
    } else {
      state.currentFiles.push({
        name,
        path: filename,
        language: langForName(name),
        content,
        originalContent: content,
      });
      state.fileModified.push(false);
      state.activeFileIndex = state.currentFiles.length - 1;
    }
    renderFileTabs();
    switchFile(state.activeFileIndex, true);
    closeFilePicker();
    highlightFileTreePath(filename);
  } catch (e) {
    handleError(e, {
      feature: 'files',
      message: t('files.openFailed', { error: e.message }),
      notify: true,
    });
  }
}

// Register the open-file handler with both decoupled siblings.
// Function declarations are hoisted, so referencing openFileFromContainer
// here at module top is safe.
setFileTreeOpenHandler(openFileFromContainer);
setPickerOpenHandler(openFileFromContainer);

function switchFile(idx, force = false) {
  if (idx < 0 || idx >= state.currentFiles.length) return;
  const viewWasActive = Boolean(state.activeViewId);
  if (!force && idx === state.activeFileIndex && !viewWasActive) return;
  if (!force) syncActiveEditor();
  deactivateEditorView();
  state.activeFileIndex = idx;
  const f = state.currentFiles[idx];
  if (state.editor) {
    state.suppressModified = true;
    state.editor.setValue(f.content);
    monaco.editor.setModelLanguage(state.editor.getModel(), f.language || state.currentTutorial?.language || 'c');
    state.suppressModified = false;
  }
  renderFileTabs();
}

// Monaco 可能晚于 step 文件就绪: 编辑器创建后调用此函数把当前文件回填进编辑器。
function syncEditorToCurrentFile() {
  if (!state.editor) return;
  renderFileTabs();
  if (state.activeFileIndex >= 0 && state.currentFiles[state.activeFileIndex]) {
    switchFile(state.activeFileIndex, true);
  } else {
    setEditorEmpty();
  }
}

// Re-export decoupled siblings so app.js imports keep working from './files.js'.
export {
  renderFileTree,
  refreshFileTree,
  highlightFileTreePath,
} from './file-tree.js';
export {
  fetchFileList,
  renderFileList,
  loadFilePickerList,
  openFilePicker,
  closeFilePicker,
} from './file-picker.js';

export {
  langForName,
  syncActiveEditor,
  setEditorEmpty,
  loadFilesIntoEditor,
  renderFileTabs,
  closeFile,
  saveCurrentStep,
  saveFile,
  resetCurrentStep,
  applySolution,
  workspaceRelativeName,
  openFileFromContainer,
  switchFile,
  syncEditorToCurrentFile,
};
