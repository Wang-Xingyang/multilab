/**
 * Editor-area view tabs.
 *
 * Files share the tab strip with step-scoped views such as test-results.
 * Preview is a peer column. Logs and diagnostics live in the host drawer.
 */
import { state } from './state.js';
import { t } from './messages.js';
import { viewTabIcon, tabCloseIcon } from './tab-icons.js';

export const EDITOR_VIEW_TYPES = ['test-results'];

let tabsChanged = null;
let viewAllowed = () => true;

export function setViewTabsChangedHandler(fn) {
  tabsChanged = typeof fn === 'function' ? fn : null;
}

export function setViewOpenGuard(fn) {
  viewAllowed = typeof fn === 'function' ? fn : () => true;
}

function viewTitle(id) {
  if (id === 'test-results') return t('views.testResults');
  return id;
}

export function applyEditorViewVisibility() {
  const wrap = document.getElementById('editor-wrap');
  if (wrap) wrap.classList.toggle('showing-view', Boolean(state.activeViewId));
  for (const type of EDITOR_VIEW_TYPES) {
    const pane = document.getElementById(`pane-${type}`);
    if (pane) pane.classList.toggle('active', state.activeViewId === type);
  }
  if (!state.activeViewId && state.editor) state.editor.layout();
}

export function openEditorView(id) {
  if (!EDITOR_VIEW_TYPES.includes(id) || !viewAllowed(id)) return;
  if (!state.openViewTabs.includes(id)) state.openViewTabs.push(id);
  state.activeViewId = id;
  applyEditorViewVisibility();
  tabsChanged?.();
}

export function closeEditorView(id) {
  state.openViewTabs = state.openViewTabs.filter(item => item !== id);
  if (state.activeViewId === id) {
    state.activeViewId = null;
    applyEditorViewVisibility();
  }
  tabsChanged?.();
}

export function deactivateEditorView() {
  if (!state.activeViewId) return;
  state.activeViewId = null;
  applyEditorViewVisibility();
}

export function clearEditorViews() {
  state.openViewTabs = [];
  state.activeViewId = null;
  applyEditorViewVisibility();
}

/** Drop step-scoped views when switching steps. */
export function clearStepEditorViews() {
  clearEditorViews();
}

export function appendViewTabs(fragment) {
  for (const id of state.openViewTabs) {
    const tab = document.createElement('div');
    tab.className = 'tab view-tab' + (state.activeViewId === id ? ' active' : '');
    tab.dataset.view = id;
    tab.appendChild(viewTabIcon(id));
    const name = document.createElement('span');
    name.textContent = viewTitle(id);
    tab.appendChild(name);
    const close = document.createElement('span');
    close.className = 'tab-close';
    close.title = t('files.closeTab');
    close.appendChild(tabCloseIcon());
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeEditorView(id);
    });
    tab.appendChild(close);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) return;
      openEditorView(id);
    });
    fragment.appendChild(tab);
  }
}
