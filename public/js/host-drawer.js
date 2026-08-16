/**
 * Host-side diagnostics drawer.
 * One panel: trust / kernel / reconnect, then session logs. No inner tabs.
 */
import { currentTutorialKey } from './state.js';
import { renderLogsPane } from './session-log.js';
import { refreshDiagnosticsPane } from './diagnostics.js';

export function isHostDrawerOpen() {
  return document.getElementById('host-drawer')?.classList.contains('open');
}

export function openHostDrawer() {
  const drawer = document.getElementById('host-drawer');
  if (!drawer) return;
  drawer.hidden = false;
  drawer.classList.add('open');
  refreshDiagnosticsPane(currentTutorialKey());
  renderLogsPane();
  syncDrawerButtons();
}

export function closeHostDrawer() {
  const drawer = document.getElementById('host-drawer');
  if (!drawer) return;
  drawer.classList.remove('open');
  drawer.hidden = true;
  syncDrawerButtons();
}

export function toggleHostDrawer() {
  if (isHostDrawerOpen()) closeHostDrawer();
  else openHostDrawer();
}

function syncDrawerButtons() {
  document.getElementById('diag-btn')?.classList.toggle('is-open', isHostDrawerOpen());
}

export function initHostDrawer() {
  document.getElementById('drawer-close')?.addEventListener('click', closeHostDrawer);
}
