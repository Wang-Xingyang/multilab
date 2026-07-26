import { apiJson } from './api.js';
import { toast } from './ui.js';
import { t } from './messages.js';

let pendingNextTrust = null;
let onTrustChanged = null;

export function initTrustDialog({ onChanged } = {}) {
  onTrustChanged = onChanged || null;
  document.getElementById('trust-cancel-btn')?.addEventListener('click', closeTrustDialog);
  document.getElementById('trust-confirm-btn')?.addEventListener('click', confirmTrustDialog);
  document.getElementById('trust-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeTrustDialog();
  });
}

export function openTrustDialog(tutorial) {
  if (!tutorial?.package_digest) return;
  const isTrusted = tutorial.trust === 'user-trusted';
  pendingNextTrust = isTrusted ? 'untrusted' : 'user-trusted';
  const title = document.getElementById('trust-dialog-title');
  const body = document.getElementById('trust-dialog-body');
  const digest = document.getElementById('trust-dialog-digest');
  const confirmBtn = document.getElementById('trust-confirm-btn');
  if (pendingNextTrust === 'user-trusted') {
    title.textContent = t('trust.confirmGrantTitle');
    body.textContent = t('trust.confirmGrantBody');
    confirmBtn.textContent = t('trust.confirmGrantAction');
    confirmBtn.className = 'primary';
  } else {
    title.textContent = t('trust.confirmRevokeTitle');
    body.textContent = t('trust.confirmRevokeBody');
    confirmBtn.textContent = t('trust.confirmRevokeAction');
    confirmBtn.className = 'danger';
  }
  digest.textContent = tutorial.package_digest;
  document.getElementById('trust-overlay').style.display = 'block';
}

export function closeTrustDialog() {
  pendingNextTrust = null;
  const overlay = document.getElementById('trust-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function confirmTrustDialog() {
  if (!pendingNextTrust || !onTrustChanged) return;
  const nextTrust = pendingNextTrust;
  closeTrustDialog();
  try {
    await onTrustChanged(nextTrust);
  } catch (e) {
    toast(t('trust.updateFailed', { error: e.message }), true);
  }
}

export async function setPackageTrust(packageDigest, trust) {
  return apiJson('/api/trust', { package_digest: packageDigest, trust });
}
