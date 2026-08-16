/**
 * Tutorial loading + step navigation.
 *
 * Owns: tutorial list, tutorial detail load, step enter/render.
 * Depends on files.js (load/save step) — one direction only.
 * library.js owns the catalog picker and lazily imports this module
 * for loadTutorialList / loadTutorial so there is no import cycle.
 */
import { state, currentStepObj, currentTutorialKey } from './state.js';
import { apiJson, apiGet } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { t } from './messages.js';
import { appendSessionLog } from './session-log.js';
import { normalizeProgress, stepIndexFromId } from './progress.js';
import { applyPanelLayout, applyProgress, applyProgressToUi, applyStepCommands } from './panels.js';
import { renderTrustButton, refreshKernelResolution } from './kernel.js';
import { loadFilesIntoEditor, saveCurrentStep } from './files.js';
import { handleError } from './errors.js';
import { renderTutorialMarkdown } from './content-renderer.js';
import { renderCatalog, setCatalogLabel } from './library.js';

let lastRenderedStepId = null;
export function renderTutorialStepText() {
  const step = currentStepObj();
  const content = document.getElementById('tutorial-content');
  if (!state.currentTutorial || !step) {
    content.innerHTML = `<div class="tutorial-placeholder"><div class="ph-sub">${t('tutorial.emptyStep')}</div></div>`;
    lastRenderedStepId = null;
    return;
  }
  renderTutorialMarkdown(content, step.instructions || '', {
    sourceKey: currentTutorialKey(),
    stepId: step.id,
  });
  // 仅在 step 真正变化时触发淡入动画。enterStep 会调用两次 renderTutorialStepText
  // (loading 前 + loaded 后), 同 step 重复触发 opacity 动画会造成正文闪烁。
  if (lastRenderedStepId !== step.id) {
    content.classList.remove('step-enter');
    void content.offsetWidth;
    content.classList.add('step-enter');
  } else {
    content.classList.remove('step-enter');
  }
  lastRenderedStepId = step.id;
  applyStepCommands();
}

export async function loadTutorialList(opts = {}) {
  try {
    const { tutorials, expectedDir } = await apiGet('/api/tutorials');
    const currentKey = state.currentTutorial?.source_key || state.currentTutorial?.id;
    const selected = tutorials.find(tu => {
      const sourceKey = tu.source_key || tu.id;
      if (opts.preferredKey && sourceKey === opts.preferredKey) return true;
      if (opts.preferredDigest && tu.package_digest === opts.preferredDigest) {
        return !opts.preferredSourceType || tu.source_type === opts.preferredSourceType;
      }
      return false;
    }) || tutorials.find(tu => (tu.source_key || tu.id) === currentKey) || tutorials[0];
    const selectedKey = selected ? (selected.source_key || selected.id) : '';
    renderCatalog(tutorials, { expectedDir, selectedKey });

    if (tutorials.length === 0) {
      setCatalogLabel(null);
      document.getElementById('tutorial-content').innerHTML =
        `<div class="tutorial-placeholder">
          <div class="ph-title">${t('tutorial.emptyTitle')}</div>
          <div class="ph-sub">${t('tutorial.emptySub')}</div>
          <div class="ph-sub" style="margin-top:4px"><code>${escapeAttr(expectedDir || t('tutorial.unknownDir'))}</code></div>
          <div class="ph-hint">
            <div style="margin-bottom:6px">${t('tutorial.emptyCheckTitle')}</div>
            <ol style="margin:0;padding-left:18px;line-height:1.8"><li>${t('tutorial.emptyCheck1')}</li><li>${t('tutorial.emptyCheck2')}</li></ol>
          </div>
        </div>`;
      document.getElementById('loading-msg').style.display = 'none';
      return;
    }

    setCatalogLabel(selected);
    if (opts.refreshOnly && selectedKey && selectedKey === currentKey) return;
    loadTutorial(selectedKey);
  } catch (e) {
    handleError(e, { feature: 'tutorial' });
    setCatalogLabel(null);
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
    if (state.currentTutorial) await saveCurrentStep({ silent: true, force: true });
    state.currentTutorial = await apiGet(`/api/tutorials/${encodeURIComponent(id)}`);
    if (!state.currentTutorial || !state.currentTutorial.steps?.length) throw new Error(t('tutorial.invalidData'));
    state.previewForcedOpen = false;
    state.currentProgress = normalizeProgress(state.currentTutorial.progress || null);
    applyPanelLayout();
    renderTrustButton();
    await refreshKernelResolution();
    appendSessionLog(t('tutorial.openLog', { id: state.currentTutorial.id || id }));
    setCatalogLabel(state.currentTutorial);
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
    if (!opts.skipSave) await saveCurrentStep({ silent: true, force: true });
    status(t('tutorial.loadingStep'));
    const step = state.currentTutorial.steps[targetIndex];
    const result = await apiJson('/api/steps/load', { tutorial: currentTutorialKey(), step: step.id });
    if (seq !== state.stepLoadSeq) return;
    // Only now is this the live step. Updating currentStep before load
    // made save/run persist the previous editor buffers into the new step.
    state.currentStep = targetIndex;
    applyProgress(result.progress);
    loadFilesIntoEditor(result.files || [], {
      ui: result.ui,
      entryFile: step.entry_file,
    });
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
