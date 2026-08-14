import path from 'path';
import fs from 'fs/promises';
import { validateFileName } from '../services/PackageService.js';
import { parseFindTreeOutput, sortWorkspaceTreeEntries } from './WorkspaceTree.js';

const DIR_MODE = 0o777;
const FILE_MODE = 0o666;

export function containerPathToHost(strategy, containerPath) {
  const location = strategy.location;
  const hostRoot = path.resolve(strategy.hostPath);
  const raw = containerPath || location;
  const joined = String(raw).startsWith('/') ? raw : path.posix.join(location, raw);
  const resolved = path.posix.resolve(joined);
  if (resolved !== location && !resolved.startsWith(`${location}/`)) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
  const relative = resolved === location ? '' : resolved.slice(location.length + 1);
  const hostPath = relative
    ? path.resolve(hostRoot, ...relative.split('/'))
    : hostRoot;
  if (hostPath !== hostRoot && !hostPath.startsWith(`${hostRoot}${path.sep}`)) {
    throw Object.assign(new Error('Access denied'), { statusCode: 403 });
  }
  return { hostPath, relative, containerPath: resolved };
}

export async function ensureHostWorkspaceDir(hostPath) {
  await fs.mkdir(hostPath, { recursive: true, mode: DIR_MODE });
  await fs.chmod(hostPath, DIR_MODE).catch(() => {});
}

async function clearHostDirContents(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.map(entry => (
    fs.rm(path.join(dir, entry.name), { recursive: true, force: true })
  )));
}

export async function writeHostWorkspaceFiles(strategy, files, { clear = true } = {}) {
  await ensureHostWorkspaceDir(strategy.hostPath);
  if (clear !== false) await clearHostDirContents(strategy.hostPath);
  for (const file of files || []) {
    const name = validateFileName(file.name || 'untitled');
    const dest = path.join(strategy.hostPath, name);
    await fs.writeFile(dest, file.content || '', { encoding: 'utf8', mode: FILE_MODE });
    await fs.chmod(dest, FILE_MODE).catch(() => {});
  }
}

export async function readHostWorkspaceFiles(strategy) {
  await ensureHostWorkspaceDir(strategy.hostPath);
  const entries = await fs.readdir(strategy.hostPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries.filter(item => item.isFile()).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = validateFileName(entry.name);
    files.push({
      name,
      content: await fs.readFile(path.join(strategy.hostPath, name), 'utf8'),
    });
  }
  return files;
}

export async function listHostWorkspaceFiles(strategy, dir) {
  const mapped = containerPathToHost(strategy, dir || strategy.location);
  const entries = await fs.readdir(mapped.hostPath, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => {
      validateFileName(entry.name);
      return { name: entry.name, type: 'file' };
    });
  return { path: mapped.containerPath, files };
}

export async function listHostWorkspaceTree(strategy, { dir, depth } = {}) {
  const mapped = containerPathToHost(strategy, dir || strategy.location);
  const maxDepth = Math.min(6, Math.max(1, Number(depth) || 4));
  const lines = [];
  await walkHostTree(mapped.hostPath, '', 1, maxDepth, lines);
  const entries = parseFindTreeOutput(
    lines.join(''),
    mapped.containerPath,
    abs => abs,
  );
  sortWorkspaceTreeEntries(entries);
  return { path: mapped.containerPath, tree: true, depth: maxDepth, entries };
}

export async function readHostWorkspaceFile(strategy, filePath) {
  const mapped = containerPathToHost(strategy, filePath);
  const content = await fs.readFile(mapped.hostPath, 'utf8');
  return { path: mapped.containerPath, content };
}

export async function writeHostWorkspaceFile(strategy, filePath, content) {
  const mapped = containerPathToHost(strategy, filePath);
  await fs.mkdir(path.dirname(mapped.hostPath), { recursive: true, mode: DIR_MODE });
  await fs.writeFile(mapped.hostPath, content ?? '', { encoding: 'utf8', mode: FILE_MODE });
  await fs.chmod(mapped.hostPath, FILE_MODE).catch(() => {});
  return { path: mapped.containerPath, saved: true };
}

export async function hostStructureSignature(strategy, { maxDepth = 6 } = {}) {
  const tree = await listHostWorkspaceTree(strategy, { depth: maxDepth });
  return tree.entries.map(entry => `${entry.type}\t${entry.relative}`).join('\n');
}

async function walkHostTree(dir, relative, depth, maxDepth, lines) {
  if (depth > maxDepth) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
    const childRel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      lines.push(`d\t${childRel}\n`);
      await walkHostTree(path.join(dir, entry.name), childRel, depth + 1, maxDepth, lines);
    } else if (entry.isFile()) {
      lines.push(`f\t${childRel}\n`);
    }
  }
}
