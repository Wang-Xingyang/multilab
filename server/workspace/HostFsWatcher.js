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

  const watcher = watch(strategy.hostPath, { recursive: true }, () => {
    schedule();
  });
  watcher.on('error', () => {
    // Keep the connection alive; the next successful event rescans.
  });

  compare();

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { watcher.close(); } catch { /* already closed */ }
    },
  };
}
