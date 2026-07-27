/**
 * File tree panel (center-left).
 *
 * Decoupled from files.js: the "open file" action is injected via
 * setFileTreeOpenHandler so this module never imports files.js,
 * avoiding a circular dependency (files.js -> file-tree.js -> files.js).
 *
 * The tree auto-refreshes via a real filesystem-change signal pushed from the
 * host over the existing /ws (type 'fs_change'): the host polls `find` in the
 * kernel and pushes a notification when the path set changes. Callers may also
 * invoke refreshFileTree() directly after known local mutations (save, step
 * load). A visibilitychange listener refreshes once when the tab refocuses.
 *
 * Directories are collapsible: clicking a dir toggles its children. The
 * collapsed set is module-level state, preserved across refreshes.
 *
 * All paths go through the same debounced entry point. A signature comparison
 * skips the DOM rebuild when the entry list is unchanged, preventing visual
 * noise and scroll jumps.
 */
import { state } from './state.js';
import { apiGet } from './api.js';
import { t } from './messages.js';
import { panelDeclared } from './panels.js';

let openHandler = null;

// Collapsed directory paths (preserved across refreshes).
const collapsedDirs = new Set();
// Last fetched entries — used for re-render on dir toggle without refetch.
let lastEntries = [];

export function setFileTreeOpenHandler(fn) {
  openHandler = typeof fn === 'function' ? fn : null;
}

export function highlightFileTreePath(filePath) {
  state.fileTreeActivePath = filePath || null;
  document.querySelectorAll('#file-tree-body .file-tree-item.file').forEach(el => {
    el.classList.toggle('active', el.dataset.path === state.fileTreeActivePath);
  });
}

/** True if path lives beneath a collapsed directory. */
function isUnderCollapsed(path) {
  for (const d of collapsedDirs) {
    if (path.startsWith(d + '/')) return true;
  }
  return false;
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
    if (isUnderCollapsed(entry.path)) return;
    const depth = entry.relative.split('/').length - 1;
    const item = document.createElement('div');
    item.className = `file-tree-item ${entry.type === 'dir' ? 'dir' : 'file'}`;
    if (entry.type === 'dir' && collapsedDirs.has(entry.path)) {
      item.classList.add('collapsed');
    }
    item.style.setProperty('--depth', String(depth));
    item.dataset.path = entry.path;
    item.title = entry.relative;
    item.textContent = entry.name;
    if (entry.type === 'file') {
      if (entry.path === state.fileTreeActivePath) item.classList.add('active');
      item.addEventListener('click', () => openHandler?.(entry.path));
    } else {
      item.addEventListener('click', () => {
        if (collapsedDirs.has(entry.path)) collapsedDirs.delete(entry.path);
        else collapsedDirs.add(entry.path);
        renderFileTree(lastEntries);
      });
    }
    body.appendChild(item);
  });
}

// ========== auto-refresh infrastructure ==========

const REFRESH_DEBOUNCE_MS = 400;

let refreshTimer = null;
let lastSignature = '';

/** Compact string fingerprint of the entry list for change detection. */
function entriesSignature(entries) {
  return entries.map(e => `${e.type[0]}:${e.relative}`).join('|');
}

/** Actual fetch + conditional render. Called by the debounced wrapper. */
async function doRefreshFileTree(force = false) {
  if (!panelDeclared('file-tree')) return;
  const body = document.getElementById('file-tree-body');
  if (state.fileTreeFetching && !force) return;
  state.fileTreeFetching = true;
  if (!body.querySelector('.file-tree-item')) {
    body.innerHTML = `<div class="file-tree-empty">${t('files.loading')}</div>`;
  }
  try {
    const data = await apiGet('/api/fs/ls?path=/home/student/workspace&tree=1&depth=4');
    const entries = data.entries || [];
    lastEntries = entries;
    const sig = entriesSignature(entries);
    // Skip DOM rebuild when the tree structure hasn't changed — prevents
    // scroll jumps and visual flicker.
    if (sig !== lastSignature) {
      lastSignature = sig;
      renderFileTree(entries);
    }
  } catch (e) {
    body.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'file-tree-empty';
    err.style.color = 'var(--error)';
    err.textContent = e.message || t('files.readDirFailed');
    body.appendChild(err);
    lastSignature = ''; // reset so next successful fetch re-renders
  } finally {
    state.fileTreeFetching = false;
  }
}

/**
 * Debounced file-tree refresh. Multiple calls within REFRESH_DEBOUNCE_MS
 * coalesce into one fetch. Pass force=true for an immediate (non-debounced)
 * refresh that also bypasses the in-flight guard.
 */
export function refreshFileTree(force = false) {
  if (!panelDeclared('file-tree')) return;
  if (force) {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    doRefreshFileTree(true);
    return;
  }
  if (refreshTimer) return; // already pending
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    doRefreshFileTree(false);
  }, REFRESH_DEBOUNCE_MS);
}
