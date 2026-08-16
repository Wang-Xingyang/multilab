import { state, currentTutorialKey } from './state.js';
import { t, applyStaticCopy } from './messages.js';
import { toast } from './ui.js';
import { initTheme } from './theme.js';
import { renderTrustButton } from './kernel.js';
import { initLayout } from './layout.js';
import { initTerminal, initWS, reconnectWS, setFileTreeChangeCallback } from './terminal.js';
import {
  setPanelHooks,
  toggleFileTree,
  toggleTutorialCollapsed,
  applyPanelLayout,
} from './panels.js';
import { initHostDrawer, closeHostDrawer, toggleHostDrawer } from './host-drawer.js';
import {
  loadTutorialList,
  enterStep,
  initTutorialPicker,
  closeTutorialPicker,
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
  closeFilePicker,
  renderFileTabs,
  syncEditorToCurrentFile,
} from './files.js';
import { runCode, runTest, runPreview } from './commands.js';
import { initTrustDialog, openTrustDialog, closeTrustDialog, setPackageTrust } from './trust.js';
import { appendSessionLog, renderLogsPane } from './session-log.js';
import { refreshDiagnosticsPane } from './diagnostics.js';

initTheme();
initLayout();
initHostDrawer();
initTutorialPicker();
applyPanelLayout();
initTerminal();
initWS();

// 文件树自动刷新:
// 1. host 推送 fs_change (真实文件变化, ~1s) → 即时刷新
// 2. 页面从后台切回时刷新一次 (兜底)
setFileTreeChangeCallback(() => refreshFileTree(false));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshFileTree(false);
});

// 顶栏下拉菜单: 点击 trigger 切换, 选中项/外部点击关闭
function setupMenu(menuEl) {
  const trigger = menuEl.querySelector('.menu-trigger');
  if (!trigger) return;
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.open').forEach(m => { if (m !== menuEl) m.classList.remove('open'); });
    closeTutorialPicker();
    menuEl.classList.toggle('open');
  });
  menuEl.querySelectorAll('.menu-pop button').forEach(btn => {
    btn.addEventListener('click', () => menuEl.classList.remove('open'));
  });
}
document.querySelectorAll('.menu').forEach(setupMenu);
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
});

applyStaticCopy();

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
  // Escape 关闭任意打开的浮层 (文件选择器 / 教程目录 / 信任对话框 / 抽屉)
  if (e.key === 'Escape') {
    const pick = document.getElementById('file-picker-overlay');
    const trust = document.getElementById('trust-overlay');
    const drawer = document.getElementById('host-drawer');
    if (pick?.style.display === 'block') { closeFilePicker(); e.preventDefault(); }
    else if (document.getElementById('tutorial-picker')?.classList.contains('open')) { closeTutorialPicker(); e.preventDefault(); }
    else if (trust?.style.display === 'block') { closeTrustDialog(); e.preventDefault(); }
    else if (drawer?.classList.contains('open')) { closeHostDrawer(); e.preventDefault(); }
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
document.getElementById('reconnect-btn').addEventListener('click', () => {
  reconnectWS({ reason: 'manual' });
  toast(t('ws.reconnecting'));
});
document.getElementById('import-package-btn').addEventListener('click', () => pickLocalFile('import-package-file'));
document.getElementById('import-package-file').addEventListener('change', (e) => openPackageFromFile(e.target.files?.[0]));
document.getElementById('export-save-btn').addEventListener('click', exportSaveDownload);
document.getElementById('import-save-btn').addEventListener('click', () => pickLocalFile('import-save-file'));
document.getElementById('import-save-file').addEventListener('change', (e) => importSaveFromFile(e.target.files?.[0]));
document.getElementById('trust-btn').addEventListener('click', () => openTrustDialog(state.currentTutorial));
document.getElementById('diag-btn').addEventListener('click', () => {
  toggleHostDrawer();
});
document.getElementById('revert-btn').addEventListener('click', resetCurrentStep);
document.getElementById('test-btn').addEventListener('click', runTest);
document.getElementById('toggle-tutorial-btn').addEventListener('click', toggleTutorialCollapsed);
document.getElementById('prev-step').onclick = () => {
  if (state.currentStep > 0) enterStep(state.currentStep - 1);
};
document.getElementById('next-step').onclick = () => {
  if (state.currentTutorial && state.currentStep < state.currentTutorial.steps.length - 1) {
    enterStep(state.currentStep + 1);
  }
};
document.getElementById('preview-btn').addEventListener('click', runPreview);
document.getElementById('tab-show-tree-btn').addEventListener('click', toggleFileTree);

initTrustDialog({
  async onChanged(nextTrust) {
    if (!state.currentTutorial?.package_digest) return;
    const result = await setPackageTrust(state.currentTutorial.package_digest, nextTrust);
    state.currentTutorial.trust = result.trust;
    state.currentTutorial.trust_default = result.default;
    renderTrustButton();
    appendSessionLog(result.trust === 'user-trusted' ? t('trust.logGranted') : t('trust.logRevoked'), 'warn');
    toast(result.trust === 'user-trusted' ? t('trust.markedTrusted') : t('trust.markedUntrusted'));
    refreshDiagnosticsPane(currentTutorialKey());
  },
});

renderLogsPane();
