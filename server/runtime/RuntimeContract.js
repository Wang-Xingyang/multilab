/**
 * Shared shapes for RuntimeProvider / RuntimeSession.
 *
 * Callers (CommandService, SaveService, WorkspaceService, diagnostics)
 * talk to these shapes — not dockerode. Docker is the first implementation.
 */

export const DEFAULT_CAPTURED_TIMEOUT_MS = 30_000;

export function unimplementedProviderError(providerId, method) {
  const error = new Error(
    `${providerId} runtime provider is a placeholder; ${method} is not implemented yet`
  );
  error.statusCode = 501;
  error.code = 'provider_unimplemented';
  error.provider = providerId;
  return error;
}

export function describeCapabilities({
  implemented = true,
  interactiveTerminal = true,
  capturedCommands = true,
  exec = true,
  previewPorts = false,
  workspaceRetarget = false,
  nativeWatch = false,
} = {}) {
  return {
    implemented: Boolean(implemented),
    interactiveTerminal: Boolean(interactiveTerminal),
    capturedCommands: Boolean(capturedCommands),
    exec: Boolean(exec),
    previewPorts: Boolean(previewPorts),
    workspaceRetarget: Boolean(workspaceRetarget),
    nativeWatch: Boolean(nativeWatch),
  };
}

export function describeProbe({
  ok = false,
  implemented = true,
  ready = false,
  reason = null,
  image = null,
  details = null,
  capabilities = null,
} = {}) {
  return {
    ok: Boolean(ok),
    implemented: Boolean(implemented),
    ready: Boolean(ready),
    reason: reason || null,
    image: image || null,
    details: details || null,
    capabilities: capabilities || describeCapabilities({ implemented }),
  };
}

/** Manifest `timeout_sec` → milliseconds for captured commands. */
export function capturedTimeoutMs(command, fallbackMs = DEFAULT_CAPTURED_TIMEOUT_MS) {
  const sec = Number(command?.timeout_sec);
  if (Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  const fallback = Number(fallbackMs);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : DEFAULT_CAPTURED_TIMEOUT_MS;
}
