/**
 * Workspace placement is logically owned by MultiLab, but the physical
 * location and IO strategy are chosen by the runtime provider.
 *
 * Current Docker path: runtime-internal (files live inside the container,
 * accessed via RuntimeSession exec). That is a fallback, not the target.
 *
 * Later strategies:
 *   bind-mount   — Linux Docker bind-mount a host workspace
 *   volume-sync  — Docker Desktop Windows/macOS volume or copy/sync
 *   host-local   — trusted-only local provider on the host filesystem
 */

export const WORKSPACE_STRATEGY_KINDS = Object.freeze({
  RUNTIME_INTERNAL: 'runtime-internal',
  BIND_MOUNT: 'bind-mount',
  VOLUME_SYNC: 'volume-sync',
  HOST_LOCAL: 'host-local',
});

export const DEFAULT_WORKSPACE_LOCATION = '/home/student/workspace';

export function describeRuntimeInternalStrategy({
  location = DEFAULT_WORKSPACE_LOCATION,
} = {}) {
  return {
    kind: WORKSPACE_STRATEGY_KINDS.RUNTIME_INTERNAL,
    location,
    hostPath: null,
    fallback: true,
    watch: 'find-polling',
    capabilities: {
      fileOpsViaSession: true,
      nativeWatch: false,
      hostBindMount: false,
      hostReadable: false,
    },
  };
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
