import path from 'path';
import fs from 'fs/promises';
import { validateFileName, validateWorkspaceRelPath } from '../services/PackageService.js';
import { parseFindTreeOutput, sortWorkspaceTreeEntries } from './WorkspaceTree.js';

const DIR_MODE = 0o777;
const FILE_MODE = 0o666;

export function isHostPermissionError(error) {
  return error?.code === 'EACCES' || error?.code === 'EPERM';
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

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

async function relaxHostTree(dir) {
  await fs.chmod(dir, DIR_MODE).catch(() => {});
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..') continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await fs.chmod(child, DIR_MODE).catch(() => {});
      await relaxHostTree(child);
    } else if (entry.isFile()) {
      await fs.chmod(child, FILE_MODE).catch(() => {});
    }
  }
}

async function removeHostDirChildren(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const results = await Promise.allSettled(entries.map(entry => (
    fs.rm(path.join(dir, entry.name), { recursive: true, force: true })
  )));
  const denied = results.find(result => (
    result.status === 'rejected' && isHostPermissionError(result.reason)
  ));
  if (denied) throw denied.reason;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
}

export async function clearHostDirContents(dir) {
  await relaxHostTree(dir);
  await removeHostDirChildren(dir);
}

export async function wipeBindMountViaExec(exec, location) {
  if (typeof exec !== 'function') {
    throw Object.assign(new Error('workspace files are not writable from the host'), { statusCode: 500 });
  }
  const dir = shQuote(location);
  const result = await exec(
    ['bash', '-lc', `chmod -R a+rwX ${dir} && find -H ${dir} -mindepth 1 -maxdepth 1 -exec rm -rf {} +`],
    { user: 'root', cwd: '/' },
  );
  if (result.exitCode !== 0) {
    throw Object.assign(new Error(result.stderr || 'failed to clear workspace'), { statusCode: 500 });
  }
}

export async function relaxBindMountViaExec(exec, location) {
  if (typeof exec !== 'function') return false;
  const result = await exec(
    ['bash', '-lc', `chmod -R a+rwX ${shQuote(location)}`],
    { user: 'root', cwd: '/' },
  );
  return result.exitCode === 0;
}

export async function writeHostWorkspaceFiles(strategy, files, { clear = true } = {}) {
  await ensureHostWorkspaceDir(strategy.hostPath);
  if (clear !== false) await clearHostDirContents(strategy.hostPath);
  for (const file of files || []) {
    const rel = validateWorkspaceRelPath(file.name || 'untitled');
    const dest = path.join(strategy.hostPath, ...rel.split('/'));
    if (file.type === 'dir') {
      await fs.mkdir(dest, { recursive: true, mode: DIR_MODE });
      await fs.chmod(dest, DIR_MODE).catch(() => {});
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: DIR_MODE });
    await fs.writeFile(dest, file.content || '', { encoding: 'utf8', mode: FILE_MODE });
    await fs.chmod(dest, FILE_MODE).catch(() => {});
  }
}

export async function readHostWorkspaceFiles(strategy) {
  await ensureHostWorkspaceDir(strategy.hostPath);
  const files = [];
  await collectHostEntries(strategy.hostPath, '', files);
  return files.sort((a, b) => a.name.localeCompare(b.name));
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
  await fs.chmod(path.dirname(mapped.hostPath), DIR_MODE).catch(() => {});
  await fs.chmod(mapped.hostPath, FILE_MODE).catch(() => {});
  await fs.writeFile(mapped.hostPath, content ?? '', { encoding: 'utf8', mode: FILE_MODE });
  await fs.chmod(mapped.hostPath, FILE_MODE).catch(() => {});
  return { path: mapped.containerPath, saved: true };
}

export async function hostStructureSignature(strategy, { maxDepth = 6 } = {}) {
  const tree = await listHostWorkspaceTree(strategy, { depth: maxDepth });
  return tree.entries.map(entry => `${entry.type}\t${entry.relative}`).join('\n');
}

async function collectHostEntries(dir, relative, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === '.' || entry.name === '..' || entry.isSymbolicLink()) continue;
    const childRel = relative ? `${relative}/${entry.name}` : entry.name;
    try {
      validateWorkspaceRelPath(childRel);
    } catch {
      continue;
    }
    if (entry.isDirectory()) {
      out.push({ name: childRel, type: 'dir' });
      await collectHostEntries(path.join(dir, entry.name), childRel, out);
    } else if (entry.isFile()) {
      out.push({
        name: childRel,
        type: 'file',
        content: await fs.readFile(path.join(dir, entry.name), 'utf8'),
      });
    }
  }
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
