/**
 * Fallback workspace watcher: poll `find` through RuntimeSession.exec.
 *
 * This is the current Docker/WSL/SSH path because those environments ship
 * coreutils and do not require a MultiLab-specific in-kernel agent.
 * Providers with native watch (host fs.watch, inotify, sync events) should
 * override RuntimeSession.watchFilesystem instead of using this helper.
 *
 * onChange() fires when the set of file/dir paths changes. Content edits to
 * an existing file do not fire — the file tree reflects structure, not bytes.
 *
 * @returns {{ stop: () => void }}
 */
export function createFindPollingWatcher(
  session,
  onChange,
  { intervalMs = 1000, maxDepth = 6, workspaceDir } = {},
) {
  if (typeof onChange !== 'function') {
    throw new TypeError('createFindPollingWatcher: onChange must be a function');
  }
  if (typeof session?.exec !== 'function') {
    throw new Error('createFindPollingWatcher: session.exec is required');
  }
  const root = workspaceDir || session.workspaceDir;
  if (!root) {
    throw new Error('createFindPollingWatcher: workspaceDir is required');
  }

  // -H: follow a symlink start path (workspace may point at a save dir)
  // without following symlinks inside the tree.
  const cmd = [
    'find', '-H', root,
    '-maxdepth', String(maxDepth), '-mindepth', '1',
    '(', '-type', 'f', '-o', '-type', 'd', ')',
    '-printf', '%y\t%P\n',
  ];

  let timer = null;
  let lastSignature = null;
  let inFlight = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await session.exec(cmd, { cwd: '/' });
      if (stopped) return;
      if (result.exitCode !== 0) return;
      const signature = result.stdout;
      if (lastSignature !== null && signature !== lastSignature) {
        onChange();
      }
      lastSignature = signature;
    } catch {
      // swallow — next tick retries
    } finally {
      inFlight = false;
    }
  };

  tick();
  timer = setInterval(tick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
