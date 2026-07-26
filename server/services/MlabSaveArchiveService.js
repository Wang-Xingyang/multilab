import path from 'path';
import fs from 'fs/promises';
import zlib from 'zlib';
import yauzl from 'yauzl';

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
    await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
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

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.content);
    const crc = crc32(entry.content);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc >>> 0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc >>> 0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await fs.writeFile(outputPath, Buffer.concat([...localParts, ...centralParts, end]));
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
