import { apiJson } from './api.js';
import { toast } from './ui.js';

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
    title.textContent = '确认信任此教程包？';
    body.textContent = '信任表示你接受运行该包声明的命令。MultiLab 仍会按 security / sandbox / network 策略限制执行。不要信任来源不明的包。';
    confirmBtn.textContent = '确认信任';
    confirmBtn.className = 'primary';
  } else {
    title.textContent = '取消信任此教程包？';
    body.textContent = '取消后该包将回到未信任状态。需要 sandbox 的命令仍可按策略运行，但不会享受“用户信任”标记。';
    confirmBtn.textContent = '取消信任';
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
    toast('更新 trust 失败: ' + e.message, true);
  }
}

export async function setPackageTrust(packageDigest, trust) {
  return apiJson('/api/trust', { package_digest: packageDigest, trust });
}
