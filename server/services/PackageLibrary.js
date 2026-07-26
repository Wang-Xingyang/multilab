import path from 'path';
import fs from 'fs/promises';
import { packageSourceKey } from './PackageService.js';

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
          if (lock) records.push(this.annotateRecord(lock, root));
        }
      }
    }
    return records.sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`));
  }

  async getPackage({ id, version, digest }) {
    const root = this.packageRoot({ id, version, digest });
    const lock = await readJson(path.join(root, 'package.lock.json')).catch(e => {
      if (e.code === 'ENOENT') {
        throw Object.assign(new Error('package not found'), { statusCode: 404 });
      }
      throw e;
    });
    return this.annotateRecord(lock, root);
  }

  async deletePackage({ id, version, digest }) {
    const root = this.packageRoot({ id, version, digest });
    if (!(await pathExists(root))) {
      throw Object.assign(new Error('package not found'), { statusCode: 404 });
    }
    const record = await this.getPackage({ id, version, digest }).catch(() => ({
      id,
      version,
      digest,
      source_key: packageSourceKey({ digest }),
    }));

    await fs.rm(root, { recursive: true, force: true });
    await removeEmptyParents(root, this.libraryDir);
    return {
      deleted: true,
      id: record.id,
      version: record.version,
      digest: record.digest,
      source_key: record.source_key,
    };
  }

  async importArchive(packagePath, opts = {}) {
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

    const source = opts.source || path.resolve(packagePath);
    const record = {
      id,
      version,
      digest: inspected.digest,
      package_format: 'mlab',
      imported_at: new Date().toISOString(),
      source,
      files: inspected.files,
      unpacked_dir: unpackedDir,
    };
    await fs.writeFile(lockPath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    return this.annotateRecord(record, packageRoot);
  }

  packageRoot({ id, version, digest }) {
    const packageId = validateStorageSegment(id, 'package id');
    const packageVersion = validateStorageSegment(version || '0.0.0', 'package version');
    const digestSegment = digestPathSegment(digest);
    const root = path.resolve(this.libraryDir, packageId, packageVersion, digestSegment);
    if (root !== this.libraryDir && !root.startsWith(this.libraryDir + path.sep)) {
      throw Object.assign(new Error('Invalid package path'), { statusCode: 400 });
    }
    return root;
  }

  annotateRecord(record, root = null) {
    return {
      ...record,
      source_key: packageSourceKey(record),
      source_type: 'installed',
      package_root: root || record.package_root || null,
    };
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

async function removeEmptyParents(startDir, stopDir) {
  let current = path.dirname(startDir);
  const stop = path.resolve(stopDir);
  while (current.startsWith(stop + path.sep) || current === stop) {
    if (current === stop) break;
    const entries = await safeReadDir(current);
    if (entries.length > 0) break;
    await fs.rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

