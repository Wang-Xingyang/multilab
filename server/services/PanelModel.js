export const KNOWN_PANEL_TYPES = new Set([
  'tutorial',
  'file-tree',
  'editor',
  'terminal',
  'test-results',
  'web-preview',
  'logs',
  'diagnostics',
]);

export const FALLBACK_PANELS = [
  { id: 'tutorial', type: 'tutorial', area: 'left' },
  { id: 'files', type: 'file-tree', area: 'center-left' },
  { id: 'editor', type: 'editor', area: 'center' },
  { id: 'terminal', type: 'terminal', area: 'bottom' },
];

export function normalizePanels(panels) {
  const source = Array.isArray(panels) && panels.length ? panels : FALLBACK_PANELS;
  const normalized = [];
  for (const panel of source) {
    if (!panel || typeof panel !== 'object') continue;
    const type = String(panel.type || '');
    if (!KNOWN_PANEL_TYPES.has(type)) continue;
    const id = String(panel.id || type);
    normalized.push({
      id,
      type,
      area: panel.area ? String(panel.area) : defaultAreaForType(type),
      hidden: panel.hidden === true,
    });
  }
  if (!normalized.length) {
    return normalizePanels(FALLBACK_PANELS);
  }
  return {
    panels: normalized,
    has: {
      tutorial: hasVisibleOrDeclared(normalized, 'tutorial'),
      editor: hasVisibleOrDeclared(normalized, 'editor'),
      terminal: hasVisibleOrDeclared(normalized, 'terminal'),
      'test-results': hasVisibleOrDeclared(normalized, 'test-results'),
      'web-preview': hasVisibleOrDeclared(normalized, 'web-preview'),
      'file-tree': hasVisibleOrDeclared(normalized, 'file-tree'),
      logs: hasVisibleOrDeclared(normalized, 'logs'),
      diagnostics: hasVisibleOrDeclared(normalized, 'diagnostics'),
    },
  };
}

function hasVisibleOrDeclared(panels, type) {
  return panels.some(panel => panel.type === type);
}

function defaultAreaForType(type) {
  if (type === 'tutorial') return 'left';
  if (type === 'terminal') return 'bottom';
  if (type === 'test-results' || type === 'web-preview' || type === 'logs' || type === 'diagnostics') {
    return 'right';
  }
  if (type === 'file-tree') return 'center-left';
  return 'center';
}
