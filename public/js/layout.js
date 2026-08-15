import { state } from './state.js';

// 可拖拽分隔线。导出为显式 initLayout(), 由 app.js 调用,
// 而非靠 import 副作用执行。
export function initLayout() {
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
      state.fitAddon && state.fitAddon.fit();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // editor | file-tree | toggle rail (tree opens left of a fixed right-edge button)
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
      treeW = Math.max(140, Math.min(360, startW - (ev.clientX - startX)));
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

  // 横向: state.editor area | terminal
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
      state.fitAddon && state.fitAddon.fit();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
