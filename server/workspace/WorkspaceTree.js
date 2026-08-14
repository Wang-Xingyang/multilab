import path from 'path';

export function parseFindTreeOutput(stdout, dir, validatePath) {
  const entries = [];
  for (const line of String(stdout || '').trim().split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const kind = line.slice(0, tab);
    const rel = line.slice(tab + 1);
    if (!rel || rel.includes('\0') || rel.split('/').some(part => part === '..')) continue;
    const abs = path.posix.join(dir, rel);
    validatePath(abs);
    entries.push({
      name: path.posix.basename(rel),
      path: abs,
      relative: rel,
      type: kind === 'd' ? 'dir' : 'file',
    });
  }
  return entries;
}

export function sortWorkspaceTreeEntries(entries) {
  const dirRels = new Set(entries.filter(entry => entry.type === 'dir').map(entry => entry.relative));
  entries.sort((a, b) => {
    const pa = a.relative.split('/');
    const pb = b.relative.split('/');
    const len = Math.min(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      if (pa[i] !== pb[i]) {
        const aIsDir = dirRels.has(pa.slice(0, i + 1).join('/'));
        const bIsDir = dirRels.has(pb.slice(0, i + 1).join('/'));
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return pa[i].localeCompare(pb[i]);
      }
    }
    return pa.length - pb.length;
  });
  return entries;
}
