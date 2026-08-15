/**
 * Workspace placement is logically owned by MultiLab, but the physical
 * location and IO strategy are chosen by the runtime provider.
 *
 * Official lab machine is a Docker container. The player (Windows/Linux Node)
 * owns host save as durable truth and syncs only the current step into the
 * container workspace:
 *   bind-mount — Linux ext4 (and WSL ext4): host save tree is the live disk
 *   copy       — Windows NTFS / /mnt/c: RuntimeSession writeFiles/readFiles
 *
 * Do not bind-mount /mnt/c. Do not use the student's own WSL distro as a lab.
 * host-local remains an unused strategy kind, not a product path.
 */

import { execFileSync } from 'child_process';
import { mkdirSync } from 'fs';

export const WORKSPACE_STRATEGY_KINDS = Object.freeze({
  RUNTIME_INTERNAL: 'runtime-internal',
  BIND_MOUNT: 'bind-mount',
  VOLUME_SYNC: 'volume-sync',
  HOST_LOCAL: 'host-local',
});

export const DEFAULT_WORKSPACE_LOCATION = '/home/student/workspace';
export const SAVES_BIND_TARGET = '/home/student/.mlab-saves';

const FAST_LOCAL_FS = new Set([
  'ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'tmpfs', 'zfs', 'overlay',
]);

export function describeRuntimeInternalStrategy({
  location = DEFAULT_WORKSPACE_LOCATION,
  reason = 'fallback',
} = {}) {
  return {
    kind: WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL,
    location,
    hostPath: null,
    fallback: true,
    watch: 'find-polling',
    reason,
    capabilities: {
      fileOpsViaSession: true,
      nativeWatch: false,
      hostBindMount: false,
      hostReadable: false,
    },
  };
}

export function describeBindMountStrategy({
  location = DEFAULT_WORKSPACE_LOCATION,
  hostPath,
  bindTarget = null,
  fsType = null,
  watch = 'host-fs',
} = {}) {
  if (!hostPath) {
    throw new Error('describeBindMountStrategy requires hostPath');
  }
  return {
    kind: WORKSPACE_STRATEGY_KINDS.BIND_MOUNT,
    location,
    hostPath,
    bindTarget: bindTarget || location,
    fallback: false,
    watch,
    fsType,
    reason: fsType ? `linux-${fsType}` : 'linux-bind',
    capabilities: {
      fileOpsViaSession: false,
      nativeWatch: watch === 'host-fs',
      hostBindMount: true,
      hostReadable: true,
    },
  };
}

export function describeHostLocalStrategy({
  location = DEFAULT_WORKSPACE_LOCATION,
  hostPath,
  reason = 'host-local',
} = {}) {
  if (!hostPath) {
    throw new Error('describeHostLocalStrategy requires hostPath');
  }
  return {
    kind: WORKSPACE_STRATEGY_KINDS.HOST_LOCAL,
    location,
    hostPath,
    bindTarget: null,
    fallback: false,
    watch: 'host-fs',
    reason,
    capabilities: {
      fileOpsViaSession: false,
      nativeWatch: true,
      hostBindMount: false,
      hostReadable: true,
    },
  };
}

export function isLikelyWindowsDriveMount(hostPath) {
  return /(^|\/)mnt\/[a-zA-Z](\/|$)/.test(String(hostPath || '').replace(/\\/g, '/'));
}

export function probeHostFsType(targetPath) {
  try {
    mkdirSync(targetPath, { recursive: true });
  } catch {
    // probe can still succeed if the parent is readable
  }
  try {
    const out = execFileSync('findmnt', ['-n', '-o', 'FSTYPE', '--target', targetPath], {
      encoding: 'utf8',
      timeout: 1500,
    });
    return String(out).trim().split('\n')[0].trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

export function isFastLocalFs(fsType) {
  return FAST_LOCAL_FS.has(String(fsType || '').toLowerCase());
}

/**
 * Choose Docker workspace placement.
 * `mode`: auto | bind-mount | runtime-internal  (WORKSPACE_STRATEGY)
 */
export function chooseDockerWorkspaceStrategy({
  location = DEFAULT_WORKSPACE_LOCATION,
  hostPath = null,
  bindTarget = SAVES_BIND_TARGET,
  mode = 'auto',
  platform = process.platform,
} = {}) {
  const normalizedMode = String(mode || 'auto').toLowerCase();
  if (normalizedMode === 'runtime-internal' || normalizedMode === 'internal') {
    return describeRuntimeInternalStrategy({ location, reason: 'forced' });
  }
  if (platform !== 'linux') {
    return describeRuntimeInternalStrategy({ location, reason: `platform:${platform}` });
  }
  if (!hostPath) {
    return describeRuntimeInternalStrategy({ location, reason: 'no-host-path' });
  }
  if (isLikelyWindowsDriveMount(hostPath)) {
    return describeRuntimeInternalStrategy({ location, reason: 'windows-drive' });
  }

  const fsType = probeHostFsType(hostPath);
  if (normalizedMode === 'bind-mount') {
    return describeBindMountStrategy({ location, hostPath, bindTarget, fsType });
  }
  if (!isFastLocalFs(fsType)) {
    return describeRuntimeInternalStrategy({
      location,
      reason: `fs:${fsType || 'unknown'}`,
    });
  }
  return describeBindMountStrategy({ location, hostPath, bindTarget, fsType });
}

export function resolveWorkspaceStrategy({
  provider = null,
  kernel = null,
  session = null,
  workspaceDir = DEFAULT_WORKSPACE_LOCATION,
} = {}) {
  if (typeof provider?.workspaceStrategy === 'function') {
    return provider.workspaceStrategy(kernel);
  }
  if (session?.workspaceStrategy) {
    return session.workspaceStrategy;
  }
  const location = session?.workspaceDir
    || kernel?.workspace
    || workspaceDir
    || DEFAULT_WORKSPACE_LOCATION;
  return describeRuntimeInternalStrategy({ location });
}

export function usesHostFilesystem(strategy) {
  return Boolean(strategy?.capabilities?.hostReadable && strategy.hostPath);
}
