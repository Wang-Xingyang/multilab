import path from 'path';
import fs from 'fs/promises';

export class PackageLibrary {
  constructor({ libraryDir, archiveService }) {
    this.libraryDir = libraryDir;
    this.archiveService = archiveService;
  }

  async listPackages() {
    const records = [];
    const packageIds = await safeReadDir(this.libraryDir);
    for (const idEntry of packageIds) {
      if (!idEntry.isDirectory()) continue;
      const id = idEntry.name;
      const versions = await safeReadDir(path.join(this.libraryDir, id));
      for (const versionEntry of versions) {
        if (!versionEntry.isDirectory()) continue;
        const version = versionEntry.name;
        const digests = await safeReadDir(path.join(this.libraryDir, id, version));
        for (const digestEntry of digests) {
          if (!digestEntry.isDirectory()) continue;
          const root = path.join(this.libraryDir, id, version, digestEntry.name);
          const lock = await readJson(path.join(root, 'package.lock.json')).catch(() => null);
          if (lock) records.push(lock);
        }
      }
    }
    return records.sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
  }

  async importArchive(packagePath) {
    const inspected = await this.archiveService.inspectArchive(packagePath);
    const id = validateStorageSegment(inspected.id || 'unknown', 'package id');
    const version = validateStorageSegment(inspected.version || '0.0.0', 'package version');
    const digestSegment = digestPathSegment(inspected.digest);
    const packageRoot = path.join(this.libraryDir, id, version, digestSegment);
    const unpackedDir = path.join(packageRoot, 'unpacked');
    const lockPath = path.join(packageRoot, 'package.lock.json');

    if (!(await pathExists(unpackedDir))) {
      await fs.mkdir(packageRoot, { recursive: true });
      await this.archiveService.unpackArchive(packagePath, unpackedDir);
    }

    const record = {
      id,
      version,
      digest: inspected.digest,
      package_format: 'mlab',
      imported_at: new Date().toISOString(),
      source: path.resolve(packagePath),
      files: inspected.files,
      unpacked_dir: unpackedDir,
    };
    await fs.writeFile(lockPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return record;
  }
}

function digestPathSegment(digest) {
  const segment = String(digest || '').replace(/^sha256:/, 'sha256-');
  if (!/^[a-zA-Z0-9_.-]+$/.test(segment)) {
    throw Object.assign(new Error('Invalid package digest'), { statusCode: 400 });
  }
  return segment;
}

function validateStorageSegment(value, fieldName) {
  const segment = String(value || '');
  if (!segment || segment.includes('..') || !/^[a-zA-Z0-9_.+-]+$/.test(segment)) {
    throw Object.assign(new Error(`Invalid ${fieldName}`), { statusCode: 400 });
  }
  return segment;
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

