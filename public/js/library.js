/**
 * Package library panel + .mlab open/upload.
 *
 * Depends on tutorial-loader.js (loadTutorialList) — one direction only.
 */
import { state } from './state.js';
import { apiGet, apiDelete, uploadArchive } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { t } from './messages.js';
import { handleError } from './errors.js';
import { loadTutorialList } from './tutorial-loader.js';

export function shortDigest(digest) {
  const hex = String(digest || '').replace(/^sha256:/, '');
  return hex.length > 16 ? `${hex.slice(0, 12)}…${hex.slice(-8)}` : hex;
}

export function openLibraryPanel() {
  document.getElementById('library-overlay').style.display = 'block';
  loadLibraryList();
}

export function closeLibraryPanel() {
  document.getElementById('library-overlay').style.display = 'none';
}

export async function loadLibraryList() {
  const list = document.getElementById('library-list');
  list.innerHTML = `<div class="library-empty">${t('files.loading')}</div>`;
  try {
    const { packages } = await apiGet('/api/packages');
    if (!packages?.length) {
      list.innerHTML = `<div class="library-empty">${t('package.emptyLibrary')}</div>`;
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
            <button data-action="open" data-idx="${idx}">${t('tutorial.open')}</button>
            <button class="danger" data-action="delete" data-idx="${idx}">${t('tutorial.delete')}</button>
          </div>
        </div>
      </div>
    `).join('');
    list._packages = packages;
  } catch (e) {
    list.innerHTML = `<div class="library-empty">${t('package.loadLibraryFailed', { error: e.message })}</div>`;
  }
}

export async function openLibraryPackage(pkg) {
  closeLibraryPanel();
  const preferredKey = pkg.source_key;
  await loadTutorialList({
    preferredKey,
    preferredDigest: pkg.digest,
    preferredSourceType: 'installed',
  });
  toast(t('package.libraryOpened', { id: pkg.id, version: pkg.version }));
}

export async function deleteLibraryPackage(pkg) {
  if (!confirm(t('package.deleteConfirm', { id: pkg.id, version: pkg.version || '0.0.0', digest: pkg.digest }))) return;
  try {
    const params = new URLSearchParams({
      id: pkg.id,
      version: pkg.version || '0.0.0',
      digest: pkg.digest,
    });
    await apiDelete(`/api/packages/item?${params}`);
    const currentKey = state.currentTutorial?.source_key || state.currentTutorial?.id;
    if (currentKey && (currentKey === pkg.source_key || state.currentTutorial?.package_digest === pkg.digest)) {
      state.currentTutorial = null;
    }
    await loadLibraryList();
    await loadTutorialList({});
    toast(t('package.deleted'));
  } catch (e) {
    handleError(e, {
      feature: 'library',
      message: t('package.deleteFailed', { error: e.message }),
      notify: true,
    });
  }
}

export function pickLocalFile(inputId) {
  const input = document.getElementById(inputId);
  input.value = '';
  input.click();
}

export async function openPackageFromFile(file) {
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
    handleError(e, {
      feature: 'library',
      message: t('package.openFailed', { error: e.message }),
      notify: true,
    });
  }
}
