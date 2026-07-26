import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export async function withUploadedArchive(buffer, filename, suffix, fn) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('empty upload body'), { statusCode: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`), { statusCode: 413 });
  }

  const safeName = sanitizeUploadFilename(filename, suffix);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-upload-'));
  const tempPath = path.join(tempDir, safeName);
  try {
    await fs.writeFile(tempPath, buffer);
    return await fn(tempPath, safeName);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export function sanitizeUploadFilename(filename, requiredSuffix) {
  const base = path.basename(String(filename || '')).replace(/[^\w.-]+/g, '_');
  if (!base || base === '.' || base === '..') {
    throw Object.assign(new Error('invalid upload filename'), { statusCode: 400 });
  }
  if (!base.toLowerCase().endsWith(requiredSuffix)) {
    throw Object.assign(new Error(`filename must end with ${requiredSuffix}`), { statusCode: 400 });
  }
  return base;
}

export const UPLOAD_LIMIT = MAX_UPLOAD_BYTES;
