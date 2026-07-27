import { state, currentStepObj, currentTutorialKey } from './state.js';
import { apiJson } from './api.js';
import { toast } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { applyProgress, panelDeclared } from './panels.js';

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
  const openBtn = document.getElementById('tab-open-btn');
  container.innerHTML = '';
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
    close.title = '关闭';
    close.textContent = '×';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeFile(i); });
    tab.appendChild(close);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      switchFile(i);
    });
    container.appendChild(tab);
  });
  container.appendChild(openBtn);
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

function createNewFile() {
  syncActiveEditor();
  const name = prompt('文件名 (含后缀,如 hello.c)', 'new.c');
  if (!name || !name.trim()) return;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    toast(t('files.badName'), true);
    return;
  }
  const language = langForName(name.trim());
  state.currentFiles.push({
    name: name.trim(),
    language,
    content: language === 'c' ? '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n'
      : language === 'python' ? 'print("hello")\n'
      : '',
    originalContent: '',
  });
  state.fileModified.push(true);
  state.activeFileIndex = state.currentFiles.length - 1;
  renderFileTabs();
  switchFile(state.activeFileIndex, true);
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
  if (!opts.silent) toast(t('save.saved'));
}

async function saveFile() {
  try {
    await saveCurrentStep({ force: true });
  } catch (e) {
    toast(t('save.saveFailed', { error: e.message }), true);
  }
}

async function resetCurrentStep() {
  const step = currentStepObj();
  if (!state.currentTutorial || !step) return;
  if (!confirm(t('save.resetConfirm', { title: step.title || step.id }))) return;
  try {
    const result = await apiJson('/api/steps/reset', { tutorial: currentTutorialKey(), step: step.id });
    loadFilesIntoEditor(result.files || []);
    applyProgress(result.progress);
    appendSessionLog(t('save.resetLog', { id: step.id }), 'warn');
    toast(t('save.resetDone'));
  } catch (e) {
    toast(t('save.resetFailed', { error: e.message }), true);
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
    const res = await fetch('/api/fs/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filename }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '读取失败');
    const { content } = await res.json();
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
  } catch (e) { toast(t('files.openFailed', { error: e.message }), true); }
}

function highlightFileTreePath(filePath) {
  state.fileTreeActivePath = filePath || null;
  document.querySelectorAll('#file-tree-body .file-tree-item.file').forEach(el => {
    el.classList.toggle('active', el.dataset.path === state.fileTreeActivePath);
  });
}

function renderFileTree(entries) {
  const body = document.getElementById('file-tree-body');
  body.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'file-tree-empty';
    empty.textContent = t('files.emptyWorkspace');
    body.appendChild(empty);
    return;
  }
  entries.forEach(entry => {
    const depth = entry.relative.split('/').length - 1;
    const item = document.createElement('div');
    item.className = `file-tree-item ${entry.type === 'dir' ? 'dir' : 'file'}`;
    item.style.setProperty('--depth', String(depth));
    item.dataset.path = entry.path;
    item.title = entry.relative;
    item.textContent = (entry.type === 'dir' ? '▸ ' : '') + entry.name;
    if (entry.type === 'file') {
      if (entry.path === state.fileTreeActivePath) item.classList.add('active');
      item.addEventListener('click', () => openFileFromContainer(entry.path));
    }
    body.appendChild(item);
  });
}

async function refreshFileTree(force = false) {
  if (!panelDeclared('file-tree')) return;
  const body = document.getElementById('file-tree-body');
  if (state.fileTreeFetching && !force) return;
  state.fileTreeFetching = true;
  if (!body.querySelector('.file-tree-item')) {
    body.innerHTML = `<div class="file-tree-empty">${t('files.loading')}</div>`;
  }
  try {
    const res = await fetch('/api/fs/ls?path=/home/student/workspace&tree=1&depth=4');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '读取目录失败');
    const data = await res.json();
    renderFileTree(data.entries || []);
  } catch (e) {
    body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'file-tree-empty';
    err.style.color = 'var(--error)';
    err.textContent = e.message || '加载失败';
    body.appendChild(err);
  } finally {
    state.fileTreeFetching = false;
  }
}

async function fetchFileList() {
  const res = await fetch('/api/fs/ls?path=/home/student/workspace');
  if (!res.ok) throw new Error('读取目录失败');
  const { files } = await res.json();
  state.fileListCache = files;
  return files;
}

function renderFileList(files) {
  const list = document.getElementById('file-picker-list');
  list.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = t('files.emptyWorkspace');
    list.appendChild(empty);
    return;
  }
  files.forEach(f => {
    const item = document.createElement('div');
    item.className = 'file-item';
    const label = document.createElement('span');
    label.textContent = f.name;
    item.appendChild(label);
    item.addEventListener('click', () => openFileFromContainer(`/home/student/workspace/${f.name}`));
    list.appendChild(item);
  });
}

async function loadFilePickerList(force = false) {
  const list = document.getElementById('file-picker-list');
  if (state.fileListCache && !force) {
    renderFileList(state.fileListCache);
    if (!state.fileListFetching) {
      state.fileListFetching = true;
      fetchFileList().then(files => renderFileList(files)).catch(() => {}).finally(() => { state.fileListFetching = false; });
    }
    return;
  }
  if (!state.fileListCache) list.innerHTML = `<div class="file-empty">${t('files.loading')}</div>`;
  try {
    renderFileList(await fetchFileList());
  } catch (e) {
    list.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'file-empty';
    err.style.color = 'var(--error)';
    err.textContent = '错误: ' + e.message;
    list.appendChild(err);
  }
}

function openFilePicker() {
  document.getElementById('file-picker-overlay').style.display = 'block';
  loadFilePickerList();
}

function closeFilePicker() {
  document.getElementById('file-picker-overlay').style.display = 'none';
}

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

export {
  langForName,
  syncActiveEditor,
  setEditorEmpty,
  loadFilesIntoEditor,
  renderFileTabs,
  closeFile,
  createNewFile,
  saveCurrentStep,
  saveFile,
  resetCurrentStep,
  workspaceRelativeName,
  openFileFromContainer,
  highlightFileTreePath,
  renderFileTree,
  refreshFileTree,
  fetchFileList,
  renderFileList,
  loadFilePickerList,
  openFilePicker,
  closeFilePicker,
  switchFile,
  syncEditorToCurrentFile,
};
