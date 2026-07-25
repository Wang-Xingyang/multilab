import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import crypto from 'crypto';
import yauzl from 'yauzl';

export class MlabArchiveService {
  async inspectArchive(packagePath) {
    const files = await readArchiveFiles(packagePath);
    const manifestBuffer = files.get('multilab.json');
    if (!manifestBuffer) {
      throw Object.assign(new Error('missing multilab.json at package root'), { statusCode: 400 });
    }
    const manifest = JSON.parse(manifestBuffer.toString('utf8'));
    const digest = computeDigest(files);
    return {
      id: manifest.id,
      version: manifest.version || '0.0.0',
      digest,
      files: files.size,
      manifest,
    };
  }

  async unpackArchive(packagePath, outputDir) {
    const files = await readArchiveFiles(packagePath);
    if (!files.has('multilab.json')) {
      throw Object.assign(new Error('missing multilab.json at package root'), { statusCode: 400 });
    }
    const resolvedOutput = path.resolve(outputDir);
    if (await pathExists(resolvedOutput)) {
      throw Object.assign(new Error(`output directory already exists: ${resolvedOutput}`), { statusCode: 409 });
    }

    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multilab-unpack-'));
    try {
      for (const [relPath, content] of files) {
        const target = path.resolve(tempDir, relPath);
        if (target !== tempDir && !target.startsWith(tempDir + path.sep)) {
          throw Object.assign(new Error(`unsafe archive path: ${relPath}`), { statusCode: 400 });
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
      await fs.rename(tempDir, resolvedOutput);
    } catch (e) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw e;
    }

    const manifest = JSON.parse(files.get('multilab.json').toString('utf8'));
    return {
      output: resolvedOutput,
      id: manifest.id,
      version: manifest.version || '0.0.0',
      digest: computeDigest(files),
      files: files.size,
    };
  }
}

async function readArchiveFiles(packagePath) {
  const resolved = path.resolve(packagePath);
  const zipFile = await openZip(resolved);
  const files = new Map();

  try {
    return await new Promise((resolve, reject) => {
      zipFile.readEntry();
      zipFile.on('entry', async entry => {
        try {
          if (/\/$/.test(entry.fileName)) {
            zipFile.readEntry();
            return;
          }
          const relPath = safeArchivePath(entry.fileName);
          if (files.has(relPath)) {
            throw Object.assign(new Error(`duplicate archive path: ${relPath}`), { statusCode: 400 });
          }
          files.set(relPath, await readEntry(zipFile, entry));
          zipFile.readEntry();
        } catch (e) {
          reject(e);
        }
      });
      zipFile.on('end', () => resolve(files));
      zipFile.on('error', reject);
    });
  } finally {
    zipFile.close();
  }
}

function openZip(packagePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(packagePath, { lazyEntries: true }, (err, zipFile) => {
      if (err) reject(Object.assign(err, { statusCode: 400 }));
      else resolve(zipFile);
    });
  });
}

function readEntry(zipFile, entry) {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function safeArchivePath(name) {
  if (!name || name.startsWith('/') || name.includes('\\')) {
    throw Object.assign(new Error(`unsafe archive path: ${name}`), { statusCode: 400 });
  }
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw Object.assign(new Error(`unsafe archive path: ${name}`), { statusCode: 400 });
  }
  return parts.join('/');
}

function computeDigest(files) {
  const hash = crypto.createHash('sha256');
  for (const relPath of Array.from(files.keys()).sort()) {
    const content = files.get(relPath);
    hash.update('file\0');
    hash.update(relPath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

