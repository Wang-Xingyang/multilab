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

/** Package-declared windows. Logs / diagnostics are host chrome, not step windows. */
export const PACKAGE_PANEL_TYPES = new Set([
  'tutorial',
  'file-tree',
  'editor',
  'terminal',
  'test-results',
  'web-preview',
]);

export const HOST_PANEL_TYPES = new Set(['logs', 'diagnostics']);

export const FALLBACK_PANELS = [
  { id: 'tutorial', type: 'tutorial', area: 'left' },
  { id: 'files', type: 'file-tree', area: 'center-right' },
  { id: 'editor', type: 'editor', area: 'center' },
  { id: 'terminal', type: 'terminal', area: 'bottom' },
];

export function coercePanelEntry(entry) {
  if (typeof entry === 'string' && entry.trim()) {
    const type = entry.trim();
    return { id: type, type };
  }
  if (entry && typeof entry === 'object') return entry;
  return null;
}

function panelsFromList(list) {
  const normalized = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const panel = coercePanelEntry(raw);
    if (!panel) continue;
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
  return {
    panels: normalized,
    has: hasMap(normalized),
  };
}

function hasMap(panels) {
  return {
    tutorial: hasVisibleOrDeclared(panels, 'tutorial'),
    editor: hasVisibleOrDeclared(panels, 'editor'),
    terminal: hasVisibleOrDeclared(panels, 'terminal'),
    'test-results': hasVisibleOrDeclared(panels, 'test-results'),
    'web-preview': hasVisibleOrDeclared(panels, 'web-preview'),
    'file-tree': hasVisibleOrDeclared(panels, 'file-tree'),
    logs: hasVisibleOrDeclared(panels, 'logs'),
    diagnostics: hasVisibleOrDeclared(panels, 'diagnostics'),
  };
}

export function normalizePanels(panels) {
  const source = Array.isArray(panels) && panels.length ? panels : FALLBACK_PANELS;
  const result = panelsFromList(source);
  if (!result.panels.length) return panelsFromList(FALLBACK_PANELS);
  return result;
}

/**
 * Step `panels` replaces package defaults for that step.
 * Missing / empty / all-unknown overlay inherits the package set.
 * Host chrome types in a step overlay are ignored.
 */
export function resolveStepPanels(packageUi, stepPanels) {
  const inherited = packageUi?.panels?.length ? packageUi : normalizePanels(null);
  if (!Array.isArray(stepPanels) || !stepPanels.length) return inherited;
  const overlay = panelsFromList(
    stepPanels.filter(entry => {
      const panel = coercePanelEntry(entry);
      return panel && !HOST_PANEL_TYPES.has(String(panel.type || ''));
    })
  );
  if (!overlay.panels.length) return inherited;
  return overlay;
}

function hasVisibleOrDeclared(panels, type) {
  return panels.some(panel => panel.type === type);
}

function defaultAreaForType(type) {
  // Stored for package compatibility. The player ignores geometry and
  // auto-layouts: tutorial left, editor | preview, terminal bottom,
  // file-tree as an editor accessory. Logs / diagnostics are host chrome.
  if (type === 'tutorial') return 'left';
  if (type === 'terminal') return 'bottom';
  if (type === 'web-preview') return 'right';
  if (type === 'test-results' || type === 'logs' || type === 'diagnostics') {
    return 'center';
  }
  if (type === 'file-tree') return 'center-right';
  return 'center';
}
