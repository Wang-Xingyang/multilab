/**
 * Tutorial Markdown renderer.
 *
 * Owns: marked parse, restricted HTML sanitize, package-relative image rewrite,
 * copyable fenced code / command blocks. Does not own step navigation or
 * workspace files. Player chrome (copy buttons) is added after sanitize so
 * package HTML cannot inject it.
 */
import { t } from './messages.js';
import { toast } from './ui.js';

export const COMMAND_LANGS = new Set([
  'bash', 'sh', 'shell', 'console', 'terminal', 'zsh', 'fish',
]);

const TUTORIAL_PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'blockquote',
    'ul', 'ol', 'li',
    'pre', 'code',
    'em', 'strong', 'b', 'i', 'del', 'ins', 'sub', 'sup',
    'a', 'img',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span', 'div',
  ],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class'],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: [
    'script', 'style', 'iframe', 'object', 'embed', 'form', 'input',
    'textarea', 'button', 'link', 'meta', 'base', 'svg', 'math',
    'video', 'audio', 'source', 'canvas',
  ],
};

const COPY_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

export function isCommandLang(lang) {
  return COMMAND_LANGS.has(String(lang || '').toLowerCase());
}

/** Image src → same-origin asset URL, inline raster data URI, or null (drop). */
export function rewriteAssetHref(href, { sourceKey, stepId } = {}) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (raw.startsWith('/api/tutorials/')) return raw;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(raw)) return raw;
  if (raw.startsWith('#') || raw.startsWith('//')) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  if (!sourceKey) return null;
  const params = new URLSearchParams({ path: raw.replace(/\\/g, '/') });
  if (stepId) params.set('step', stepId);
  return `/api/tutorials/${encodeURIComponent(sourceKey)}/assets?${params.toString()}`;
}

/** Keep in-page anchors and user-initiated http(s)/mailto. Drop relative file links. */
export function rewriteLinkHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) return raw;
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) return raw;
  return null;
}

export function markdownToSafeHtml(markdown, deps = {}) {
  const parse = deps.parse || (typeof marked !== 'undefined'
    ? (md, opts) => marked.parse(md, opts)
    : null);
  const sanitize = deps.sanitize || (typeof DOMPurify !== 'undefined'
    ? (html, cfg) => DOMPurify.sanitize(html, cfg)
    : null);
  if (!parse) throw new Error('marked is not available');
  const html = parse(String(markdown || ''), {
    gfm: true,
    breaks: false,
    headerIds: false,
    mangle: false,
  });
  if (!sanitize) return html;
  return sanitize(html, TUTORIAL_PURIFY_CONFIG);
}

export function applyTutorialDomRewrites(root, ctx = {}) {
  root.querySelectorAll('img').forEach(img => {
    const next = rewriteAssetHref(img.getAttribute('src'), ctx);
    if (next) img.setAttribute('src', next);
    else img.remove();
  });
  root.querySelectorAll('a[href]').forEach(a => {
    const next = rewriteLinkHref(a.getAttribute('href'));
    if (!next) {
      a.replaceWith(...a.childNodes);
      return;
    }
    a.setAttribute('href', next);
    if (!next.startsWith('#')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function copyButtonLabel(copied) {
  return copied ? t('content.copied') : t('content.copy');
}

function setCopyButtonState(btn, copied) {
  btn.innerHTML = copied ? CHECK_ICON : COPY_ICON;
  btn.title = copyButtonLabel(copied);
  btn.setAttribute('aria-label', copyButtonLabel(copied));
  btn.classList.toggle('is-copied', copied);
}

export function enhanceCodeBlocks(root) {
  root.querySelectorAll('pre').forEach(pre => {
    if (pre.closest('.md-block')) return;
    const wrap = document.createElement('div');
    wrap.className = 'md-block';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'md-copy-btn';
    setCopyButtonState(btn, false);
    pre.parentNode.insertBefore(wrap, pre);
    wrap.append(btn, pre);
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

export function bindTutorialContent(root) {
  if (root.dataset.copyBound === '1') return;
  root.dataset.copyBound = '1';
  root.addEventListener('click', async event => {
    const btn = event.target.closest('.md-copy-btn');
    if (!btn || !root.contains(btn)) return;
    const block = btn.closest('.md-block');
    const pre = block?.querySelector('pre');
    const text = (pre?.querySelector('code') || pre)?.textContent || '';
    try {
      await copyText(text);
      setCopyButtonState(btn, true);
      window.setTimeout(() => {
        if (btn.isConnected) setCopyButtonState(btn, false);
      }, 1500);
    } catch {
      toast(t('content.copyFailed'), true);
    }
  });
}

export function renderTutorialMarkdown(container, markdown, ctx = {}) {
  bindTutorialContent(container);
  container.innerHTML = markdownToSafeHtml(markdown);
  applyTutorialDomRewrites(container, ctx);
  enhanceCodeBlocks(container);
}
