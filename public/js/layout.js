import { state } from './state.js';

let previewSplit = null;
export function applyPreviewSplit() {
  previewSplit?.();
}

// 可拖拽分隔线。导出为显式 initLayout(), 由 app.js 调用,
// 而非靠 import 副作用执行。
export function initLayout() {
  const tutorialPanel = document.getElementById('tutorial-panel');
  const workspacePanel = document.getElementById('workspace-panel');
  const workspaceMain = document.getElementById('workspace-main');
  const editorColumn = document.getElementById('editor-column');
  const previewColumn = document.getElementById('preview-column');
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
      if (state.editor) state.editor.layout();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // editor | preview
  let previewW = parseFloat(localStorage.getItem('ml-preview-w')) || 42;
  function applyPreviewW() {
    const previewVisible = previewColumn.classList.contains('visible');
    const editorVisible = editorColumn.style.display !== 'none';
    if (previewVisible && editorVisible) {
      previewColumn.style.flex = previewW + ' 1 0%';
      editorColumn.style.flex = (100 - previewW) + ' 1 0%';
    } else {
      previewColumn.style.flex = '1 1 0%';
      editorColumn.style.flex = '1 1 0%';
    }
  }
  applyPreviewW();
  document.getElementById('drag-v-preview').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const box = workspaceMain.getBoundingClientRect();
    const startPct = previewW;
    document.getElementById('drag-v-preview').classList.add('active');
    document.body.style.cursor = 'col-resize';
    function move(ev) {
      const dx = ev.clientX - startX;
      previewW = Math.max(22, Math.min(70, startPct - dx / box.width * 100));
      applyPreviewW();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.getElementById('drag-v-preview').classList.remove('active');
      document.body.style.cursor = '';
      localStorage.setItem('ml-preview-w', previewW.toFixed(1));
      if (state.editor) state.editor.layout();
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // editor | file-tree
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

  // 横向: editor/preview area | terminal
  let hEditorH = parseFloat(localStorage.getItem('ml-editor-h')) || 55;
  function applyH() {
    workspaceMain.style.flex = hEditorH + ' 1 0px';
    terminalWrap.style.flex = (100 - hEditorH) + ' 1 0px';
  }
  applyH();
  document.getElementById('drag-h').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const workspaceBox = workspacePanel.getBoundingClientRect();
    const totalH = workspaceBox.height - 5;
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

  previewSplit = applyPreviewW;
}
