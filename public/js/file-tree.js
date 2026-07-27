/**
 * File tree panel (center-left).
 *
 * Decoupled from files.js: the "open file" action is injected via
 * setFileTreeOpenHandler so this module never imports files.js,
 * avoiding a circular dependency (files.js -> file-tree.js -> files.js).
 */
import { state } from './state.js';
import { apiGet } from './api.js';
import { t } from './messages.js';
import { panelDeclared } from './panels.js';

let openHandler = null;

export function setFileTreeOpenHandler(fn) {
  openHandler = typeof fn === 'function' ? fn : null;
}

export function highlightFileTreePath(filePath) {
  state.fileTreeActivePath = filePath || null;
  document.querySelectorAll('#file-tree-body .file-tree-item.file').forEach(el => {
    el.classList.toggle('active', el.dataset.path === state.fileTreeActivePath);
  });
}

export function renderFileTree(entries) {
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
    item.textContent = entry.name;
    if (entry.type === 'file') {
      if (entry.path === state.fileTreeActivePath) item.classList.add('active');
      item.addEventListener('click', () => openHandler?.(entry.path));
    }
    body.appendChild(item);
  });
}

export async function refreshFileTree(force = false) {
  if (!panelDeclared('file-tree')) return;
  const body = document.getElementById('file-tree-body');
  if (state.fileTreeFetching && !force) return;
  state.fileTreeFetching = true;
  if (!body.querySelector('.file-tree-item')) {
    body.innerHTML = `<div class="file-tree-empty">${t('files.loading')}</div>`;
  }
  try {
    const data = await apiGet('/api/fs/ls?path=/home/student/workspace&tree=1&depth=4');
    renderFileTree(data.entries || []);
  } catch (e) {
    body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'file-tree-empty';
    err.style.color = 'var(--error)';
    err.textContent = e.message || t('files.readDirFailed');
    body.appendChild(err);
  } finally {
    state.fileTreeFetching = false;
  }
}
