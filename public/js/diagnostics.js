import { escapeAttr } from './ui.js';
import { t } from './messages.js';
import { apiGet } from './api.js';

function kv(rows) {
  return `<div class="diag-kv">${rows.map(([k, v]) =>
    `<div class="k">${escapeAttr(k)}</div><div class="v">${escapeAttr(v ?? '—')}</div>`
  ).join('')}</div>`;
}

export async function refreshDiagnosticsPane(tutorialKey) {
  const pane = document.getElementById('pane-diagnostics');
  if (!pane) return;
  if (!tutorialKey) {
    pane.innerHTML = `<div class="aux-empty"><span>${t('diagnostics.openTutorial')}</span></div>`;
    return;
  }
  pane.innerHTML = `<div class="aux-empty"><span>${t('panels.diagnosticsLoading')}</span></div>`;
  try {
    const data = await apiGet(`/api/diagnostics?tutorial=${encodeURIComponent(tutorialKey)}`);
    const selected = data.resolution?.selected;
    const candidates = (data.resolution?.candidates || [])
      .map(c => `${c.id}${c.compatible ? '' : ' (incompatible)'}${c.recommended ? ' ★' : ''}`)
      .slice(0, 8);
    const missing = (selected && data.resolution?.candidates?.find(c => c.id === selected.id)) || {};
    pane.innerHTML = `
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
  } catch (e) {
    pane.innerHTML = `<div class="aux-empty" style="color:var(--error)">${escapeAttr(e.message)}</div>`;
  }
}
