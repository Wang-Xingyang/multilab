import { state, TERM_THEME } from './state.js';
import { toast, status } from './ui.js';
import { t } from './messages.js';

// ========== xterm ==========
state.term = new Terminal({
  fontFamily: '"JetBrains Mono","Consolas",monospace',
  fontSize: 13, cursorBlink: true, theme: TERM_THEME[state.theme],
});
state.fitAddon = new FitAddon.FitAddon();
state.term.loadAddon(state.fitAddon);
state.term.loadAddon(new WebLinksAddon.WebLinksAddon());
state.term.open(document.getElementById('terminal'));
state.fitAddon.fit();
window.addEventListener('resize', () => state.fitAddon.fit());
state.term.onData((data) => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'input', data }));
});

// ========== WebSocket ==========
function connectWS() {
  state.wsForceClose = false;
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'state.ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws.onopen = () => status(t('ws.connected'));
  state.ws.onmessage = (e) => {
    let msg; try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'output') state.term.write(msg.data);
    else if (msg.type === 'exit') state.term.write(`\r\n\x1b[90m${t('ws.processExit', { code: msg.code })}\x1b[0m\r\n`);
    else if (msg.type === 'status') status(msg.message);
    else if (msg.type === 'ready') status(t('ws.ready'));
    else if (msg.type === 'error') {
      if (msg.code === 'runtime_replaced') {
        toast(t('ws.runtimeReplaced'));
        reconnectWS({ reason: 'runtime replaced' });
        return;
      }
      toast(msg.message, true);
      state.term.write(`\r\n\x1b[31m${t('ws.errorBanner', { error: msg.message })}\x1b[0m\r\n`);
    }
  };
  state.ws.onclose = () => {
    if (state.wsForceClose) return;
    status(t('ws.disconnected'));
    state.wsReconnectTimer = setTimeout(connectWS, 3000);
  };
}

function reconnectWS(opts = {}) {
  state.wsForceClose = true;
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  if (state.ws) {
    try { state.ws.onclose = null; state.ws.close(); } catch {}
  }
  if (opts.reason) {
    state.term.write(`\r\n\x1b[90m${t('ws.reconnectBanner', { reason: opts.reason })}\x1b[0m\r\n`);
  }
  connectWS();
}
connectWS();


export { connectWS, reconnectWS };
