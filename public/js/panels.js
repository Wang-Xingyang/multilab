import {
  state,
  FALLBACK_PANELS,
} from './state.js';
import { t } from './messages.js';
import { apiGet } from './api.js';
import { normalizeProgress, renderProgressStrip } from './progress.js';
import { openEditorView, setViewOpenGuard } from './editor-views.js';

const panelHooks = {
  selectStep: null,
  refreshTree: null,
};

export function setPanelHooks(hooks = {}) {
  if (hooks.selectStep) panelHooks.selectStep = hooks.selectStep;
  if (hooks.refreshTree) panelHooks.refreshTree = hooks.refreshTree;
}

function getPanelDecls() {
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

setViewOpenGuard((id) => id === 'logs' || id === 'diagnostics' || panelDeclared(id));

function applyProgressToUi() {
  renderProgressStrip(state.currentTutorial, state.currentProgress, {
    currentStepIndex: state.currentStep,
    onSelectStep: (index) => {
      if (index !== state.currentStep) panelHooks.selectStep?.(index);
    },
  });
}

function applyProgress(progress) {
  if (!progress) return;
  state.currentProgress = normalizeProgress(progress);
  applyProgressToUi();
}

function applyPanelLayout() {
  const tutorial = panelDecl('tutorial');
  const terminal = panelDecl('terminal');
  const fileTree = panelDecl('file-tree');

  const showTutorial = Boolean(tutorial && !tutorial.hidden);
  const showTerminal = !terminal || !terminal.hidden;
  const showFileTree = Boolean(fileTree && !fileTree.hidden);

  document.getElementById('tutorial-panel').style.display = showTutorial ? '' : 'none';
  document.getElementById('drag-v').style.display = showTutorial ? '' : 'none';
  document.getElementById('terminal-wrap').style.display = showTerminal ? '' : 'none';
  document.getElementById('drag-h').style.display = showTerminal ? '' : 'none';

  const treePanel = document.getElementById('file-tree-panel');
  const dragTree = document.getElementById('drag-v-tree');
  const treeCollapsed = state.fileTreeCollapsed;
  treePanel.classList.toggle('visible', showFileTree);
  treePanel.classList.toggle('collapsed', treeCollapsed);
  dragTree.style.display = (showFileTree && !treeCollapsed) ? '' : 'none';
  const treeToggle = document.getElementById('tab-show-tree-btn');
  if (treeToggle) {
    treeToggle.style.display = showFileTree ? '' : 'none';
    treeToggle.classList.toggle('is-open', showFileTree && !treeCollapsed);
    treeToggle.title = t('files.treeTitle');
    treeToggle.setAttribute('aria-label', t('files.toggleTree'));
    treeToggle.setAttribute('aria-pressed', showFileTree && !treeCollapsed ? 'true' : 'false');
  }
  if (showFileTree && !treeCollapsed) {
    const body = document.getElementById('file-tree-body');
    if (!body.querySelector('.file-tree-item')) panelHooks.refreshTree?.(false);
  }

  const logsBtn = document.getElementById('logs-btn');
  const diagBtn = document.getElementById('diag-btn');
  if (logsBtn) logsBtn.classList.toggle('is-open', state.activeViewId === 'logs');
  if (diagBtn) diagBtn.classList.toggle('is-open', state.activeViewId === 'diagnostics');

  applyProgressToUi();
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

function revealAuxPanel(tab) {
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
  if (panelDeclared('web-preview')) revealAuxPanel('web-preview');
}


export {
  getPanelDecls,
  panelDecl,
  panelDeclared,
  applyProgressToUi,
  applyProgress,
  applyPanelLayout,
  revealAuxPanel,
  showTestResults,
  renderPreviewFrame,
  renderPreviewUrlFrame,
  showPreviewUrlText,
  showPreviewContent,
};
