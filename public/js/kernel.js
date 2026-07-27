import { state, currentTutorialKey } from './state.js';
import { toast, status, escapeAttr } from './ui.js';
import { apiJson, apiGet } from './api.js';
import { t } from './messages.js';
import { handleError } from './errors.js';
import { reconnectWS } from './terminal.js';

function renderTrustButton() {
  const btn = document.getElementById('trust-btn');
  const exportBtn = document.getElementById('export-save-btn');
  const reconnectBtn = document.getElementById('reconnect-btn');
  if (!state.currentTutorial?.package_digest) {
    btn.dataset.state = '';
    btn.querySelector('.lbl').textContent = t('trust.unloaded');
    btn.title = t('trust.title');
    btn.disabled = true;
    exportBtn.disabled = true;
    reconnectBtn.disabled = true;
    return;
  }
  const trust = state.currentTutorial.trust || 'untrusted';
  const isTrusted = trust === 'user-trusted';
  btn.dataset.state = trust;
  btn.querySelector('.lbl').textContent = isTrusted ? t('trust.trusted') : t('trust.untrusted');
  btn.title = t('trust.titleWithState', { source: state.currentTutorial.trust_default ? t('trust.sourceDefault') : t('trust.sourceUser'), trust });
  btn.disabled = false;
  exportBtn.disabled = false;
  reconnectBtn.disabled = false;
}

function renderKernelSelect(resolution) {
  const sel = document.getElementById('kernel-select');
  if (!resolution?.selected && !resolution?.candidates?.length) {
    sel.innerHTML = `<option value="">${t('kernel.none')}</option>`;
    sel.disabled = true;
    return;
  }
  const candidates = (resolution.candidates || []).filter(k => k.compatible);
  const selectedId = resolution.selected?.id || '';
  sel.innerHTML = candidates.map(k => {
    const label = `${k.display_name || k.id}${k.recommended ? ' ★' : ''}`;
    return `<option value="${escapeAttr(k.id)}" ${k.id === selectedId ? 'selected' : ''}>${escapeAttr(label)}</option>`;
  }).join('') || `<option value="">${t('kernel.noneCompatible')}</option>`;
  sel.disabled = candidates.length === 0;
  sel.title = resolution.runtime
    ? `${resolution.selected?.id || ''} · ${resolution.runtime.network_mode || '?'} · ${resolution.runtime.sandbox_preset || '?'}`
    : t('kernel.titleFallback');
  state.currentTutorial._kernelResolution = resolution;
}

async function refreshKernelResolution() {
  if (!state.currentTutorial) {
    renderKernelSelect(null);
    return;
  }
  try {
    const resolution = await apiGet(`/api/kernels/resolve?tutorial=${encodeURIComponent(currentTutorialKey())}`);
    renderKernelSelect(resolution);
  } catch (e) {
    handleError(e, { feature: 'kernel' });
    renderKernelSelect(null);
  }
}

async function selectKernelFromUi() {
  if (!state.currentTutorial) return;
  const sel = document.getElementById('kernel-select');
  const kernelId = sel.value;
  if (!kernelId) return;
  try {
    status(t('kernel.switching'));
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
    toast(result.replaced ? t('kernel.switched', { id: result.kernel.id }) : t('kernel.applied', { id: result.kernel.id }));
  } catch (e) {
    handleError(e, {
      feature: 'kernel',
      message: t('kernel.switchFailed', { error: e.message }),
      notify: true,
    });
    await refreshKernelResolution();
  }
}


export {
  renderTrustButton,
  renderKernelSelect,
  refreshKernelResolution,
  selectKernelFromUi,
};
