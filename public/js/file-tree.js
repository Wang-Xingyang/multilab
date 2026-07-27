/**
 * File tree panel (center-left).
 *
 * Decoupled from files.js: the "open file" action is injected via
 * setFileTreeOpenHandler so this module never imports files.js,
 * avoiding a circular dependency (files.js -> file-tree.js -> files.js).
 *
 * The tree auto-refreshes via two mechanisms:
 * 1. Event-driven: callers invoke refreshFileTree() after known FS mutations
 *    (save, step load, command completion, terminal exit).
 * 2. Polling: startFileTreePolling() runs a 4s interval that only fires when
 *    the tree is visible, expanded, page is focused, and WS is connected.
 *    This catches arbitrary terminal commands (touch/rm/mkdir) that have no
 *    explicit signal.
 *
 * Both paths go through the same debounced entry point. A signature comparison
 * skips the DOM rebuild when the entry list is unchanged, preventing visual
 * noise and scroll jumps during polling.
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

// ========== auto-refresh infrastructure ==========

const REFRESH_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 4000;

let refreshTimer = null;
let pollTimer = null;
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
    const sig = entriesSignature(entries);
    // Skip DOM rebuild when the tree structure hasn't changed — prevents
    // scroll jumps and visual flicker during polling.
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

/**
 * Start a 4s polling interval that refreshes the file tree when:
 * - the page is visible (not in a background tab)
 * - the file-tree panel is declared and visible
 * - the tree is not collapsed
 * - the terminal WebSocket is connected
 *
 * Each tick only does cheap boolean checks; the actual fetch is debounced
 * and signature-gated, so the overhead is minimal when nothing changes.
 */
export function startFileTreePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.fileTreeCollapsed) return;
    if (!panelDeclared('file-tree')) return;
    const treePanel = document.getElementById('file-tree-panel');
    if (!treePanel || !treePanel.classList.contains('visible')) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    refreshFileTree(false);
  }, POLL_INTERVAL_MS);
}

export function stopFileTreePolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
