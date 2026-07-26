import { state, currentTutorialKey } from './state.js';
import { t } from './messages.js';
import { toast } from './ui.js';
import { initTheme } from './theme.js';
import { renderTrustButton, selectKernelFromUi } from './kernel.js';
import './layout.js';
import { reconnectWS } from './terminal.js';
import {
  applyPanelLayout,
  setAuxTab,
  revealAuxPanel,
  setPanelHooks,
  panelDeclared,
} from './panels.js';
import {
  loadTutorialList,
  enterStep,
  openLibraryPanel,
  closeLibraryPanel,
  loadLibraryList,
  openLibraryPackage,
  deleteLibraryPackage,
  pickLocalFile,
  openPackageFromFile,
  exportSaveDownload,
  importSaveFromFile,
} from './tutorial.js';
import {
  saveFile,
  resetCurrentStep,
  refreshFileTree,
  loadFilePickerList,
  openFilePicker,
  closeFilePicker,
  renderFileTabs,
  syncEditorToCurrentFile,
} from './files.js';
import { runCode, runTest, runPreview } from './commands.js';
import { initTrustDialog, openTrustDialog, closeTrustDialog, setPackageTrust } from './trust.js';
import { appendSessionLog, renderLogsPane } from './session-log.js';
import { refreshDiagnosticsPane } from './diagnostics.js';

initTheme();

setPanelHooks({
  selectStep: (index) => enterStep(index),
  refreshTree: (force) => refreshFileTree(force),
});

// 教程列表不依赖 Monaco: 编辑器加载失败/超时也要能阅读教程。
let tutorialsLoaded = false;
function ensureTutorialsLoaded() {
  if (tutorialsLoaded) return;
  tutorialsLoaded = true;
  loadTutorialList();
}
ensureTutorialsLoaded();

function hideLoadingMsg(text) {
  const el = document.getElementById('loading-msg');
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.style.color = 'var(--warn)';
    return;
  }
  el.style.display = 'none';
}

function bootEditor() {
  if (typeof require !== 'function' || typeof require.config !== 'function') {
    hideLoadingMsg(t('boot.monacoMissing'));
    return;
  }
  require.config({ paths: { vs: '/vendor/monaco-editor/min/vs' } });
  const timer = setTimeout(() => {
    if (state.editor) return;
    hideLoadingMsg(t('boot.monacoTimeout'));
  }, 15000);
  require(['vs/editor/editor.main'], () => {
    clearTimeout(timer);
    hideLoadingMsg();
    state.editor = monaco.editor.create(document.getElementById('monaco'), {
      value: t('files.loadingEditor'),
      language: 'c',
      theme: state.theme === 'dark' ? 'vs-dark' : 'vs',
      fontSize: 14,
      fontFamily: '"JetBrains Mono","Consolas",monospace',
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 4,
    });
    state.editor.onDidChangeModelContent(() => {
      if (state.suppressModified) return;
      if (state.currentFiles[state.activeFileIndex] && !state.fileModified[state.activeFileIndex]) {
        state.fileModified[state.activeFileIndex] = true;
        renderFileTabs();
      }
    });
    // 若 step 文件先于编辑器就绪,这里把当前文件回填进编辑器。
    syncEditorToCurrentFile();
  }, (err) => {
    clearTimeout(timer);
    console.error('[MultiLab] Monaco load failed:', err);
    hideLoadingMsg(t('boot.monacoFailed'));
  });
}
bootEditor();

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runCode(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  // Escape 关闭任意打开的浮层 (文件选择器 / 教程库 / 信任对话框)
  if (e.key === 'Escape') {
    const pick = document.getElementById('file-picker-overlay');
    const lib = document.getElementById('library-overlay');
    const trust = document.getElementById('trust-overlay');
    if (pick?.style.display === 'block') { closeFilePicker(); e.preventDefault(); }
    else if (lib?.style.display === 'block') { closeLibraryPanel(); e.preventDefault(); }
    else if (trust?.style.display === 'block') { closeTrustDialog(); e.preventDefault(); }
  }
});
document.getElementById('run-btn').onclick = runCode;
document.getElementById('interrupt-btn').onclick = () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'interrupt' }));
  }
};

document.getElementById('file-picker-overlay').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeFilePicker();
});
document.getElementById('file-picker-close-btn').addEventListener('click', closeFilePicker);
document.getElementById('picker-refresh-btn').addEventListener('click', () => loadFilePickerList(true));
document.getElementById('tab-open-btn').addEventListener('click', openFilePicker);
document.getElementById('kernel-select').addEventListener('change', selectKernelFromUi);
document.getElementById('reconnect-btn').addEventListener('click', () => {
  reconnectWS({ reason: 'manual' });
  toast(t('ws.reconnecting'));
});
document.getElementById('library-btn').addEventListener('click', openLibraryPanel);
document.getElementById('library-refresh-btn').addEventListener('click', loadLibraryList);
document.getElementById('library-close-btn').addEventListener('click', closeLibraryPanel);
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
document.getElementById('trust-btn').addEventListener('click', () => openTrustDialog(state.currentTutorial));
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
  toast(t('save.workspaceExporting'));
});
document.getElementById('prev-step').onclick = () => {
  if (state.currentStep > 0) enterStep(state.currentStep - 1);
};
document.getElementById('next-step').onclick = () => {
  if (state.currentTutorial && state.currentStep < state.currentTutorial.steps.length - 1) {
    enterStep(state.currentStep + 1);
  }
};
document.getElementById('preview-btn').addEventListener('click', runPreview);
document.getElementById('file-tree-refresh-btn').addEventListener('click', () => refreshFileTree(true));
document.getElementById('aux-close-btn').addEventListener('click', () => {
  state.auxVisible = false;
  applyPanelLayout();
});
document.querySelectorAll('#aux-panel [data-aux-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    setAuxTab(btn.dataset.auxTab);
    state.auxVisible = true;
    applyPanelLayout();
  });
});

initTrustDialog({
  async onChanged(nextTrust) {
    if (!state.currentTutorial?.package_digest) return;
    const result = await setPackageTrust(state.currentTutorial.package_digest, nextTrust);
    state.currentTutorial.trust = result.trust;
    state.currentTutorial.trust_default = result.default;
    renderTrustButton();
    appendSessionLog(result.trust === 'user-trusted' ? t('trust.logGranted') : t('trust.logRevoked'), 'warn');
    toast(result.trust === 'user-trusted' ? t('trust.markedTrusted') : t('trust.markedUntrusted'));
    if (panelDeclared('diagnostics')) refreshDiagnosticsPane(currentTutorialKey());
  },
});

renderLogsPane();
