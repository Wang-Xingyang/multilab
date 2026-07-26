const TOAST_SVGS = {
  ok: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20,6 9,17 4,12"/></svg>',
  err: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--error)" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

export function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.innerHTML = (isError ? TOAST_SVGS.err : TOAST_SVGS.ok) + '<span>' + msg + '</span>';
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { el.className = 'toast'; }, 2500);
}

export function status(msg) {
  const el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className = 'status-bar show';
  setTimeout(() => { el.className = 'status-bar'; }, 1500);
}

export function escapeAttr(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}
