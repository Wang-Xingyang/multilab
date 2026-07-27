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
  const icon = document.getElementById('trust-dialog-icon');
  if (pendingNextTrust === 'user-trusted') {
    title.textContent = t('trust.confirmGrantTitle');
    body.textContent = t('trust.confirmGrantBody');
    confirmBtn.textContent = t('trust.confirmGrantAction');
    confirmBtn.className = 'primary';
    if (icon) {
      icon.classList.remove('revoke');
      icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
    }
  } else {
    title.textContent = t('trust.confirmRevokeTitle');
    body.textContent = t('trust.confirmRevokeBody');
    confirmBtn.textContent = t('trust.confirmRevokeAction');
    confirmBtn.className = 'danger';
    if (icon) {
      icon.classList.add('revoke');
      icon.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    }
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
