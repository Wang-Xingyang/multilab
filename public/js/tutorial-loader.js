/**
 * Tutorial loading + step navigation.
 *
 * Owns: tutorial list, tutorial detail load, step enter/render.
 * Depends on files.js (load/save step) — one direction only.
 * library.js and save-io.js depend on this module (loadTutorialList),
 * never the reverse.
 */
import { state, currentStepObj, currentTutorialKey, stepCommand } from './state.js';
import { apiJson, apiGet } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { normalizeProgress, stepIndexFromId } from './progress.js';
import { applyPanelLayout, applyProgress, applyProgressToUi } from './panels.js';
import { renderTrustButton, refreshKernelResolution } from './kernel.js';
import { loadFilesIntoEditor, saveCurrentStep } from './files.js';
import { handleError } from './errors.js';

export function renderTutorialStepText() {
  const step = currentStepObj();
  const content = document.getElementById('tutorial-content');
  if (!state.currentTutorial || !step) {
    content.innerHTML = `<div class="tutorial-placeholder"><div class="ph-sub">${t('tutorial.emptyStep')}</div></div>`;
    return;
  }
  content.innerHTML = DOMPurify.sanitize(marked.parse(step.instructions || ''));
  // 克制的 step 切换淡入: 移除 class → reflow → 重新加上, 触发 animation
  content.classList.remove('step-enter');
  void content.offsetWidth;
  content.classList.add('step-enter');
  document.getElementById('test-btn').style.display = stepCommand(step, 'test') ? '' : 'none';
  document.getElementById('preview-btn').style.display = stepCommand(step, 'preview') ? '' : 'none';
}

export async function loadTutorialList(opts = {}) {
  try {
    const { tutorials, expectedDir } = await apiGet('/api/tutorials');
    const sel = document.getElementById('tutorial-select');
    if (tutorials.length === 0) {
      sel.innerHTML = `<option value="">${t('tutorial.selectPlaceholder')}</option>`;
      document.getElementById('tutorial-content').innerHTML =
        `<div class="tutorial-placeholder">
          <div class="ph-title">${t('tutorial.emptyTitle')}</div>
          <div class="ph-sub">${t('tutorial.emptySub')}</div>
          <div class="ph-sub" style="margin-top:4px"><code>${escapeAttr(expectedDir || '(未知)')}</code></div>
          <div class="ph-hint">
            <div style="margin-bottom:6px">${t('tutorial.emptyCheckTitle')}</div>
            <ol style="margin:0;padding-left:18px;line-height:1.8"><li>${t('tutorial.emptyCheck1')}</li><li>${t('tutorial.emptyCheck2')}</li></ol>
          </div>
        </div>`;
      document.getElementById('loading-msg').style.display = 'none';
      return;
    }
    sel.innerHTML = tutorials.map(tu => {
      const sourceKey = tu.source_key || tu.id;
      const sourceLabel = tu.source_type === 'installed' ? 'imported' : 'dev';
      return `<option value="${escapeAttr(sourceKey)}">${escapeAttr(tu.title)} (${escapeAttr(tu.language)}, ${tu.steps} ${t('tutorial.stepsSuffix')}, ${sourceLabel})</option>`;
    }).join('');
    sel.onchange = () => loadTutorial(sel.value);
    const selected = tutorials.find(tu => {
      const sourceKey = tu.source_key || tu.id;
      if (opts.preferredKey && sourceKey === opts.preferredKey) return true;
      if (opts.preferredDigest && tu.package_digest === opts.preferredDigest) {
        return !opts.preferredSourceType || tu.source_type === opts.preferredSourceType;
      }
      return false;
    }) || tutorials[0];
    const selectedKey = selected.source_key || selected.id;
    sel.value = selectedKey;
    loadTutorial(selectedKey);
  } catch (e) {
    handleError(e, { feature: 'tutorial' });
    document.getElementById('tutorial-content').innerHTML =
      `<div class="tutorial-placeholder error">
        <div class="ph-title">${t('tutorial.listFailedTitle')}</div>
        <div class="ph-sub">${escapeAttr(e.message)}</div>
        <div class="ph-hint">${t('tutorial.backendHint', { port: location.port || 3000 })}</div>
      </div>`;
  }
}

export async function loadTutorial(id) {
  try {
    if (state.currentTutorial) await saveCurrentStep({ silent: true });
    state.currentTutorial = await apiGet(`/api/tutorials/${encodeURIComponent(id)}`);
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
    handleError(e, { feature: 'tutorial', log: true });
    document.getElementById('tutorial-content').innerHTML =
      `<div class="tutorial-placeholder error">
        <div class="ph-title">${t('tutorial.loadFailedHtml', { error: escapeAttr(e.message) })}</div>
        <div class="ph-hint">${t('tutorial.loadFailedHint')}</div>
      </div>`;
  }
}

export async function enterStep(targetIndex, opts = {}) {
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
    handleError(e, {
      feature: 'tutorial',
      message: t('tutorial.switchFailed', { error: e.message }),
      notify: true,
      log: true,
    });
    renderTutorialStepText();
  }
}
