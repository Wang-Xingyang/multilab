/**
 * Generic modal dialogs — replaces browser confirm()/prompt().
 *
 * Reuses the trust-dialog visual language (overlay + centered card + icon +
 * title + body + actions, pop-in animation) via the shared `.app-dialog` class.
 * confirmDialog() → Promise<boolean>, promptDialog() → Promise<string|null>.
 * Esc / overlay-click = cancel; Enter = confirm (prompt).
 */
import { t } from './messages.js';

let activeOverlay = null;

function close() {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }
}

function buildDialog({ title, body, danger }) {
  const overlay = document.createElement('div');
  overlay.className = 'picker-overlay';
  overlay.style.display = 'block';

  const dialog = document.createElement('div');
  dialog.className = 'app-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const icon = document.createElement('div');
  icon.className = 'dialog-icon' + (danger ? ' revoke' : '');
  icon.innerHTML = danger
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  dialog.appendChild(icon);

  const h = document.createElement('h3');
  h.textContent = title;
  dialog.appendChild(h);

  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    dialog.appendChild(p);
  }

  overlay.appendChild(dialog);
  return { overlay, dialog };
}

function mount(overlay, onCancel) {
  activeOverlay = overlay;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { close(); onCancel(); }
  });
  const esc = (e) => {
    if (e.key === 'Escape') { close(); onCancel(); document.removeEventListener('keydown', esc); }
  };
  document.addEventListener('keydown', esc);
}

/**
 * confirmDialog({ title, body, confirmText, cancelText, danger }) → Promise<boolean>
 */
export function confirmDialog({ title, body, confirmText, cancelText, danger = false }) {
  return new Promise((resolve) => {
    if (activeOverlay) { resolve(false); return; }
    const { overlay, dialog } = buildDialog({ title, body, danger });

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = cancelText || t('dialog.cancel');
    cancelBtn.onclick = () => { close(); resolve(false); };
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = confirmText || t('dialog.confirm');
    confirmBtn.className = danger ? 'danger' : 'primary';
    confirmBtn.onclick = () => { close(); resolve(true); };
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    mount(overlay, () => resolve(false));
    confirmBtn.focus();
  });
}

/**
 * promptDialog({ title, body, placeholder, defaultValue, confirmText }) → Promise<string|null>
 */
export function promptDialog({ title, body, placeholder, defaultValue, confirmText }) {
  return new Promise((resolve) => {
    if (activeOverlay) { resolve(null); return; }
    const { overlay, dialog } = buildDialog({ title, body, danger: false });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dialog-input';
    input.placeholder = placeholder || '';
    if (defaultValue != null) input.value = defaultValue;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { const v = input.value; close(); resolve(v); }
      if (e.key === 'Escape') { close(); resolve(null); }
    });
    dialog.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = t('dialog.cancel');
    cancelBtn.onclick = () => { close(); resolve(null); };
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.textContent = confirmText || t('dialog.confirm');
    confirmBtn.className = 'primary';
    confirmBtn.onclick = () => { const v = input.value; close(); resolve(v); };
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(actions);

    mount(overlay, () => resolve(null));
    input.focus();
    input.select();
  });
}
