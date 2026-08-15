/**
 * Leading/trailing SVG for editor tabs (file + view).
 * Keep icons here so files.js / editor-views.js do not inline markup.
 */

function svgIcon(children, className, size = 14) {
  const wrap = document.createElement('div');
  const cls = className ? `tab-icon ${className}` : 'tab-icon';
  wrap.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${cls}">${children}</svg>`;
  return wrap.firstElementChild;
}

const FILE = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
const FOLDER = '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>';
const GLOBE = '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>';
const CHECK = '<polyline points="20 6 9 17 4 12"/>';
const LOG = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>';
const PULSE = '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>';
const CLOSE = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';

const FILE_KIND = {
  c: 'tab-icon-c',
  h: 'tab-icon-h',
  cpp: 'tab-icon-c',
  cc: 'tab-icon-c',
  hpp: 'tab-icon-c',
  md: 'tab-icon-md',
  py: 'tab-icon-py',
  js: 'tab-icon-js',
  ts: 'tab-icon-ts',
  sh: 'tab-icon-sh',
  bash: 'tab-icon-sh',
  json: 'tab-icon-json',
};

export function fileTabIcon(name, size = 14) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return svgIcon(FILE, FILE_KIND[ext] || 'tab-icon-file', size);
}

export function folderIcon(size = 13) {
  return svgIcon(FOLDER, 'tab-icon-folder', size);
}

export function viewTabIcon(id) {
  if (id === 'web-preview') return svgIcon(GLOBE, 'tab-icon-view');
  if (id === 'test-results') return svgIcon(CHECK, 'tab-icon-view');
  if (id === 'logs') return svgIcon(LOG, 'tab-icon-view');
  if (id === 'diagnostics') return svgIcon(PULSE, 'tab-icon-view');
  return svgIcon(FILE, 'tab-icon-view');
}

export function tabCloseIcon() {
  return svgIcon(CLOSE, 'tab-close-glyph', 12);
}
