/**
 * Unified HTTP layer for the frontend.
 *
 * All network calls should go through these helpers so that:
 *  - error normalization (statusCode / code / payload) is consistent;
 *  - GET / DELETE / blob download paths reuse the same error shape as POST JSON;
 *  - callers can branch on `err.code` (e.g. "package_missing") regardless of verb.
 */

function buildError(res, payload) {
  const err = new Error(payload?.error || `HTTP ${res.status}`);
  err.statusCode = res.status;
  err.code = payload?.code;
  err.package = payload?.package;
  err.payload = payload;
  return err;
}

async function readJson(res) {
  return res.json().catch(() => ({}));
}

export async function apiJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readJson(res);
  if (!res.ok) throw buildError(res, payload);
  return payload;
}

export async function apiGet(url) {
  const res = await fetch(url);
  const payload = await readJson(res);
  if (!res.ok) throw buildError(res, payload);
  return payload;
}

export async function apiDelete(url) {
  const res = await fetch(url, { method: 'DELETE' });
  const payload = await readJson(res);
  if (!res.ok) throw buildError(res, payload);
  return payload;
}

/**
 * POST JSON, expect a binary (blob) response with an optional
 * Content-Disposition filename. Used for browser-download endpoints
 * such as /api/saves/download.
 */
export async function apiPostBlob(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await readJson(res);
    throw buildError(res, payload);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  return { blob, filename: match?.[1] || null };
}

export async function uploadArchive(url, file) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: file,
  });
  const payload = await readJson(res);
  if (!res.ok) throw buildError(res, payload);
  return payload;
}
