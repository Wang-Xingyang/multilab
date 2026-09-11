import { state, TERM_THEME, currentTutorialKey, currentStepObj, stepShellInputAllowed } from './state.js';
import { toast, status } from './ui.js';
import { t } from './messages.js';
import { applyStepCommands } from './panels.js';

// Callback fired when the host reports a real filesystem change (WS
// 'fs_change'). Wired by app.js to trigger a file-tree refresh.
let fsChangeCallback = null;
export function setFileTreeChangeCallback(fn) {
  fsChangeCallback = typeof fn === 'function' ? fn : null;
}

export function applyTerminalInputGate() {
  if (!state.term) return;
  const allowed = stepShellInputAllowed();
  try {
    state.term.options.disableStdin = !allowed;
  } catch {
    // xterm may not be ready yet
  }
}

function copyTerminalSelection() {
  const term = state.term;
  const text = term?.getSelection?.() || '';
  if (!text) return false;
  const onCopy = (event) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    if (!document.execCommand('copy')) throw new Error('copy failed');
    term.clearSelection();
  } catch {
    toast(t('term.copyFailed'), true);
  } finally {
    document.removeEventListener('copy', onCopy);
  }
  return true;
}

function shouldCopyChord(ev) {
  if (ev.altKey || ev.key.toLowerCase() !== 'c') return false;
  if (ev.metaKey && !ev.ctrlKey) return true;
  if (ev.ctrlKey && ev.shiftKey) return true;
  if (ev.ctrlKey && !ev.shiftKey && !ev.metaKey) return state.term?.hasSelection?.();
  return false;
}

function shouldPasteChord(ev) {
  if (ev.altKey || ev.key.toLowerCase() !== 'v') return false;
  if (ev.metaKey && !ev.ctrlKey) return true;
  return Boolean(ev.ctrlKey);
}

export function initTerminal() {
  const host = document.getElementById('terminal');
  if (!host) return;
  if (typeof Terminal === 'undefined') {
    console.error('[MultiLab] xterm Terminal global missing — check /vendor/xterm');
    status(t('ws.xtermMissing'));
    return;
  }
  try {
    state.term = new Terminal({
      fontFamily: '"JetBrains Mono","Consolas",monospace',
      fontSize: 13, cursorBlink: true, theme: TERM_THEME[state.theme],
    });
    state.fitAddon = (typeof FitAddon !== 'undefined') ? new FitAddon.FitAddon() : null;
    if (state.fitAddon) state.term.loadAddon(state.fitAddon);
    if (typeof WebLinksAddon !== 'undefined') {
      state.term.loadAddon(new WebLinksAddon.WebLinksAddon());
    }
    state.term.open(host);
    if (state.fitAddon) state.fitAddon.fit();
    window.addEventListener('resize', () => state.fitAddon && state.fitAddon.fit());
    state.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (shouldCopyChord(ev)) {
        ev.preventDefault();
        copyTerminalSelection();
        return false;
      }
      // Swallow Ctrl+V so xterm does not send ^V / preventDefault the paste event.
      if (shouldPasteChord(ev)) return false;
      return true;
    });
    host.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain') || '';
      event.preventDefault();
      event.stopPropagation();
      if (!text || !stepShellInputAllowed() || !state.term) return;
      state.term.paste(text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
    }, true);
    state.term.onData((data) => {
      if (!stepShellInputAllowed()) return;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: 'input',
          data,
          tutorial: currentTutorialKey(),
          step: currentStepObj()?.id,
          generation: state.currentStepAccess?.generation,
        }));
      }
    });
    applyTerminalInputGate();
  } catch (e) {
    console.error('[MultiLab] terminal init failed:', e);
    state.term = null;
    state.fitAddon = null;
  }
}

// ========== WebSocket ==========
// 导出为显式 initWS(), 由 app.js 调用 (不再顶层 connectWS 副作用)。
export function initWS() {
  state.wsForceClose = false;
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => {
    state.commandBusy = false;
    applyStepCommands();
    status(t('ws.connected'));
  };
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') { if (state.term) state.term.write(msg.data); }
    else if (msg.type === 'command_done') {
      state.commandBusy = false;
      applyStepCommands();
    }
    else if (msg.type === 'fs_change') { if (fsChangeCallback) fsChangeCallback(); }
    else if (msg.type === 'status') status(msg.message);
    else if (msg.type === 'ready') status(t('ws.ready'));
    else if (msg.type === 'error') {
      state.commandBusy = false;
      applyStepCommands();
      if (msg.code === 'runtime_replaced') {
        toast(t('ws.runtimeReplaced'));
        reconnectWS({ reason: 'runtime replaced' });
        return;
      }
      if (msg.code === 'step_inactive' || msg.code === 'step_stale') return;
      toast(msg.message, true);
      if (state.term) state.term.write(`\r\n\x1b[31m${t('ws.errorBanner', { error: msg.message })}\x1b[0m\r\n`);
    }
  };
  state.ws.onclose = () => {
    if (state.wsForceClose) return;
    status(t('ws.disconnected'));
    state.wsReconnectTimer = setTimeout(initWS, 3000);
  };
}

export function reconnectWS(opts = {}) {
  state.wsForceClose = true;
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
  }
  if (opts.reason && state.term) {
    state.term.write(`\r\n\x1b[90m${t('ws.reconnectBanner', { reason: opts.reason })}\x1b[0m\r\n`);
  }
  initWS();
}
