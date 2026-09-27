import { state, currentTutorialKey } from './state.js';
import { toast, status } from './ui.js';
import { apiJson, apiGet } from './api.js';
import { t } from './messages.js';
import { handleError } from './errors.js';
import { reconnectWS } from './terminal.js';

function renderTrustButton() {
  const btn = document.getElementById('trust-btn');
  const exportBtn = document.getElementById('export-save-btn');
  const reconnectBtn = document.getElementById('reconnect-btn');
  if (!btn) return;
  const label = btn.querySelector('.lbl');
  if (!state.currentTutorial?.package_digest) {
    btn.dataset.state = '';
    if (label) label.textContent = t('trust.unloaded');
    btn.title = t('trust.title');
    btn.disabled = true;
    if (exportBtn) exportBtn.disabled = true;
    if (reconnectBtn) reconnectBtn.disabled = true;
    return;
  }
  const trust = state.currentTutorial.trust || 'untrusted';
  const isTrusted = trust === 'user-trusted';
  btn.dataset.state = trust;
  if (label) label.textContent = isTrusted ? t('trust.trusted') : t('trust.untrusted');
  btn.title = t('trust.titleWithState', {
    source: state.currentTutorial.trust_default ? t('trust.sourceDefault') : t('trust.sourceUser'),
    trust,
  });
  btn.disabled = false;
  if (exportBtn) exportBtn.disabled = false;
  if (reconnectBtn) reconnectBtn.disabled = false;
}

function renderKernelSelect(resolution) {
  if (state.currentTutorial) {
    state.currentTutorial._kernelResolution = resolution || null;
  }
}

async function loadPlayerInfo() {
  try {
    const data = await apiGet('/api/runtime');
    if (data?.player) {
      state.player = {
        platform: data.player.platform || 'unknown',
        local_lab_supported: data.player.local_lab_supported !== false,
      };
    }
  } catch (e) {
    handleError(e, { feature: 'kernel', silent: true });
  }
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

async function selectKernel(kernelId) {
  if (!state.currentTutorial || !kernelId) return;
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
  selectKernel,
  loadPlayerInfo,
};
