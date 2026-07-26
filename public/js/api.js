export async function apiJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.statusCode = res.status;
    err.code = payload.code;
    err.package = payload.package;
    err.payload = payload;
    throw err;
  }
  return payload;
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
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.error || `HTTP ${res.status}`);
    err.statusCode = res.status;
    err.code = payload.code;
    err.package = payload.package;
    err.payload = payload;
    throw err;
  }
  return payload;
}
