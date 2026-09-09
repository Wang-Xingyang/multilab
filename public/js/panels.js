import {
  state,
  FALLBACK_PANELS,
  currentStepObj,
  stepCommand,
} from './state.js';
import { t } from './messages.js';
import { apiGet } from './api.js';
import { normalizeProgress, renderProgressStrip } from './progress.js';
import { openEditorView, setViewOpenGuard } from './editor-views.js';
import { openHostDrawer } from './host-drawer.js';
import { applyPreviewSplit } from './layout.js';

const panelHooks = {
  selectStep: null,
  refreshTree: null,
};

export function setPanelHooks(hooks = {}) {
  if (hooks.selectStep) panelHooks.selectStep = hooks.selectStep;
  if (hooks.refreshTree) panelHooks.refreshTree = hooks.refreshTree;
}

function getPanelDecls() {
  const stepPanels = currentStepObj()?.ui_panels?.panels;
  if (Array.isArray(stepPanels) && stepPanels.length) return stepPanels;
  if (Array.isArray(state.currentTutorial?.ui_panels?.panels) && state.currentTutorial.ui_panels.panels.length) {
    return state.currentTutorial.ui_panels.panels;
  }
  const panels = state.currentTutorial?.default_panels;
  return Array.isArray(panels) && panels.length ? panels : FALLBACK_PANELS;
}

function panelDecl(type) {
  return getPanelDecls().find(panel => panel.type === type) || null;
}

function panelDeclared(type) {
  return Boolean(panelDecl(type));
}

setViewOpenGuard((id) => panelDeclared(id));

function applyProgressToUi() {
  renderProgressStrip(state.currentTutorial, state.currentProgress, {
    currentStepIndex: state.currentStep,
  });
}

function applyStepCommands() {
  const step = currentStepObj();
  const writable = Boolean(state.currentStepAccess?.editable) && !state.commandBusy;
  const setShown = (id, shown) => {
    const el = document.getElementById(id);
    if (el) el.style.display = shown ? '' : 'none';
  };
  const setDisabled = (id, disabled) => {
    const el = document.getElementById(id);
    if (el) el.disabled = Boolean(disabled);
  };
  setShown('run-btn', Boolean(stepCommand(step, 'run')));
  setShown('test-btn', Boolean(stepCommand(step, 'test')));
  setShown('preview-btn', Boolean(stepCommand(step, 'preview')));
  const terminal = panelDecl('terminal');
  setShown('interrupt-btn', Boolean(terminal && !terminal.hidden));
  const editor = panelDecl('editor');
  setShown('revert-btn', Boolean(writable && editor && !editor.hidden));
  setShown('solution-btn', Boolean(writable && state.currentStepAccess?.has_solution));
  setDisabled('run-btn', state.commandBusy);
  setDisabled('preview-btn', state.commandBusy);
  setDisabled('test-btn', !writable);
  setDisabled('revert-btn', !writable);
  setDisabled('solution-btn', !writable);
}

function applyProgress(progress) {
  if (!progress) return;
  state.currentProgress = normalizeProgress(progress);
  applyProgressToUi();
  applyStepCommands();
}

function applyPanelLayout() {
  const tutorial = panelDecl('tutorial');
  const terminal = panelDecl('terminal');
  const fileTree = panelDecl('file-tree');
  const editor = panelDecl('editor');
  const preview = panelDecl('web-preview');

  const packageShowsTutorial = Boolean(tutorial && !tutorial.hidden);
  const userCollapsed = Boolean(state.tutorialCollapsed);
  const showTutorial = packageShowsTutorial && !userCollapsed;
  const showEditor = Boolean(editor && !editor.hidden);
  const showPreview = Boolean((preview && !preview.hidden) || state.previewForcedOpen);
  const showTerminal = Boolean(terminal && !terminal.hidden);
  const showFileTree = Boolean(showEditor && fileTree && !fileTree.hidden);

  document.body.classList.toggle('tutorial-collapsed', userCollapsed && packageShowsTutorial);
  document.getElementById('tutorial-panel').style.display = showTutorial ? '' : 'none';
  document.getElementById('drag-v').style.display = showTutorial ? '' : 'none';
  document.getElementById('editor-column').style.display = showEditor ? '' : 'none';
  document.getElementById('preview-column').classList.toggle('visible', showPreview);
  const dragPreview = document.getElementById('drag-v-preview');
  if (dragPreview) dragPreview.style.display = (showEditor && showPreview) ? '' : 'none';
  document.getElementById('terminal-wrap').style.display = showTerminal ? '' : 'none';
  document.getElementById('drag-h').style.display = showTerminal ? '' : 'none';

  const collapseBtn = document.getElementById('toggle-tutorial-btn');
  if (collapseBtn) {
    collapseBtn.style.display = packageShowsTutorial ? '' : 'none';
    collapseBtn.classList.toggle('is-open', userCollapsed && packageShowsTutorial);
    collapseBtn.setAttribute('aria-pressed', userCollapsed ? 'true' : 'false');
  }

  const treePanel = document.getElementById('file-tree-panel');
  const dragTree = document.getElementById('drag-v-tree');
  const treeCollapsed = state.fileTreeCollapsed;
  treePanel.classList.toggle('visible', showFileTree);
  treePanel.classList.toggle('collapsed', treeCollapsed);
  dragTree.style.display = (showFileTree && !treeCollapsed) ? '' : 'none';
  const treeToggle = document.getElementById('tab-show-tree-btn');
  if (treeToggle) {
    treeToggle.style.display = showFileTree ? 'flex' : 'none';
    treeToggle.classList.toggle('is-open', showFileTree && !treeCollapsed);
    treeToggle.title = t('files.treeTitle');
    treeToggle.setAttribute('aria-label', t('files.toggleTree'));
    treeToggle.setAttribute('aria-pressed', showFileTree && !treeCollapsed ? 'true' : 'false');
  }
  if (showFileTree && !treeCollapsed) {
    const body = document.getElementById('file-tree-body');
    if (!body.querySelector('.file-tree-item')) panelHooks.refreshTree?.(false);
  }

  applyPreviewSplit();
  applyStepCommands();
  applyProgressToUi();
  if (state.editor) state.editor.layout();
}

export function setFileTreeCollapsed(collapsed) {
  state.fileTreeCollapsed = collapsed;
  applyPanelLayout();
  if (!collapsed) panelHooks.refreshTree?.(false);
  if (state.fitAddon) state.fitAddon.fit();
}

export function toggleFileTree() {
  setFileTreeCollapsed(!state.fileTreeCollapsed);
}

export function toggleTutorialCollapsed() {
  state.tutorialCollapsed = !state.tutorialCollapsed;
  try {
    localStorage.setItem('ml-tutorial-collapsed', state.tutorialCollapsed ? '1' : '0');
  } catch { /* ignore quota */ }
  applyPanelLayout();
  if (state.fitAddon) state.fitAddon.fit();
}

function revealAuxPanel(tab) {
  if (tab === 'web-preview') {
    state.previewForcedOpen = true;
    applyPanelLayout();
    return;
  }
  if (tab === 'logs' || tab === 'diagnostics') {
    openHostDrawer();
    return;
  }
  openEditorView(tab);
}

function showTestResults(result) {
  const pane = document.getElementById('pane-test-results');
  const passed = Boolean(result?.passed);
  const output = result?.output || '';
  pane.innerHTML = `
    <div class="test-result-badge ${passed ? 'pass' : 'fail'}">${passed ? 'PASS' : 'FAIL'}</div>
    <div class="test-result-output"></div>
  `;
  pane.querySelector('.test-result-output').textContent = output || t('preview.noOutput');
  if (panelDeclared('test-results')) revealAuxPanel('test-results');
}

function renderPreviewFrame(pane, html) {
  pane.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.className = 'preview-frame';
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.srcdoc = html;
  pane.appendChild(iframe);
}

function renderPreviewUrlFrame(pane, url, { note } = {}) {
  pane.innerHTML = '';
  if (note) {
    const tip = document.createElement('div');
    tip.className = 'aux-empty';
    tip.style.marginBottom = '8px';
    tip.textContent = note;
    pane.appendChild(tip);
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.className = 'preview-output';
  link.style.display = 'block';
  link.style.marginBottom = '8px';
  link.style.color = 'var(--accent)';
  link.textContent = url;
  pane.appendChild(link);
  const iframe = document.createElement('iframe');
  iframe.className = 'preview-frame';
  // Live preview is host-local (127.0.0.1). Keep scripts; avoid same-origin with MultiLab UI.
  iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  iframe.src = url;
  pane.appendChild(iframe);
}

function showPreviewUrlText(pane, advertised, output) {
  pane.innerHTML = '';
  const note = document.createElement('div');
  note.className = 'aux-empty';
  note.textContent = t('preview.unmapped');
  const url = document.createElement('div');
  url.className = 'preview-output';
  url.textContent = advertised || '';
  const raw = document.createElement('div');
  raw.className = 'preview-output';
  raw.style.marginTop = '12px';
  raw.style.color = 'var(--text-dim)';
  raw.textContent = output || '';
  pane.append(note, url, raw);
}

async function showPreviewContent(result) {
  const pane = document.getElementById('pane-web-preview');
  const output = String(result?.output || '');
  const htmlMatch = output.match(/MULTILAB_PREVIEW_HTML\s*\n([\s\S]*)$/);
  const urlMatch = output.match(/MULTILAB_PREVIEW_URL=(https?:\/\/\S+)/);
  const mappedUrl = result?.preview_url || null;

  if (htmlMatch) {
    renderPreviewFrame(pane, htmlMatch[1].trim());
  } else if (mappedUrl) {
    renderPreviewUrlFrame(pane, mappedUrl, {
      note: result.preview_advertised_url
        ? t('preview.mappedFrom', { url: result.preview_advertised_url })
        : t('preview.mappedNote'),
    });
  } else if (urlMatch) {
    let resolved = null;
    try {
      const runtime = await apiGet('/api/runtime');
      const portMap = runtime?.port_map || {};
      const advertised = new URL(urlMatch[1]);
      const containerPort = Number(advertised.port || (advertised.protocol === 'https:' ? 443 : 80));
      const hostPort = portMap[containerPort] || portMap[String(containerPort)];
      if (hostPort) {
        resolved = `http://127.0.0.1:${hostPort}${advertised.pathname || '/'}${advertised.search || ''}${advertised.hash || ''}`;
      }
    } catch { /* keep text fallback */ }
    if (resolved) renderPreviewUrlFrame(pane, resolved, { note: t('preview.mappedFrom', { url: urlMatch[1] }) });
    else showPreviewUrlText(pane, urlMatch[1], output);
  } else if (/<[a-z][\s\S]*>/i.test(output)) {
    renderPreviewFrame(pane, output);
  } else {
    pane.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'preview-output';
    pre.textContent = output || t('preview.empty');
    pane.appendChild(pre);
  }
  revealAuxPanel('web-preview');
}


export {
  getPanelDecls,
  panelDecl,
  panelDeclared,
  applyProgressToUi,
  applyProgress,
  applyPanelLayout,
  applyStepCommands,
  revealAuxPanel,
  showTestResults,
  renderPreviewFrame,
  renderPreviewUrlFrame,
  showPreviewUrlText,
  showPreviewContent,
};
