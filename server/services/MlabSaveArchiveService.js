import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

export class MlabSaveArchiveService {
  constructor({ saveService }) {
    this.saveService = saveService;
  }

  async exportArchive(tutorialKey, outputPath) {
    if (!outputPath) {
      throw Object.assign(new Error('path required'), { statusCode: 400 });
    }
    const bundle = await this.saveService.collectSaveBundle(tutorialKey);
    const resolvedOutput = path.resolve(outputPath);
    if (!resolvedOutput.endsWith('.mlab-save')) {
      throw Object.assign(new Error('output path must end with .mlab-save'), { statusCode: 400 });
    }
    await fsp.mkdir(path.dirname(resolvedOutput), { recursive: true });
    await writeZipArchive(resolvedOutput, bundle.files);
    return {
      path: resolvedOutput,
      source_key: bundle.source_key,
      package: bundle.package,
      progress: {
        current_step: bundle.metadata.current_step,
        visited: bundle.metadata.visited,
        test_passed: bundle.metadata.test_passed,
        updated_at: bundle.metadata.updated_at,
      },
      files: bundle.files.size,
    };
  }

  async importArchive(archivePath) {
    if (!archivePath) {
      throw Object.assign(new Error('path required'), { statusCode: 400 });
    }
    const files = await readArchiveFiles(path.resolve(archivePath));
    const saveJson = files.get('save.json');
    if (!saveJson) {
      throw Object.assign(new Error('missing save.json at archive root'), { statusCode: 400 });
    }

    let metadata;
    try {
      metadata = JSON.parse(saveJson.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid save.json'), { statusCode: 400 });
    }

    return this.saveService.applySaveBundle({ metadata, files });
  }
}

async function readArchiveFiles(archivePath) {
  const zipFile = await openZip(archivePath);
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

function openZip(archivePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipFile) => {
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

async function writeZipArchive(outputPath, files) {
  const entries = Array.from(files.entries())
    .map(([name, content]) => ({
      name: safeArchivePath(name),
      content: Buffer.isBuffer(content) ? content : Buffer.from(String(content || ''), 'utf8'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const zipFile = new yazl.ZipFile();
  for (const entry of entries) {
    zipFile.addBuffer(entry.content, entry.name);
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    output.on('close', resolve);
    output.on('error', reject);
    zipFile.outputStream.on('error', reject);
    zipFile.outputStream.pipe(output);
    zipFile.end();
  });
}
