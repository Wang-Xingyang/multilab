import { escapeAttr, toast, status } from './ui.js';
import { t } from './messages.js';
import { apiGet, apiJson } from './api.js';
import { handleError } from './errors.js';
import { state, currentTutorialKey } from './state.js';
import { reconnectWS } from './terminal.js';
import { refreshKernelResolution, renderKernelSelect } from './kernel.js';
import { refreshFileTree } from './file-tree.js';

function kv(rows) {
  return `<div class="diag-kv">${rows.map(([k, v]) =>
    `<div class="k">${escapeAttr(k)}</div><div class="v">${escapeAttr(v ?? '—')}</div>`
  ).join('')}</div>`;
}

function field({ id, label, type = 'text', value = '', placeholder = '', autocomplete = 'off' }) {
  return `<label class="diag-field">
    <span>${escapeAttr(label)}</span>
    <input id="${escapeAttr(id)}" type="${escapeAttr(type)}" value="${escapeAttr(value)}"
      placeholder="${escapeAttr(placeholder)}" autocomplete="${escapeAttr(autocomplete)}">
  </label>`;
}

function playerInfo(connection = {}) {
  return connection.player || state.player || { platform: 'unknown', local_lab_supported: true };
}

function renderSshForm(connection = {}) {
  const connected = Boolean(connection.connected || connection.ready);
  const player = playerInfo(connection);
  const localOk = player.local_lab_supported !== false;
  const statusLabel = connected ? t('lab.statusOn') : t('lab.statusOff');
  const hostPlaceholder = localOk ? t('lab.hostPlaceholder') : t('lab.hostPlaceholderLocal');
  const hint = localOk ? '' : `<p class="diag-note">${escapeAttr(t('lab.wslHint'))}</p>`;
  const localBtn = localOk
    ? `<button type="button" class="hdr-btn ghost" id="ssh-local">${escapeAttr(t('lab.useLocal'))}</button>`
    : '';
  return `
    <div class="diag-block" id="diag-ssh">
      <h4>${escapeAttr(t('lab.title'))}</h4>
      <p class="diag-note">${escapeAttr(statusLabel)}${connection.error ? ` — ${escapeAttr(connection.error)}` : ''}</p>
      ${hint}
      <form class="diag-form" id="ssh-form">
        ${field({ id: 'ssh-host', label: t('lab.host'), value: connection.host || '', placeholder: hostPlaceholder })}
        ${field({ id: 'ssh-port', label: t('lab.port'), type: 'number', value: String(connection.port || 22) })}
        ${field({ id: 'ssh-user', label: t('lab.username'), value: connection.username || '', placeholder: 'student' })}
        ${field({
          id: 'ssh-key',
          label: t('lab.privateKey'),
          value: connection.privateKeyPath || '',
          placeholder: t('lab.keyPlaceholder'),
        })}
        ${field({
          id: 'ssh-password',
          label: t('lab.password'),
          type: 'password',
          placeholder: t('lab.passwordHint'),
          autocomplete: 'new-password',
        })}
        <label class="diag-check">
          <input id="ssh-agent" type="checkbox" ${connection.useAgent !== false ? 'checked' : ''}>
          <span>${escapeAttr(t('lab.useAgent'))}</span>
        </label>
        <div class="diag-actions">
          <button type="submit" class="hdr-btn primary" id="ssh-connect">${escapeAttr(t('lab.connect'))}</button>
          <button type="button" class="hdr-btn ghost" id="ssh-disconnect">${escapeAttr(t('lab.disconnect'))}</button>
          ${localBtn}
        </div>
      </form>
    </div>
  `;
}

function bindSshForm(tutorialKey) {
  const form = document.getElementById('ssh-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await connectSsh(tutorialKey);
  });
  document.getElementById('ssh-disconnect')?.addEventListener('click', () => disconnectSsh(tutorialKey));
  document.getElementById('ssh-local')?.addEventListener('click', () => disconnectSsh(tutorialKey));
}

function sshFormPayload() {
  const password = document.getElementById('ssh-password')?.value || '';
  const payload = {
    host: document.getElementById('ssh-host')?.value || '',
    port: Number(document.getElementById('ssh-port')?.value || 22),
    username: document.getElementById('ssh-user')?.value || '',
    privateKeyPath: document.getElementById('ssh-key')?.value || '',
    useAgent: Boolean(document.getElementById('ssh-agent')?.checked),
  };
  if (password) payload.password = password;
  return payload;
}

async function connectSsh(tutorialKey) {
  try {
    status(t('lab.connecting'));
    const result = await apiJson('/api/lab/connect', {
      ...sshFormPayload(),
      tutorial: tutorialKey || undefined,
    });
    if (result.kernel) {
      renderKernelSelect({
        selected: result.kernel,
        runtime: result.runtime,
        preferred_applied: true,
      });
    }
    reconnectWS({ reason: 'ssh-remote' });
    refreshFileTree(false);
    const conn = result.connection || {};
    toast(t('lab.connected', { user: conn.username || '', host: conn.host || '' }));
    await refreshDiagnosticsPane(tutorialKey);
  } catch (e) {
    handleError(e, {
      feature: 'lab',
      message: t('lab.connectFailed', { error: e.message }),
      notify: true,
    });
  }
}

async function disconnectSsh(tutorialKey) {
  try {
    status(t('lab.disconnecting'));
    const result = await apiJson('/api/lab/disconnect', {
      tutorial: tutorialKey || undefined,
    });
    await refreshKernelResolution();
    reconnectWS({ reason: 'this-computer' });
    refreshFileTree(false);
    toast(state.player?.local_lab_supported === false ? t('lab.disconnected') : t('lab.disconnectedLocal'));
    await refreshDiagnosticsPane(tutorialKey);
    return result;
  } catch (e) {
    handleError(e, {
      feature: 'lab',
      message: t('lab.disconnectFailed', { error: e.message }),
      notify: true,
    });
  }
}

function formatProbeTools(commands) {
  if (!commands || typeof commands !== 'object') return '—';
  return Object.entries(commands)
    .map(([name, version]) => `${name}:${version || 'missing'}`)
    .join(' ') || '—';
}

export async function refreshDiagnosticsPane(tutorialKey) {
  const pane = document.getElementById('pane-diagnostics');
  if (!pane) return;
  pane.innerHTML = `<div class="aux-empty"><span>${t('panels.diagnosticsLoading')}</span></div>`;
  try {
    const connection = tutorialKey
      ? null
      : await apiGet('/api/lab/connection');
    if (!tutorialKey) {
      pane.innerHTML = `${renderSshForm(connection)}
        <div class="aux-empty"><span>${t('diagnostics.openTutorial')}</span></div>`;
      bindSshForm(null);
      return;
    }
    const data = await apiGet(`/api/diagnostics?tutorial=${encodeURIComponent(tutorialKey)}`);
    const selected = data.resolution?.selected;
    const candidates = (data.resolution?.candidates || [])
      .map(c => `${c.id}${c.compatible ? '' : ' (incompatible)'}${c.recommended ? ' ★' : ''}`)
      .slice(0, 8);
    const missing = (selected && data.resolution?.candidates?.find(c => c.id === selected.id)) || {};
    pane.innerHTML = `
      ${renderSshForm({ ...(data.connection || {}), player: data.player || data.connection?.player })}
      <div class="diag-block">
        <h4>Package</h4>
        ${kv([
          ['id', data.package?.id],
          ['version', data.package?.version],
          ['source', `${data.package?.source_type || ''} ${data.package?.source_key || ''}`.trim()],
          ['digest', data.package?.digest],
          ['sandbox', data.package?.security?.sandbox_required ? 'required' : 'optional'],
          ['network', data.package?.security?.network_required ? 'required' : 'disabled'],
        ])}
      </div>
      <div class="diag-block">
        <h4>Trust</h4>
        ${kv([
          ['state', data.trust?.trust],
          ['default', data.trust?.default ? 'yes' : 'no'],
        ])}
      </div>
      <div class="diag-block">
        <h4>Kernel</h4>
        ${kv([
          ['selected', selected?.id],
          ['preferred', data.preferred_kernel_id],
          ['network need', data.resolution?.network_required ? 'yes' : 'no'],
          ['provider', data.runtime?.provider],
          ['network mode', data.runtime?.network_mode],
          ['sandbox', data.runtime?.sandbox_preset],
          ['publish', (data.runtime?.publish_ports || []).join(', ') || '-'],
          ['image', data.runtime?.image],
        ])}
        <ul class="diag-list">${candidates.map(c => `<li>${escapeAttr(c)}</li>`).join('') || '<li>—</li>'}</ul>
      </div>
      <div class="diag-block">
        <h4>Runtime session</h4>
        ${kv([
          ['ready', data.runtime?.session_ready ? 'yes' : 'no'],
          ['probe', data.runtime?.probe
            ? `${data.runtime.probe.ok ? 'ok' : 'not ready'} (${data.runtime.probe.reason || '—'})`
            : '—'],
          ['tools', formatProbeTools(data.runtime?.probe?.details?.commands)],
          ['player', data.player?.platform || state.player?.platform || '—'],
          ['active kernel', data.runtime?.active_kernel_id],
          ['fingerprint', data.runtime?.active_fingerprint],
          ['port map', JSON.stringify(data.runtime?.port_map || {})],
        ])}
      </div>
      <div class="diag-block">
        <h4>Selected candidate notes</h4>
        ${kv([
          ['missing caps', (missing.missing_capabilities || []).join(', ') || '-'],
          ['missing cmds', (missing.missing_commands || []).join(', ') || '-'],
          ['version miss', (missing.version_mismatches || []).map(v => `${v.command}:${v.required}`).join(', ') || '-'],
        ])}
      </div>
    `;
    bindSshForm(tutorialKey);
  } catch (e) {
    pane.innerHTML = `<div class="aux-empty" style="color:var(--error)">${escapeAttr(e.message)}</div>`;
  }
}
