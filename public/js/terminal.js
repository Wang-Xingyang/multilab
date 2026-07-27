import { state, TERM_THEME } from './state.js';
import { toast, status } from './ui.js';
import { t } from './messages.js';

// ========== xterm ==========
// xterm 全局由 /vendor 脚本提供;若加载失败不要让整个模块图崩掉。
// 导出为显式 initTerminal(), 由 app.js 调用。
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
    state.term.onData((data) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
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
  state.ws.onopen = () => status(t('ws.connected'));
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') { if (state.term) state.term.write(msg.data); }
    else if (msg.type === 'exit') { if (state.term) state.term.write(`\r\n\x1b[90m${t('ws.processExit', { code: msg.code })}\x1b[0m\r\n`); }
    else if (msg.type === 'status') status(msg.message);
    else if (msg.type === 'ready') status(t('ws.ready'));
    else if (msg.type === 'error') {
      if (msg.code === 'runtime_replaced') {
        toast(t('ws.runtimeReplaced'));
        reconnectWS({ reason: 'runtime replaced' });
        return;
      }
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
