import { state, currentStepObj, currentTutorialKey, stepCommand } from './state.js';
import { apiJson, uploadArchive } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { normalizeProgress, stepIndexFromId } from './progress.js';
import { applyPanelLayout, applyProgress, applyProgressToUi } from './panels.js';
import { renderTrustButton, refreshKernelResolution } from './kernel.js';
import { loadFilesIntoEditor, saveCurrentStep } from './files.js';

function renderTutorialStepText() {
  const step = currentStepObj();
  if (!state.currentTutorial || !step) {
    document.getElementById('tutorial-content').innerHTML = `<p style="color:var(--text-dim)">${t('tutorial.emptyStep')}</p>`;
    return;
  }
  document.getElementById('tutorial-content').innerHTML = DOMPurify.sanitize(marked.parse(step.instructions || ''));
  document.getElementById('step-info').textContent =
    t('tutorial.stepInfo', { current: state.currentStep + 1, total: state.currentTutorial.steps.length, title: step.title || '' });
  document.getElementById('prev-step').disabled = state.currentStep === 0;
  document.getElementById('next-step').disabled = state.currentStep === state.currentTutorial.steps.length - 1;
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
    toast(t('package.pickMlab'), true);
    return;
  }
  try {
    status(t('package.opening'));
    const record = await uploadArchive('/api/packages/upload', file);
    await loadTutorialList({ preferredDigest: record.digest, preferredSourceType: 'installed' });
    toast(t('package.opened'));
  } catch (e) {
    toast(t('package.openFailed', { error: e.message }), true);
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
  toast(t('package.libraryOpened', { id: pkg.id, version: pkg.version }));
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

    const currentKey = state.currentTutorial?.source_key || state.currentTutorial?.id;
    if (currentKey && (currentKey === pkg.source_key || state.currentTutorial?.package_digest === pkg.digest)) {
      state.currentTutorial = null;
    }
    await loadLibraryList();
    await loadTutorialList({});
    toast(t('package.deleted'));
  } catch (e) {
    toast(t('package.deleteFailed', { error: e.message }), true);
  }
}

async function exportSaveDownload() {
  if (!state.currentTutorial) return;
  const tutorialKey = state.currentTutorial.source_key || state.currentTutorial.id;
  try {
    await saveCurrentStep({ silent: true });
    status(t('save.exporting'));
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
    const filename = match?.[1] || `${state.currentTutorial.package_id || 'tutorial'}.mlab-save`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(t('save.exported'));
  } catch (e) {
    toast(t('save.exportFailed', { error: e.message }), true);
  }
}

async function importSaveFromFile(file) {
  if (!file) return;
  if (!/\.mlab-save$/i.test(file.name)) {
    toast(t('save.pickSave'), true);
    return;
  }
  try {
    status(t('save.importing'));
    const result = await uploadArchive('/api/saves/upload', file);
    applyProgress(result.progress);
    await loadTutorialList({ preferredKey: result.source_key });
    appendSessionLog(t('save.importLog'));
    toast(t('save.imported'));
  } catch (e) {
    if (e.code === 'package_missing' || /matching package not found/.test(e.message || '')) {
      toast(t('save.packageMissing', { error: e.message }), true);
      return;
    }
    toast(t('save.importFailed', { error: e.message }), true);
  }
}

async function loadTutorial(id) {
  try {
    if (state.currentTutorial) await saveCurrentStep({ silent: true });
    const res = await fetch(`/api/tutorials/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    state.currentTutorial = await res.json();
    if (!state.currentTutorial || !state.currentTutorial.steps?.length) throw new Error(t('tutorial.invalidData'));
    state.currentProgress = normalizeProgress(state.currentTutorial.progress || null);
    state.auxVisible = false;
    applyPanelLayout();
    renderTrustButton();
    await refreshKernelResolution();
    appendSessionLog(t('tutorial.openLog', { id: state.currentTutorial.id || id }));
    // 直接从 tutorial detail 的 progress resume current_step。
    // 不要先 load step 0 探测: loadStepState 会 recordStepVisit, 把 current_step 覆盖成 0。
    const resumeStepId = state.currentTutorial.progress?.current_step;
    const resumeIdx = resumeStepId ? stepIndexFromId(state.currentTutorial, resumeStepId) : -1;
    const startIdx = resumeIdx >= 0 ? resumeIdx : 0;
    state.currentStep = startIdx;
    await enterStep(startIdx, { skipSave: true });
  } catch (e) {
    console.error(`[MultiLab] 加载教程 ${id} 失败:`, e);
    appendSessionLog(t('tutorial.loadFailed', { error: e.message }), 'error');
    document.getElementById('tutorial-content').innerHTML =
      `<p style="color:var(--error)">加载教程失败: ${escapeAttr(e.message)}</p>
       <p style="color:var(--text-dim);margin-top:8px">按 F12 打开开发者工具查看详细错误</p>`;
  }
}

async function enterStep(targetIndex, opts = {}) {
  if (!state.currentTutorial || !state.currentTutorial.steps?.[targetIndex]) return;
  const seq = ++state.stepLoadSeq;
  try {
    document.getElementById('prev-step').disabled = true;
    document.getElementById('next-step').disabled = true;
    if (!opts.skipSave) await saveCurrentStep({ silent: true });
    state.currentStep = targetIndex;
    renderTutorialStepText();
    applyProgressToUi();
    status(t('tutorial.loadingStep'));
    const step = currentStepObj();
    const result = await apiJson('/api/steps/load', { tutorial: currentTutorialKey(), step: step.id });
    if (seq !== state.stepLoadSeq) return;
    applyProgress(result.progress);
    loadFilesIntoEditor(result.files || []);
    renderTutorialStepText();
    applyProgressToUi();
    appendSessionLog(t('tutorial.enterLog', { id: step.id }));
    status(result.sourceStep && result.sourceStep !== step.id ? t('tutorial.inherited', { source: result.sourceStep }) : t('tutorial.stepLoaded'));
  } catch (e) {
    toast(t('tutorial.switchFailed', { error: e.message }), true);
    appendSessionLog(t('tutorial.switchFailed', { error: e.message }), 'error');
    renderTutorialStepText();
  }
}


export {
  renderTutorialStepText,
  loadTutorialList,
  pickLocalFile,
  openPackageFromFile,
  shortDigest,
  openLibraryPanel,
  closeLibraryPanel,
  loadLibraryList,
  openLibraryPackage,
  deleteLibraryPackage,
  exportSaveDownload,
  importSaveFromFile,
  loadTutorial,
  enterStep,
};
