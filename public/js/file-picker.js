/**
 * File picker overlay (open container files).
 *
 * Decoupled from files.js: the "open file" action is injected via
 * setPickerOpenHandler so this module never imports files.js.
 */
import { state } from './state.js';
import { apiGet } from './api.js';
import { t } from './messages.js';

let openHandler = null;

export function setPickerOpenHandler(fn) {
  openHandler = typeof fn === 'function' ? fn : null;
}

const WORKSPACE_ROOT = '/home/student/workspace';

export async function fetchFileList() {
  const data = await apiGet(`/api/fs/ls?path=${encodeURIComponent(WORKSPACE_ROOT)}`);
  const files = data.files || [];
  state.fileListCache = files;
  return files;
}

export function renderFileList(files) {
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
    item.addEventListener('click', () => openHandler?.(`${WORKSPACE_ROOT}/${f.name}`));
    list.appendChild(item);
  });
}

export async function loadFilePickerList(force = false) {
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
    err.textContent = e.message || t('files.readDirFailed');
    list.appendChild(err);
  }
}

export function openFilePicker() {
  document.getElementById('file-picker-overlay').style.display = 'block';
  loadFilePickerList();
}

export function closeFilePicker() {
  document.getElementById('file-picker-overlay').style.display = 'none';
}
