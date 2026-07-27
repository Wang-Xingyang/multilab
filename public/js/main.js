// 启动兜底: app.js (及其依赖链) 加载失败时显示错误。
// 注意: 此处不能静态 import messages.js —— 若 messages 自身加载失败会再次抛错,
// 所以动态尝试获取 t(), 失败则回退到原始 key, 保证兜底永远能渲染。
import('./app.js').catch(async (err) => {
  console.error('[MultiLab] boot failed:', err);
  let t = (k) => k;
  try { ({ t } = await import('./messages.js')); } catch { /* messages 不可用, 用 key 兜底 */ }
  const msg = err?.message || String(err);
  const loading = document.getElementById('loading-msg');
  if (loading) {
    loading.textContent = t('boot.bootFailed', { error: msg });
    loading.style.color = 'var(--error)';
    loading.style.pointerEvents = 'auto';
    loading.style.whiteSpace = 'pre-wrap';
    loading.style.maxWidth = '80vw';
  }
  const panel = document.getElementById('tutorial-content');
  if (panel) {
    panel.innerHTML =
      `<div class="tutorial-placeholder error">
        <div class="ph-title">${t('boot.bootFailed', { error: msg })}</div>
        <div class="ph-hint">${t('boot.f12Hint')}</div>
      </div>`;
  }
});
