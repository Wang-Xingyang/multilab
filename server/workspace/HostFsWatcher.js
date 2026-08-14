import { watch } from 'fs';
import { hostStructureSignature } from './HostWorkspace.js';

/**
 * Host-side structural watcher for bind-mounted workspaces.
 * Debounces bursts, then compares the path set so content-only edits do not
 * fire — matching the find-polling contract.
 *
 * @returns {{ stop: () => void }}
 */
export function createHostFsWatcher(strategy, onChange, { debounceMs = 75, maxDepth = 6 } = {}) {
  if (typeof onChange !== 'function') {
    throw new TypeError('createHostFsWatcher: onChange must be a function');
  }
  if (!strategy?.hostPath) {
    throw new Error('createHostFsWatcher: strategy.hostPath is required');
  }

  let timer = null;
  let lastSignature = null;
  let inFlight = false;
  let stopped = false;

  const compare = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const signature = await hostStructureSignature(strategy, { maxDepth });
      if (stopped) return;
      if (lastSignature !== null && signature !== lastSignature) {
        onChange();
      }
      lastSignature = signature;
    } catch {
      // next event retries
    } finally {
      inFlight = false;
    }
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      compare();
    }, debounceMs);
  };

  // Watch the Docker bind source (saves root) when present — nested watches
  // on a subdirectory of that mount miss container writes on some hosts.
  // Signature compare still uses strategy.hostPath (the current step files/).
  const watchRoots = uniqueExistingPaths([
    strategy.hostPath,
    strategy.bindHostPath,
  ]);
  if (!watchRoots.length) {
    throw new Error('createHostFsWatcher: no watchable host path');
  }

  const watchers = watchRoots.map(root => {
    const watcher = watch(root, { recursive: true }, () => {
      schedule();
    });
    watcher.on('error', () => {
      // Keep the connection alive; the next successful event rescans.
    });
    return watcher;
  });

  compare();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      for (const watcher of watchers) {
        try { watcher.close(); } catch { /* already closed */ }
      }
    },
  };
}

function uniqueExistingPaths(paths) {
  const seen = new Set();
  const out = [];
  for (const raw of paths) {
    if (!raw) continue;
    const resolved = String(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}
