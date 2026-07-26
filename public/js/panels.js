import {
  state,
  FALLBACK_PANELS,
  AUX_PANEL_TYPES,
  currentTutorialKey,
} from './state.js';
import { t } from './messages.js';
import { normalizeProgress, renderProgressStrip } from './progress.js';
import { renderLogsPane } from './session-log.js';
import { refreshDiagnosticsPane } from './diagnostics.js';

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
  const testResults = panelDecl('test-results');
  const preview = panelDecl('web-preview');
  const logs = panelDecl('logs');
  const diagnostics = panelDecl('diagnostics');

  const showTutorial = Boolean(tutorial && !tutorial.hidden);
  const showTerminal = !terminal || !terminal.hidden;
  const showFileTree = Boolean(fileTree && !fileTree.hidden);
  const canShowAux = AUX_PANEL_TYPES.some(type => panelDeclared(type));
  const showAux = canShowAux && (state.auxVisible
    || (testResults && !testResults.hidden)
    || (preview && !preview.hidden)
    || (logs && !logs.hidden)
    || (diagnostics && !diagnostics.hidden));

  document.getElementById('tutorial-panel').style.display = showTutorial ? '' : 'none';
  document.getElementById('drag-v').style.display = showTutorial ? '' : 'none';
  document.getElementById('terminal-wrap').style.display = showTerminal ? '' : 'none';
  document.getElementById('drag-h').style.display = showTerminal ? '' : 'none';

  const treePanel = document.getElementById('file-tree-panel');
  const dragTree = document.getElementById('drag-v-tree');
  treePanel.classList.toggle('visible', showFileTree);
  dragTree.style.display = showFileTree ? '' : 'none';
  if (showFileTree) {
    const body = document.getElementById('file-tree-body');
    if (!body.querySelector('.file-tree-item')) panelHooks.refreshTree?.(false);
  }

  const aux = document.getElementById('aux-panel');
  const dragAux = document.getElementById('drag-v-aux');
  aux.classList.toggle('visible', showAux);
  dragAux.style.display = showAux ? '' : 'none';

  for (const type of AUX_PANEL_TYPES) {
    const tab = aux.querySelector(`[data-aux-tab="${type}"]`);
    if (tab) tab.style.display = panelDeclared(type) ? '' : 'none';
  }

  const logsBtn = document.getElementById('logs-btn');
  const diagBtn = document.getElementById('diag-btn');
  if (logsBtn) logsBtn.style.display = panelDeclared('logs') ? '' : 'none';
  if (diagBtn) diagBtn.style.display = panelDeclared('diagnostics') ? '' : 'none';

  if (showAux) {
    if (!panelDeclared(state.activeAuxTab)) {
      state.activeAuxTab = AUX_PANEL_TYPES.find(type => panelDeclared(type)) || 'test-results';
    }
    setAuxTab(state.activeAuxTab);
    if (state.activeAuxTab === 'logs') renderLogsPane();
    if (state.activeAuxTab === 'diagnostics') refreshDiagnosticsPane(currentTutorialKey());
  }
  applyProgressToUi();
}

function setAuxTab(tab) {
  state.activeAuxTab = tab;
  document.querySelectorAll('#aux-panel [data-aux-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.auxTab === tab);
  });
  document.querySelectorAll('#aux-panel .aux-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `pane-${tab}`);
  });
}

function revealAuxPanel(tab) {
  if (!AUX_PANEL_TYPES.includes(tab) || !panelDeclared(tab)) return;
  state.auxVisible = true;
  state.activeAuxTab = tab;
  applyPanelLayout();
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
        : '本机映射预览',
    });
  } else if (urlMatch) {
    let resolved = null;
    try {
      const runtime = await fetch('/api/runtime').then(r => r.ok ? r.json() : null);
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
  setAuxTab,
  revealAuxPanel,
  showTestResults,
  renderPreviewFrame,
  renderPreviewUrlFrame,
  showPreviewUrlText,
  showPreviewContent,
};
