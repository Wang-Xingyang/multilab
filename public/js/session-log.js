import { t } from './messages.js';
const MAX_LOGS = 200;
const entries = [];

export function appendSessionLog(message, level = 'info') {
  entries.push({
    at: new Date().toISOString(),
    level,
    message: String(message || ''),
  });
  if (entries.length > MAX_LOGS) entries.splice(0, entries.length - MAX_LOGS);
  renderLogsPane();
}

export function clearSessionLogs() {
  entries.length = 0;
  renderLogsPane();
}

export function renderLogsPane() {
  const pane = document.getElementById('pane-logs');
  if (!pane) return;
  if (!entries.length) {
    pane.innerHTML = `<div class="aux-empty"><span>${t('panels.logsEmpty')}</span></div>`;
    return;
  }
  pane.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const entry of entries.slice().reverse()) {
    const line = document.createElement('div');
    line.className = `log-line ${entry.level || 'info'}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.at.slice(11, 19);
    line.appendChild(time);
    line.appendChild(document.createTextNode(entry.message));
    frag.appendChild(line);
  }
  pane.appendChild(frag);
}
