import { apiJson, uploadArchive } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { appendSessionLog, renderLogsPane } from './session-log.js';
import { normalizeProgress, stepIndexFromId, renderProgressStrip } from './progress.js';
import { initTrustDialog, openTrustDialog, setPackageTrust } from './trust.js';
import { refreshDiagnosticsPane } from './diagnostics.js';

// ========== 全局状态 ==========
let ws = null, editor = null, term = null, fitAddon = null;
let currentTutorial = null, currentStep = 0;
let currentProgress = normalizeProgress(null);
let theme = localStorage.getItem('multilab-theme') || 'dark';

// 文件标签
let currentFiles = [];       // [{name, language, content, originalContent}]
let activeFileIndex = 0;
let fileModified = [];       // boolean[]
let _suppressModified = false; // 初始加载时不触发修改标记

// ========== 终端配色 ==========
const TERM_THEME = {
  dark: {
    background:'#1e1e1e',foreground:'#d4d4d4',cursor:'#d4d4d4',selectionBackground:'#264f78',
    black:'#000000',red:'#f48771',green:'#4ec9b0',yellow:'#dcdcaa',
    blue:'#569cd6',magenta:'#c586c0',cyan:'#4ec9b0',white:'#d4d4d4',
    brightBlack:'#808080',brightRed:'#f48771',brightGreen:'#4ec9b0',brightYellow:'#dcdcaa',
    brightBlue:'#569cd6',brightMagenta:'#c586c0',brightCyan:'#4ec9b0',brightWhite:'#ffffff',
  },
  light: {
    background:'#ffffff',foreground:'#1e1e1e',cursor:'#1e1e1e',selectionBackground:'#add6ff',
    black:'#000000',red:'#d73a49',green:'#098658',yellow:'#b58900',
    blue:'#0066b8',magenta:'#800080',cyan:'#0086a0',white:'#555555',
    brightBlack:'#666666',brightRed:'#a31515',brightGreen:'#098658',brightYellow:'#b58900',
    brightBlue:'#0066b8',brightMagenta:'#800080',brightCyan:'#0086a0',brightWhite:'#1e1e1e',
  },
};

function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute('data-theme', t);
  // 切换太阳/月亮图标
  document.getElementById('theme-btn').innerHTML = t === 'dark'
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  localStorage.setItem('multilab-theme', t);
  if (editor) editor.updateOptions({ theme: t === 'dark' ? 'vs-dark' : 'vs' });
  if (term) { term.options.theme = TERM_THEME[t]; try { term.refresh(0, term.rows - 1); } catch {} }
}
applyTheme(theme);
document.getElementById('theme-btn').onclick = () => applyTheme(theme === 'dark' ? 'light' : 'dark');

function renderTrustButton() {
  const btn = document.getElementById('trust-btn');
  const exportBtn = document.getElementById('export-save-btn');
  const reconnectBtn = document.getElementById('reconnect-btn');
  if (!currentTutorial?.package_digest) {
    btn.textContent = '未加载';
    btn.title = '当前 package trust 状态';
    btn.disabled = true;
    exportBtn.disabled = true;
    reconnectBtn.disabled = true;
    return;
  }
  const trust = currentTutorial.trust || 'untrusted';
  const isTrusted = trust === 'user-trusted';
  btn.textContent = isTrusted ? '已信任' : '未信任';
  btn.title = `${currentTutorial.trust_default ? '默认' : '用户设置'} trust: ${trust}`;
  btn.disabled = false;
  exportBtn.disabled = false;
  reconnectBtn.disabled = false;
}

function renderKernelSelect(resolution) {
  const sel = document.getElementById('kernel-select');
  if (!resolution?.selected && !resolution?.candidates?.length) {
    sel.innerHTML = '<option value="">无可用 kernel</option>';
    sel.disabled = true;
    return;
  }
  const candidates = (resolution.candidates || []).filter(k => k.compatible);
  const selectedId = resolution.selected?.id || '';
  sel.innerHTML = candidates.map(k => {
    const label = `${k.display_name || k.id}${k.recommended ? ' ★' : ''}`;
    return `<option value="${escapeAttr(k.id)}" ${k.id === selectedId ? 'selected' : ''}>${escapeAttr(label)}</option>`;
  }).join('') || '<option value="">无兼容 kernel</option>';
  sel.disabled = candidates.length === 0;
  sel.title = resolution.runtime
    ? `${resolution.selected?.id || ''} · ${resolution.runtime.network_mode || '?'} · ${resolution.runtime.sandbox_preset || '?'}`
    : '当前教程可用 kernel';
  currentTutorial._kernelResolution = resolution;
}

async function refreshKernelResolution() {
  if (!currentTutorial) {
    renderKernelSelect(null);
    return;
  }
  try {
    const res = await fetch(`/api/kernels/resolve?tutorial=${encodeURIComponent(currentTutorialKey())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const resolution = await res.json();
    renderKernelSelect(resolution);
  } catch (e) {
    console.error('[MultiLab] kernel resolve failed:', e);
    renderKernelSelect(null);
  }
}

async function selectKernelFromUi() {
  if (!currentTutorial) return;
  const sel = document.getElementById('kernel-select');
  const kernelId = sel.value;
  if (!kernelId) return;
  try {
    status('切换 kernel...');
    const result = await apiJson('/api/runtime/select', {
      tutorial: currentTutorialKey(),
      kernel_id: kernelId,
    });
    renderKernelSelect({
      selected: result.kernel,
      candidates: result.candidates,
      runtime: result.runtime,
      preferred_applied: result.preferred_applied,
    });
    reconnectWS({ reason: result.kernel.id });
    toast(result.replaced ? `已切换到 ${result.kernel.id}` : `已应用 ${result.kernel.id}`);
  } catch (e) {
    toast('切换 kernel 失败: ' + e.message, true);
    await refreshKernelResolution();
  }
}

// ========== 可拖拽分隔线 ==========
(function initDragHandles() {
  const tutorialPanel = document.getElementById('tutorial-panel');
  const workspacePanel = document.getElementById('workspace-panel');
  const workspaceMain = document.getElementById('workspace-main');
  const fileTreePanel = document.getElementById('file-tree-panel');
  const terminalWrap = document.getElementById('terminal-wrap');

  // 纵向: tutorial | workspace
  let vPanelW = parseFloat(localStorage.getItem('ml-tutorial-w')) || 42;
  function applyV() {
    tutorialPanel.style.width = vPanelW + '%';
    tutorialPanel.style.flex = 'none';
    workspacePanel.style.flex = '1 1 0%';
  }
  applyV();
  document.getElementById('drag-v').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const main = document.querySelector('main');
    const startX = e.clientX;
    const mainW = main.getBoundingClientRect().width;
    const startPct = vPanelW;
    document.getElementById('drag-v').classList.add('active');
    document.body.style.cursor = 'col-resize';
    function move(ev) {
      const dx = ev.clientX - startX;
      vPanelW = Math.max(18, Math.min(68, startPct + dx / mainW * 100));
      applyV();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.getElementById('drag-v').classList.remove('active');
      document.body.style.cursor = '';
      localStorage.setItem('ml-tutorial-w', vPanelW.toFixed(1));
      fitAddon && fitAddon.fit();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // file-tree | editor
  let treeW = parseFloat(localStorage.getItem('ml-tree-w')) || 200;
  function applyTreeW() {
    fileTreePanel.style.width = treeW + 'px';
  }
  applyTreeW();
  document.getElementById('drag-v-tree').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeW;
    document.getElementById('drag-v-tree').classList.add('active');
    document.body.style.cursor = 'col-resize';
    function move(ev) {
      treeW = Math.max(140, Math.min(360, startW + (ev.clientX - startX)));
      applyTreeW();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.getElementById('drag-v-tree').classList.remove('active');
      document.body.style.cursor = '';
      localStorage.setItem('ml-tree-w', String(Math.round(treeW)));
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // 横向: editor area | terminal
  let hEditorH = parseFloat(localStorage.getItem('ml-editor-h')) || 55;
  function applyH() {
    workspaceMain.style.flex = hEditorH + ' 1 0px';
    terminalWrap.style.flex = (100 - hEditorH) + ' 1 0px';
  }
  applyH();
  document.getElementById('drag-h').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const workspaceBox = workspacePanel.getBoundingClientRect();
    const totalH = workspaceBox.height - 5; // 减去手柄高度
    const startY = e.clientY;
    const startPct = hEditorH;
    document.getElementById('drag-h').classList.add('active');
    document.body.style.cursor = 'row-resize';
    function move(ev) {
      const dy = ev.clientY - startY;
      hEditorH = Math.max(15, Math.min(85, startPct + dy / totalH * 100));
      applyH();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.getElementById('drag-h').classList.remove('active');
      document.body.style.cursor = '';
      localStorage.setItem('ml-editor-h', hEditorH.toFixed(1));
      fitAddon && fitAddon.fit();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
})();

// ========== Monaco ==========
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.50.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  document.getElementById('loading-msg').style.display = 'none';
  editor = monaco.editor.create(document.getElementById('monaco'), {
    value: '// Loading tutorial...', language: 'c',
    theme: theme === 'dark' ? 'vs-dark' : 'vs',
    fontSize: 14, fontFamily: '"JetBrains Mono","Consolas",monospace',
    automaticLayout: true, minimap: { enabled: false },
    scrollBeyondLastLine: false, tabSize: 4,
  });
  // 编辑器内容变化 → 标记当前文件已修改
  editor.onDidChangeModelContent(() => {
    if (_suppressModified) return;
    if (currentFiles[activeFileIndex] && !fileModified[activeFileIndex]) {
      fileModified[activeFileIndex] = true;
      renderFileTabs();
    }
  });
  loadTutorialList();
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
});
document.getElementById('run-btn').onclick = runCode;
document.getElementById('interrupt-btn').onclick = () => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'interrupt' }));
};

// ========== xterm ==========
term = new Terminal({
  fontFamily: '"JetBrains Mono","Consolas",monospace',
  fontSize: 13, cursorBlink: true, theme: TERM_THEME[theme],
});
fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.loadAddon(new WebLinksAddon.WebLinksAddon());
term.open(document.getElementById('terminal'));
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());
term.onData((data) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
});

// ========== WebSocket ==========
let _wsForceClose = false;
let _wsReconnectTimer = null;

function connectWS() {
  _wsForceClose = false;
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => status('已连接');
  ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') term.write(msg.data);
    else if (msg.type === 'exit') term.write(`\r\n\x1b[90m[进程退出, code=${msg.code}]\x1b[0m\r\n`);
    else if (msg.type === 'status') status(msg.message);
    else if (msg.type === 'ready') status('终端就绪');
    else if (msg.type === 'error') {
      if (msg.code === 'runtime_replaced') {
        toast('Runtime 已切换，正在重连终端…');
        reconnectWS({ reason: 'runtime replaced' });
        return;
      }
      toast(msg.message, true);
      term.write(`\r\n\x1b[31m[错误] ${msg.message}\x1b[0m\r\n`);
    }
  };
  ws.onclose = () => {
    if (_wsForceClose) return;
    status('连接断开,3 秒后重连');
    _wsReconnectTimer = setTimeout(connectWS, 3000);
  };
}

function reconnectWS(opts = {}) {
  _wsForceClose = true;
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (ws) {
    try { ws.onclose = null; ws.close(); } catch {}
  }
  if (opts.reason) {
    term.write(`\r\n\x1b[90m[终端重连: ${opts.reason}]\x1b[0m\r\n`);
  }
  connectWS();
}
connectWS();

// ========== 教程与 Step 状态 ==========
let _stepLoadSeq = 0;
let _fileListCache = null;
let _fileListFetching = false;
let _auxVisible = false;
let _activeAuxTab = 'test-results';
const FALLBACK_PANELS = [
  { id: 'tutorial', type: 'tutorial', area: 'left' },
  { id: 'editor', type: 'editor', area: 'center' },
  { id: 'terminal', type: 'terminal', area: 'bottom' },
];

function currentStepObj() {
  return currentTutorial?.steps?.[currentStep] || null;
}

function currentTutorialKey() {
  return currentTutorial?.source_key || currentTutorial?.id;
}

function stepCommand(step, type) {
  return (step?.commands || []).find(cmd => (cmd.type === type || cmd.id === type) && cmd.available !== false) || null;
}

function getPanelDecls() {
  if (Array.isArray(currentTutorial?.ui_panels?.panels) && currentTutorial.ui_panels.panels.length) {
    return currentTutorial.ui_panels.panels;
  }
  const panels = currentTutorial?.default_panels;
  return Array.isArray(panels) && panels.length ? panels : FALLBACK_PANELS;
}

function panelDecl(type) {
  return getPanelDecls().find(panel => panel.type === type) || null;
}

function panelDeclared(type) {
  return Boolean(panelDecl(type));
}

const AUX_PANEL_TYPES = ['test-results', 'web-preview', 'logs', 'diagnostics'];

function applyProgressToUi() {
  renderProgressStrip(currentTutorial, currentProgress, {
    currentStepIndex: currentStep,
    onSelectStep: (index) => {
      if (index !== currentStep) enterStep(index);
    },
  });
}

function applyProgress(progress) {
  if (!progress) return;
  currentProgress = normalizeProgress(progress);
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
  const showAux = canShowAux && (_auxVisible
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
    if (!body.querySelector('.file-tree-item')) refreshFileTree();
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
    if (!panelDeclared(_activeAuxTab)) {
      _activeAuxTab = AUX_PANEL_TYPES.find(type => panelDeclared(type)) || 'test-results';
    }
    setAuxTab(_activeAuxTab);
    if (_activeAuxTab === 'logs') renderLogsPane();
    if (_activeAuxTab === 'diagnostics') refreshDiagnosticsPane(currentTutorialKey());
  }
  applyProgressToUi();
}

function setAuxTab(tab) {
  _activeAuxTab = tab;
  document.querySelectorAll('#aux-panel [data-aux-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.auxTab === tab);
  });
  document.querySelectorAll('#aux-panel .aux-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === `pane-${tab}`);
  });
}

function revealAuxPanel(tab) {
  if (!AUX_PANEL_TYPES.includes(tab) || !panelDeclared(tab)) return;
  _auxVisible = true;
  _activeAuxTab = tab;
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
  pane.querySelector('.test-result-output').textContent = output || '(no output)';
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
  note.textContent = 'Preview URL 尚未映射到本机端口。请使用带 publish_ports 的网络 kernel（如 gcc-ubuntu24-docker-net），并声明 security.network_required 或 security.preview_ports。';
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
        ? `容器宣告 ${result.preview_advertised_url} → 本机映射`
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
    if (resolved) renderPreviewUrlFrame(pane, resolved, { note: `容器宣告 ${urlMatch[1]} → 本机映射` });
    else showPreviewUrlText(pane, urlMatch[1], output);
  } else if (/<[a-z][\s\S]*>/i.test(output)) {
    renderPreviewFrame(pane, output);
  } else {
    pane.innerHTML = '';
    const pre = document.createElement('div');
    pre.className = 'preview-output';
    pre.textContent = output || '(empty preview output)';
    pane.appendChild(pre);
  }
  if (panelDeclared('web-preview')) revealAuxPanel('web-preview');
}

function langForName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const langMap = { c:'c', h:'c', cpp:'cpp', cc:'cpp', hpp:'cpp', py:'python', js:'javascript', ts:'typescript', sh:'shell', bash:'shell', go:'go', rs:'rust' };
  return langMap[ext] || currentTutorial?.language || 'plaintext';
}

function syncActiveEditor() {
  if (editor && currentFiles[activeFileIndex]) {
    currentFiles[activeFileIndex].content = editor.getValue();
  }
}

function setEditorEmpty(message = '// No files for this step\n') {
  if (!editor) return;
  _suppressModified = true;
  editor.setValue(message);
  monaco.editor.setModelLanguage(editor.getModel(), currentTutorial?.language || 'plaintext');
  _suppressModified = false;
}

function loadFilesIntoEditor(files) {
  currentFiles = (files || []).map(f => ({
    name: f.name,
    language: f.language || langForName(f.name),
    content: f.content || '',
    originalContent: f.content || '',
  }));
  fileModified = currentFiles.map(() => false);
  activeFileIndex = currentFiles.length > 0 ? 0 : -1;
  renderFileTabs();
  if (currentFiles.length > 0) {
    switchFile(0, true);
  } else {
    setEditorEmpty();
  }
  _fileListCache = null;
  if (panelDeclared('file-tree')) refreshFileTree(true);
}

function renderTutorialStepText() {
  const step = currentStepObj();
  if (!currentTutorial || !step) {
    document.getElementById('tutorial-content').innerHTML = '<p style="color:var(--text-dim)">未加载教程或步骤为空</p>';
    return;
  }
  document.getElementById('tutorial-content').innerHTML = DOMPurify.sanitize(marked.parse(step.instructions || ''));
  document.getElementById('step-info').textContent =
    `步骤 ${currentStep + 1} / ${currentTutorial.steps.length} — ${step.title || ''}`;
  document.getElementById('prev-step').disabled = currentStep === 0;
  document.getElementById('next-step').disabled = currentStep === currentTutorial.steps.length - 1;
  document.getElementById('test-btn').style.display = stepCommand(step, 'test') ? '' : 'none';
  document.getElementById('preview-btn').style.display = stepCommand(step, 'preview') ? '' : 'none';
}

async function loadTutorialList(opts = {}) {
  try {
    const res = await fetch('/api/tutorials');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { tutorials, expectedDir } = await res.json();
    const sel = document.getElementById('tutorial-select');
    if (tutorials.length === 0) {
      sel.innerHTML = '<option value="">未找到教程</option>';
      document.getElementById('tutorial-content').innerHTML =
        `<div style="padding:32px;color:var(--text-dim)">
          <h2 style="color:var(--warn);margin-bottom:12px">未找到教程</h2>
          <p>TUTORIALS_DIR 环境变量指向的目录中无可用教程。</p>
          <p style="margin-top:8px">搜索路径: <code>${escapeAttr(expectedDir || '(未知)')}</code></p>
          <p style="margin-top:12px">请确认:</p>
          <ol><li>教程目录存在且包含 multilab.json</li><li>.env 中 TUTORIALS_DIR 指向正确</li></ol>
        </div>`;
      document.getElementById('loading-msg').style.display = 'none';
      return;
    }
    sel.innerHTML = tutorials.map(t => {
      const sourceKey = t.source_key || t.id;
      const sourceLabel = t.source_type === 'installed' ? 'imported' : 'dev';
      return `<option value="${escapeAttr(sourceKey)}">${escapeAttr(t.title)} (${escapeAttr(t.language)}, ${t.steps} 步, ${sourceLabel})</option>`;
    }
    ).join('');
    sel.onchange = () => loadTutorial(sel.value);
    const selected = tutorials.find(t => {
      const sourceKey = t.source_key || t.id;
      if (opts.preferredKey && sourceKey === opts.preferredKey) return true;
      if (opts.preferredDigest && t.package_digest === opts.preferredDigest) {
        return !opts.preferredSourceType || t.source_type === opts.preferredSourceType;
      }
      return false;
    }) || tutorials[0];
    const selectedKey = selected.source_key || selected.id;
    sel.value = selectedKey;
    loadTutorial(selectedKey);
  } catch (e) {
    console.error('[MultiLab] 加载教程列表失败:', e);
    document.getElementById('tutorial-content').innerHTML =
      `<p style="color:var(--error)">加载教程列表失败: ${escapeAttr(e.message)}</p>
       <p style="color:var(--text-dim);margin-top:8px">请确认后端服务运行在 <code>http://localhost:${location.port || 3000}</code></p>`;
  }
}

function pickLocalFile(inputId) {
  const input = document.getElementById(inputId);
  input.value = '';
  input.click();
}

async function openPackageFromFile(file) {
  if (!file) return;
  if (!/\.mlab$/i.test(file.name)) {
    toast('请选择 .mlab 文件', true);
    return;
  }
  try {
    status('打开 .mlab...');
    const record = await uploadArchive('/api/packages/upload', file);
    await loadTutorialList({ preferredDigest: record.digest, preferredSourceType: 'installed' });
    toast('已打开 .mlab');
  } catch (e) {
    toast('打开失败: ' + e.message, true);
  }
}

function shortDigest(digest) {
  const hex = String(digest || '').replace(/^sha256:/, '');
  return hex.length > 16 ? `${hex.slice(0, 12)}…${hex.slice(-8)}` : hex;
}

function openLibraryPanel() {
  document.getElementById('library-overlay').style.display = 'block';
  loadLibraryList();
}

function closeLibraryPanel() {
  document.getElementById('library-overlay').style.display = 'none';
}

async function loadLibraryList() {
  const list = document.getElementById('library-list');
  list.innerHTML = '<div class="library-empty">加载中...</div>';
  try {
    const res = await fetch('/api/packages');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { packages } = await res.json();
    if (!packages?.length) {
      list.innerHTML = '<div class="library-empty">还没有导入的 .mlab 包。可用“打开 .mlab”导入。</div>';
      return;
    }
    list.innerHTML = packages.map((pkg, idx) => `
      <div class="library-item" data-idx="${idx}">
        <div class="library-item-head">
          <div>
            <div class="library-title">${escapeAttr(pkg.id)}@${escapeAttr(pkg.version || '0.0.0')}</div>
            <div class="library-meta">
              digest: ${escapeAttr(shortDigest(pkg.digest))}<br>
              source: ${escapeAttr(pkg.source || '—')}<br>
              imported: ${escapeAttr(pkg.imported_at || '—')}
              ${pkg.files != null ? `<br>files: ${escapeAttr(String(pkg.files))}` : ''}
            </div>
          </div>
          <div class="library-actions">
            <button data-action="open" data-idx="${idx}">打开</button>
            <button class="danger" data-action="delete" data-idx="${idx}">删除</button>
          </div>
        </div>
      </div>
    `).join('');
    list._packages = packages;
  } catch (e) {
    list.innerHTML = `<div class="library-empty">加载失败: ${escapeAttr(e.message)}</div>`;
  }
}

async function openLibraryPackage(pkg) {
  closeLibraryPanel();
  const preferredKey = pkg.source_key;
  await loadTutorialList({
    preferredKey,
    preferredDigest: pkg.digest,
    preferredSourceType: 'installed',
  });
  toast(`已打开 ${pkg.id}@${pkg.version}`);
}

async function deleteLibraryPackage(pkg) {
  if (!confirm(`删除已导入包 ${pkg.id}@${pkg.version}？\n这不会删除学习进度 save。`)) return;
  try {
    const params = new URLSearchParams({
      id: pkg.id,
      version: pkg.version || '0.0.0',
      digest: pkg.digest,
    });
    const res = await fetch(`/api/packages/item?${params}`, { method: 'DELETE' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);

    const currentKey = currentTutorial?.source_key || currentTutorial?.id;
    if (currentKey && (currentKey === pkg.source_key || currentTutorial?.package_digest === pkg.digest)) {
      currentTutorial = null;
    }
    await loadLibraryList();
    await loadTutorialList({});
    toast('已删除教程包');
  } catch (e) {
    toast('删除失败: ' + e.message, true);
  }
}

async function exportSaveDownload() {
  if (!currentTutorial) return;
  const tutorialKey = currentTutorial.source_key || currentTutorial.id;
  try {
    await saveCurrentStep({ silent: true });
    status('导出进度...');
    const res = await fetch('/api/saves/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tutorial: tutorialKey }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `${currentTutorial.package_id || 'tutorial'}.mlab-save`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('已下载进度包');
  } catch (e) {
    toast('导出进度失败: ' + e.message, true);
  }
}

async function importSaveFromFile(file) {
  if (!file) return;
  if (!/\.mlab-save$/i.test(file.name)) {
    toast('请选择 .mlab-save 文件', true);
    return;
  }
  try {
    status('导入进度...');
    const result = await uploadArchive('/api/saves/upload', file);
    applyProgress(result.progress);
    await loadTutorialList({ preferredKey: result.source_key });
    appendSessionLog('已导入进度包');
    toast('已导入进度');
  } catch (e) {
    if (e.code === 'package_missing' || /matching package not found/.test(e.message || '')) {
      toast('缺少对应教程包，请先打开原 .mlab: ' + e.message, true);
      return;
    }
    toast('导入进度失败: ' + e.message, true);
  }
}

async function loadTutorial(id) {
  try {
    if (currentTutorial) await saveCurrentStep({ silent: true });
    const res = await fetch(`/api/tutorials/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    currentTutorial = await res.json();
    if (!currentTutorial || !currentTutorial.steps?.length) throw new Error('无效的教程数据');
    currentProgress = normalizeProgress(null);
    _auxVisible = false;
    applyPanelLayout();
    renderTrustButton();
    await refreshKernelResolution();
    appendSessionLog(`打开教程 ${currentTutorial.id || id}`);
    // Probe step 0 load for progress, then jump to saved current_step when present.
    currentStep = 0;
    await enterStep(0, { skipSave: true, resumeProgress: true });
  } catch (e) {
    console.error(`[MultiLab] 加载教程 ${id} 失败:`, e);
    appendSessionLog(`加载教程失败: ${e.message}`, 'error');
    document.getElementById('tutorial-content').innerHTML =
      `<p style="color:var(--error)">加载教程失败: ${escapeAttr(e.message)}</p>
       <p style="color:var(--text-dim);margin-top:8px">按 F12 打开开发者工具查看详细错误</p>`;
  }
}

async function enterStep(targetIndex, opts = {}) {
  if (!currentTutorial || !currentTutorial.steps?.[targetIndex]) return;
  const seq = ++_stepLoadSeq;
  try {
    document.getElementById('prev-step').disabled = true;
    document.getElementById('next-step').disabled = true;
    if (!opts.skipSave) await saveCurrentStep({ silent: true });
    currentStep = targetIndex;
    renderTutorialStepText();
    applyProgressToUi();
    status('加载 step...');
    const step = currentStepObj();
    const result = await apiJson('/api/steps/load', { tutorial: currentTutorialKey(), step: step.id });
    if (seq !== _stepLoadSeq) return;
    applyProgress(result.progress);
    if (opts.resumeProgress && result.progress?.current_step) {
      const resumeIdx = stepIndexFromId(currentTutorial, result.progress.current_step);
      if (resumeIdx > 0) {
        await enterStep(resumeIdx, { skipSave: true });
        return;
      }
    }
    loadFilesIntoEditor(result.files || []);
    renderTutorialStepText();
    applyProgressToUi();
    appendSessionLog(`进入 step ${step.id}`);
    status(result.sourceStep && result.sourceStep !== step.id ? `继承 ${result.sourceStep} 的保存` : 'step 已加载');
  } catch (e) {
    toast('切换 step 失败: ' + e.message, true);
    appendSessionLog(`切换 step 失败: ${e.message}`, 'error');
    renderTutorialStepText();
  }
}

// ========== 文件标签栏 ==========
function renderFileTabs() {
  const container = document.getElementById('file-tabs');
  const openBtn = document.getElementById('tab-open-btn');
  container.innerHTML = '';
  currentFiles.forEach((f, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (i === activeFileIndex ? ' active' : '');
    const name = document.createElement('span');
    name.textContent = f.name || 'untitled';
    tab.appendChild(name);
    if (fileModified[i]) {
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
  if (idx < 0 || idx >= currentFiles.length) return;
  syncActiveEditor();
  currentFiles.splice(idx, 1);
  fileModified.splice(idx, 1);
  if (currentFiles.length === 0) {
    activeFileIndex = -1;
    renderFileTabs();
    setEditorEmpty();
    return;
  }
  if (activeFileIndex > idx) activeFileIndex--;
  activeFileIndex = Math.min(activeFileIndex, currentFiles.length - 1);
  const newIdx = activeFileIndex;
  activeFileIndex = -1;
  switchFile(newIdx, true);
}

function createNewFile() {
  syncActiveEditor();
  const name = prompt('文件名 (含后缀,如 hello.c)', 'new.c');
  if (!name || !name.trim()) return;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    toast('文件名不能包含路径', true);
    return;
  }
  const language = langForName(name.trim());
  currentFiles.push({
    name: name.trim(),
    language,
    content: language === 'c' ? '#include <stdio.h>\n\nint main(void) {\n    \n    return 0;\n}\n'
      : language === 'python' ? 'print("hello")\n'
      : '',
    originalContent: '',
  });
  fileModified.push(true);
  activeFileIndex = currentFiles.length - 1;
  renderFileTabs();
  switchFile(activeFileIndex, true);
}

// ========== 保存 / Reset / 打开容器文件 ==========
async function saveCurrentStep(opts = {}) {
  const step = currentStepObj();
  if (!currentTutorial || !step) return;
  syncActiveEditor();
  const hasDirty = fileModified.some(Boolean);
  if (!hasDirty && !opts.force) return;
  const result = await apiJson('/api/steps/save', {
    tutorial: currentTutorialKey(),
    step: step.id,
    files: currentFiles.map(f => ({ name: f.name, content: f.content })),
  });
  currentFiles.forEach(f => { f.originalContent = f.content; });
  fileModified = currentFiles.map(() => false);
  renderFileTabs();
  applyProgress(result.progress);
  if (!opts.silent) toast('已保存当前 step');
}

async function saveFile() {
  try {
    await saveCurrentStep({ force: true });
  } catch (e) {
    toast('保存失败: ' + e.message, true);
  }
}

async function resetCurrentStep() {
  const step = currentStepObj();
  if (!currentTutorial || !step) return;
  if (!confirm(`重置当前 step "${step.title || step.id}"？当前 step 的保存会恢复为教程初始状态。`)) return;
  try {
    const result = await apiJson('/api/steps/reset', { tutorial: currentTutorialKey(), step: step.id });
    loadFilesIntoEditor(result.files || []);
    applyProgress(result.progress);
    appendSessionLog(`已重置 step ${step.id}`, 'warn');
    toast('已重置当前 step');
  } catch (e) {
    toast('重置失败: ' + e.message, true);
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
    const existing = currentFiles.findIndex(f => f.name === name || f.path === filename);
    if (existing >= 0) {
      currentFiles[existing].content = content;
      currentFiles[existing].originalContent = content;
      currentFiles[existing].path = filename;
      fileModified[existing] = false;
      activeFileIndex = existing;
    } else {
      currentFiles.push({
        name,
        path: filename,
        language: langForName(name),
        content,
        originalContent: content,
      });
      fileModified.push(false);
      activeFileIndex = currentFiles.length - 1;
    }
    renderFileTabs();
    switchFile(activeFileIndex, true);
    closeFilePicker();
    highlightFileTreePath(filename);
  } catch (e) { toast('打开文件失败: ' + e.message, true); }
}

let _fileTreeFetching = false;
let _fileTreeActivePath = null;

function highlightFileTreePath(filePath) {
  _fileTreeActivePath = filePath || null;
  document.querySelectorAll('#file-tree-body .file-tree-item.file').forEach(el => {
    el.classList.toggle('active', el.dataset.path === _fileTreeActivePath);
  });
}

function renderFileTree(entries) {
  const body = document.getElementById('file-tree-body');
  body.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'file-tree-empty';
    empty.textContent = '工作区为空';
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
      if (entry.path === _fileTreeActivePath) item.classList.add('active');
      item.addEventListener('click', () => openFileFromContainer(entry.path));
    }
    body.appendChild(item);
  });
}

async function refreshFileTree(force = false) {
  if (!panelDeclared('file-tree')) return;
  const body = document.getElementById('file-tree-body');
  if (_fileTreeFetching && !force) return;
  _fileTreeFetching = true;
  if (!body.querySelector('.file-tree-item')) {
    body.innerHTML = '<div class="file-tree-empty">加载中...</div>';
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
    _fileTreeFetching = false;
  }
}

async function fetchFileList() {
  const res = await fetch('/api/fs/ls?path=/home/student/workspace');
  if (!res.ok) throw new Error('读取目录失败');
  const { files } = await res.json();
  _fileListCache = files;
  return files;
}

function renderFileList(files) {
  const list = document.getElementById('file-picker-list');
  list.innerHTML = '';
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = '工作区为空';
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
  if (_fileListCache && !force) {
    renderFileList(_fileListCache);
    if (!_fileListFetching) {
      _fileListFetching = true;
      fetchFileList().then(files => renderFileList(files)).catch(() => {}).finally(() => { _fileListFetching = false; });
    }
    return;
  }
  if (!_fileListCache) list.innerHTML = '<div class="file-empty">加载中...</div>';
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

document.getElementById('file-picker-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeFilePicker();
});
document.getElementById('picker-refresh-btn').addEventListener('click', () => loadFilePickerList(true));
document.getElementById('tab-open-btn').addEventListener('click', openFilePicker);
document.getElementById('kernel-select').addEventListener('change', selectKernelFromUi);
document.getElementById('reconnect-btn').addEventListener('click', () => {
  reconnectWS({ reason: 'manual' });
  toast('正在重连终端');
});
document.getElementById('library-btn').addEventListener('click', openLibraryPanel);
document.getElementById('library-refresh-btn').addEventListener('click', loadLibraryList);
document.getElementById('library-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeLibraryPanel();
});
document.getElementById('library-list').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const packages = document.getElementById('library-list')._packages || [];
  const pkg = packages[Number(btn.dataset.idx)];
  if (!pkg) return;
  if (btn.dataset.action === 'open') openLibraryPackage(pkg);
  if (btn.dataset.action === 'delete') deleteLibraryPackage(pkg);
});
document.getElementById('import-package-btn').addEventListener('click', () => pickLocalFile('import-package-file'));
document.getElementById('import-package-file').addEventListener('change', (e) => openPackageFromFile(e.target.files?.[0]));
document.getElementById('export-save-btn').addEventListener('click', exportSaveDownload);
document.getElementById('import-save-btn').addEventListener('click', () => pickLocalFile('import-save-file'));
document.getElementById('import-save-file').addEventListener('change', (e) => importSaveFromFile(e.target.files?.[0]));
document.getElementById('trust-btn').addEventListener('click', () => openTrustDialog(currentTutorial));
document.getElementById('logs-btn').addEventListener('click', () => {
  revealAuxPanel('logs');
  renderLogsPane();
});
document.getElementById('diag-btn').addEventListener('click', () => {
  revealAuxPanel('diagnostics');
  refreshDiagnosticsPane(currentTutorialKey());
});
document.getElementById('save-btn').addEventListener('click', saveFile);
document.getElementById('revert-btn').addEventListener('click', resetCurrentStep);
document.getElementById('test-btn').addEventListener('click', runTest);
document.getElementById('export-btn').addEventListener('click', () => {
  window.open('/api/workspace/export', '_blank');
  toast('导出中...');
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
});

function switchFile(idx, force = false) {
  if (idx < 0 || idx >= currentFiles.length) return;
  if (!force && idx === activeFileIndex) return;
  if (!force) syncActiveEditor();
  activeFileIndex = idx;
  const f = currentFiles[idx];
  if (editor) {
    _suppressModified = true;
    editor.setValue(f.content);
    monaco.editor.setModelLanguage(editor.getModel(), f.language || currentTutorial?.language || 'c');
    _suppressModified = false;
  }
  renderFileTabs();
}

document.getElementById('prev-step').onclick = () => {
  if (currentStep > 0) enterStep(currentStep - 1);
};
document.getElementById('next-step').onclick = () => {
  if (currentTutorial && currentStep < currentTutorial.steps.length - 1) enterStep(currentStep + 1);
};

async function runCode() {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('WebSocket 未连接', true); return; }
  if (!currentTutorial) return;
  try {
    await saveCurrentStep({ silent: true });
  } catch (e) {
    toast('运行前保存失败: ' + e.message, true);
    return;
  }
  const step = currentStepObj();
  const command = stepCommand(step, 'run');
  if (!command) {
    toast('当前 step 没有可运行的 command', true);
    return;
  }
  ws.send(JSON.stringify({
    type: 'command',
    tutorial: currentTutorialKey(),
    step: step.id,
    command: command.id || command.type,
  }));
}

async function runTest() {
  const step = currentStepObj();
  const command = stepCommand(step, 'test');
  if (!currentTutorial || !command) return;
  try {
    await saveCurrentStep({ silent: true });
    const res = await apiJson('/api/commands/run', {
      tutorial: currentTutorialKey(),
      step: step.id,
      command: command.id || command.type,
    });
    const color = res.passed ? '\x1b[32m' : '\x1b[31m';
    term.write(`\r\n${color}[${res.passed ? 'PASS' : 'FAIL'}]\x1b[0m\r\n${res.output || ''}\r\n`);
    applyProgress(res.progress);
    showTestResults(res);
    appendSessionLog(res.passed ? `检查通过 (${step.id})` : `检查未通过 (${step.id})`, res.passed ? 'info' : 'warn');
    toast(res.passed ? '检查通过' : '检查未通过', !res.passed);
  } catch (e) {
    toast('检查失败: ' + e.message, true);
  }
}

async function runPreview() {
  const step = currentStepObj();
  const command = stepCommand(step, 'preview');
  if (!currentTutorial || !command) return;
  try {
    await saveCurrentStep({ silent: true });
    if (command.terminal === 'interactive') {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        toast('WebSocket 未连接', true);
        return;
      }
      ws.send(JSON.stringify({
        type: 'command',
        tutorial: currentTutorialKey(),
        step: step.id,
        command: command.id || command.type,
      }));
      if (panelDeclared('web-preview')) {
        document.getElementById('pane-web-preview').innerHTML =
          '<div class="aux-empty">已在终端启动预览命令。若脚本输出 MULTILAB_PREVIEW_HTML / MULTILAB_PREVIEW_URL，请改用 captured preview。</div>';
        revealAuxPanel('web-preview');
      }
      toast('已启动预览命令');
      return;
    }
    status('预览中...');
    const res = await apiJson('/api/commands/run', {
      tutorial: currentTutorialKey(),
      step: step.id,
      command: command.id || command.type,
    });
    showPreviewContent(res);
    toast(res.passed === false ? '预览命令失败' : '预览已更新', res.passed === false);
  } catch (e) {
    toast('预览失败: ' + e.message, true);
  }
}

document.getElementById('preview-btn').addEventListener('click', runPreview);
document.getElementById('file-tree-refresh-btn').addEventListener('click', () => refreshFileTree(true));
document.getElementById('aux-close-btn').addEventListener('click', () => {
  _auxVisible = false;
  applyPanelLayout();
});
document.querySelectorAll('#aux-panel [data-aux-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    setAuxTab(btn.dataset.auxTab);
    _auxVisible = true;
    applyPanelLayout();
  });
});

initTrustDialog({
  async onChanged(nextTrust) {
    if (!currentTutorial?.package_digest) return;
    const result = await setPackageTrust(currentTutorial.package_digest, nextTrust);
    currentTutorial.trust = result.trust;
    currentTutorial.trust_default = result.default;
    renderTrustButton();
    appendSessionLog(result.trust === 'user-trusted' ? '已确认信任当前包' : '已取消信任当前包', 'warn');
    toast(result.trust === 'user-trusted' ? '已标记为信任' : '已标记为未信任');
    if (panelDeclared('diagnostics')) refreshDiagnosticsPane(currentTutorialKey());
  },
});

renderLogsPane();

