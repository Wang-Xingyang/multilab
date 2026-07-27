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
import { state, currentStepObj, currentTutorialKey } from './state.js';
import { apiJson } from './api.js';
import { toast } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { applyProgress, panelDeclared } from './panels.js';
import { handleError } from './errors.js';
import {
  setFileTreeOpenHandler,
  highlightFileTreePath,
  refreshFileTree,
} from './file-tree.js';
import { setPickerOpenHandler, closeFilePicker } from './file-picker.js';
import { confirmDialog } from './dialog.js';

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
  state.suppressModified = false;
}

function loadFilesIntoEditor(files) {
  state.currentFiles = (files || []).map(f => ({
    name: f.name,
    language: f.language || langForName(f.name),
    content: f.content || '',
    originalContent: f.content || '',
  }));
  state.fileModified = state.currentFiles.map(() => false);
  state.activeFileIndex = state.currentFiles.length > 0 ? 0 : -1;
  renderFileTabs();
  if (state.currentFiles.length > 0) {
    switchFile(0, true);
  } else {
    setEditorEmpty();
  }
  state.fileListCache = null;
  if (panelDeclared('file-tree')) refreshFileTree(true);
}

// ========== 文件标签栏 ==========
function renderFileTabs() {
  const container = document.getElementById('file-tabs');
  const showTreeBtn = document.getElementById('tab-show-tree-btn');
  // 只移除 .tab, 保留静态的 tab-show-tree-btn (不再用 innerHTML='' 清空)
  container.querySelectorAll('.tab').forEach(el => el.remove());
  const fragment = document.createDocumentFragment();
  state.currentFiles.forEach((f, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === state.activeFileIndex ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = f.name || 'untitled';
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
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(i); });
    tab.appendChild(close);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchFile(i);
    });
    fragment.appendChild(tab);
  });
  if (showTreeBtn) container.insertBefore(fragment, showTreeBtn);
  else container.appendChild(fragment);
}

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
async function saveCurrentStep(opts = {}) {
  const step = currentStepObj();
  if (!state.currentTutorial || !step) return;
  syncActiveEditor();
  const hasDirty = state.fileModified.some(Boolean);
  if (!hasDirty && !opts.force) return;
  const result = await apiJson('/api/steps/save', {
    tutorial: currentTutorialKey(),
    step: step.id,
    files: state.currentFiles.map(f => ({ name: f.name, content: f.content })),
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
  if (!state.currentTutorial || !step) return;
  const ok = await confirmDialog({
    title: t('save.resetTitle'),
    body: t('save.resetBody', { title: step.title || step.id }),
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await apiJson('/api/steps/reset', { tutorial: currentTutorialKey(), step: step.id });
    loadFilesIntoEditor(result.files || []);
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
  if (!force && idx === state.activeFileIndex) return;
  if (!force) syncActiveEditor();
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
  workspaceRelativeName,
  openFileFromContainer,
  switchFile,
  syncEditorToCurrentFile,
};
