import('./app.js').catch((err) => {
  console.error('[MultiLab] boot failed:', err);
  const msg = err?.message || String(err);
  const loading = document.getElementById('loading-msg');
  if (loading) {
    loading.textContent = `前端启动失败: ${msg}`;
    loading.style.color = 'var(--error)';
    loading.style.pointerEvents = 'auto';
    loading.style.whiteSpace = 'pre-wrap';
    loading.style.maxWidth = '80vw';
  }
  const panel = document.getElementById('tutorial-content');
  if (panel) {
    panel.innerHTML = `<p style="color:var(--error)">前端启动失败: ${msg}</p>
      <p style="color:var(--text-dim);margin-top:8px">按 F12 打开开发者工具查看 Console / Network。</p>`;
  }
});
