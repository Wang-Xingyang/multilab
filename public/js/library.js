/**
 * Tutorial catalog picker: current tutorial + all available packages.
 *
 * Replaces the native <select> and the separate library overlay.
 * Open .mlab lives in the picker footer. Progress import/export is
 * current-tutorial chrome, not part of this catalog.
 *
 * Depends on tutorial-loader.js (loadTutorialList / loadTutorial) via
 * lazy import so tutorial-loader can render the catalog without a cycle.
 */
import { state, currentTutorialKey } from './state.js';
import { apiDelete, uploadArchive } from './api.js';
import { toast, status, escapeAttr } from './ui.js';
import { t } from './messages.js';
import { handleError } from './errors.js';
import { confirmDialog } from './dialog.js';

let catalog = [];

export function shortDigest(digest) {
  const hex = String(digest || '').replace(/^sha256:/, '');
  return hex.length > 16 ? `${hex.slice(0, 12)}…${hex.slice(-8)}` : hex;
}

function pickerEls() {
  return {
    root: document.getElementById('tutorial-picker'),
    btn: document.getElementById('tutorial-picker-btn'),
    pop: document.getElementById('tutorial-picker-pop'),
    list: document.getElementById('tutorial-picker-list'),
    label: document.getElementById('tutorial-picker-label'),
  };
}

export function isTutorialPickerOpen() {
  return document.getElementById('tutorial-picker')?.classList.contains('open');
}

export function closeTutorialPicker() {
  const { root, btn, pop } = pickerEls();
  if (!root) return;
  root.classList.remove('open');
  if (pop) pop.hidden = true;
  if (btn) {
    btn.classList.remove('is-open');
    btn.setAttribute('aria-expanded', 'false');
  }
}

export async function openTutorialPicker() {
  const { root, btn, pop } = pickerEls();
  if (!root) return;
  root.classList.add('open');
  if (pop) pop.hidden = false;
  if (btn) {
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');
  }
  await refreshCatalog();
}

export async function toggleTutorialPicker() {
  if (isTutorialPickerOpen()) closeTutorialPicker();
  else await openTutorialPicker();
}

export function setCatalogLabel(tutorial) {
  const { label, btn } = pickerEls();
  if (!label) return;
  if (!tutorial) {
    label.textContent = t('tutorial.selectPlaceholder');
    if (btn) btn.title = t('chrome.selectTutorial');
    return;
  }
  label.textContent = tutorial.title || tutorial.package_id || tutorial.id || t('tutorial.selectPlaceholder');
  if (btn) btn.title = t('chrome.selectTutorial');
}

function makeCatalogRow(tu, currentKey) {
  const key = tu.source_key || tu.id;
  const imported = tu.source_type === 'installed';
  const row = document.createElement('div');
  row.className = 'tutorial-picker-item' + (key === currentKey ? ' is-current' : '');
  row.dataset.action = 'open';
  row.dataset.key = key;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', key === currentKey ? 'true' : 'false');
  row.tabIndex = 0;

  const text = document.createElement('div');
  text.className = 'tutorial-picker-item-text';
  const title = document.createElement('div');
  title.className = 'tutorial-picker-item-title';
  title.textContent = tu.title || tu.package_id || key;
  const meta = document.createElement('div');
  meta.className = 'tutorial-picker-item-meta';
  const parts = [
    tu.language,
    tu.steps != null ? `${tu.steps} ${t('tutorial.stepsSuffix')}` : null,
  ].filter(Boolean);
  meta.textContent = parts.join(' · ');
  text.append(title, meta);
  row.appendChild(text);

  if (imported) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tutorial-picker-delete';
    del.dataset.action = 'delete';
    del.dataset.key = key;
    del.dataset.packageId = tu.package_id || tu.id;
    del.dataset.version = tu.version || '0.0.0';
    del.dataset.digest = tu.package_digest || '';
    del.title = t('tutorial.delete');
    del.textContent = t('tutorial.delete');
    row.appendChild(del);
  }
  return row;
}

function appendCatalogGroup(list, label, items, currentKey) {
  if (!items.length) return;
  const head = document.createElement('div');
  head.className = 'tutorial-picker-group';
  head.textContent = label;
  list.appendChild(head);
  for (const tu of items) list.appendChild(makeCatalogRow(tu, currentKey));
}

export function renderCatalog(tutorials, { expectedDir, selectedKey } = {}) {
  const { list } = pickerEls();
  if (!list) return;
  catalog = Array.isArray(tutorials) ? tutorials : [];
  list._tutorials = catalog;
  const currentKey = selectedKey
    || currentTutorialKey()
    || '';

  if (!catalog.length) {
    const dir = expectedDir || t('tutorial.unknownDir');
    list.innerHTML = `<div class="tutorial-picker-empty">${escapeAttr(t('tutorial.emptyTitle'))}<span>${escapeAttr(t('tutorial.emptySearchPath', { dir }))}</span></div>`;
    if (!currentTutorialKey()) setCatalogLabel(null);
    return;
  }

  list.replaceChildren();
  const dev = catalog.filter(tu => tu.source_type !== 'installed');
  const imported = catalog.filter(tu => tu.source_type === 'installed');
  if (dev.length && imported.length) {
    appendCatalogGroup(list, t('tutorial.sourceDev'), dev, currentKey);
    appendCatalogGroup(list, t('tutorial.sourceImported'), imported, currentKey);
  } else {
    for (const tu of catalog) list.appendChild(makeCatalogRow(tu, currentKey));
  }

  const selected = catalog.find(tu => (tu.source_key || tu.id) === currentKey) || catalog[0];
  if (selected && (currentTutorialKey() === (selected.source_key || selected.id) || !currentTutorialKey())) {
    setCatalogLabel(selected);
  }
  requestAnimationFrame(() => {
    list.querySelector('.tutorial-picker-item.is-current')?.scrollIntoView({ block: 'nearest' });
  });
}

async function refreshCatalog() {
  const { loadTutorialList } = await import('./tutorial-loader.js');
  await loadTutorialList({ refreshOnly: true });
}

async function onListClick(e) {
  const del = e.target.closest('[data-action="delete"]');
  if (del) {
    e.preventDefault();
    e.stopPropagation();
    await deleteCatalogPackage({
      id: del.dataset.packageId,
      version: del.dataset.version,
      digest: del.dataset.digest,
      source_key: del.dataset.key,
    });
    return;
  }
  const row = e.target.closest('[data-action="open"]');
  if (!row) return;
  const key = row.dataset.key;
  if (!key) return;
  closeTutorialPicker();
  if (key === currentTutorialKey()) return;
  const { loadTutorial } = await import('./tutorial-loader.js');
  await loadTutorial(key);
  const selected = catalog.find(tu => (tu.source_key || tu.id) === key);
  setCatalogLabel(selected || { title: key });
}

export async function deleteCatalogPackage(pkg) {
  const ok = await confirmDialog({
    title: t('package.deleteTitle'),
    body: t('package.deleteBody', { id: pkg.id, version: pkg.version || '0.0.0', digest: pkg.digest }),
    confirmText: t('tutorial.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    const params = new URLSearchParams({
      id: pkg.id,
      version: pkg.version || '0.0.0',
      digest: pkg.digest,
    });
    await apiDelete(`/api/packages/item?${params}`);
    const currentKey = currentTutorialKey();
    if (currentKey && (currentKey === pkg.source_key || state.currentTutorial?.package_digest === pkg.digest)) {
      state.currentTutorial = null;
    }
    const { loadTutorialList } = await import('./tutorial-loader.js');
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
    closeTutorialPicker();
    const record = await uploadArchive('/api/packages/upload', file);
    const { loadTutorialList } = await import('./tutorial-loader.js');
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

export function initTutorialPicker() {
  const { root, btn, list } = pickerEls();
  if (!btn || !root) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.menu.open').forEach(m => m.classList.remove('open'));
    toggleTutorialPicker();
  });
  list?.addEventListener('click', onListClick);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#tutorial-picker')) closeTutorialPicker();
  });
}
