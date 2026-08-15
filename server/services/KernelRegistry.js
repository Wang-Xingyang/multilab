export class KernelRegistry {
  constructor({ kernels }) {
    this.kernels = kernels;
  }

  listKernels() {
    return this.kernels.map(kernel => ({ ...kernel }));
  }

  resolveForPackage(pkg, { preferredKernelId = null } = {}) {
    const requirements = pkg.runtime_requirements || {};
    const networkRequired = packageNeedsNetwork(pkg);
    const candidates = this.kernels
      .map(kernel => {
        const match = kernelMatchesRequirements(kernel, requirements);
        const networkOk = networkRequired
          ? kernel.network_default !== 'none'
          : kernel.network_default === 'none';
        const unimplemented = kernel.implemented === false;
        return {
          kernel,
          match,
          networkOk,
          unimplemented,
          recommended: Boolean(pkg.recommended_kernel && kernel.id === pkg.recommended_kernel),
          compatible: match.ok && networkOk && !unimplemented,
        };
      })
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));

    const preferred = preferredKernelId
      ? candidates.find(candidate => candidate.kernel.id === preferredKernelId && candidate.compatible)
      : null;
    const selected = preferred
      || candidates.find(candidate => candidate.recommended && candidate.compatible)
      || candidates.find(candidate => candidate.compatible)
      || null;

    return {
      selected: selected ? selected.kernel : null,
      preferred_kernel_id: preferredKernelId || null,
      preferred_applied: Boolean(preferred),
      network_required: networkRequired,
      candidates: candidates.map(candidate => ({
        ...candidate.kernel,
        recommended: candidate.recommended,
        compatible: candidate.compatible,
        network_ok: candidate.networkOk,
        unimplemented: candidate.unimplemented,
        missing_capabilities: candidate.match.missingCapabilities,
        missing_commands: candidate.match.missingCommands,
        version_mismatches: candidate.match.versionMismatches,
      })),
      requirements,
    };
  }
}

export function packageNeedsNetwork(pkg) {
  const security = pkg?.security || {};
  if (security.network_required === true) return true;
  const previewPorts = security.preview_ports;
  return Array.isArray(previewPorts) && previewPorts.length > 0;
}

export function createDefaultKernelRegistry({ image, workspaceDir }) {
  const base = {
    provider: 'docker',
    image,
    user: 'student',
    workspace: workspaceDir,
    platform: 'linux',
    capabilities: ['tty', 'compile', 'debug', 'signals', 'sandbox'],
    commands: {
      gcc: '13.3.0',
      gdb: '15.0.0',
      bash: '5.2.0',
      make: '4.3.0',
    },
    sandbox_presets: ['standard'],
  };
  return new KernelRegistry({
    kernels: [
      {
        ...base,
        id: 'gcc-ubuntu24-docker',
        display_name: 'GCC Ubuntu 24.04 (Docker)',
        network_default: 'none',
      },
      {
        ...base,
        id: 'gcc-ubuntu24-docker-net',
        display_name: 'GCC Ubuntu 24.04 + preview ports (Docker)',
        network_default: 'bridge',
        // Host binds these container ports to 127.0.0.1 ephemeral ports.
        publish_ports: [8080, 3000, 5173, 8000],
      },
    ],
  });
}

function kernelMatchesRequirements(kernel, requirements) {
  const requiredCapabilities = Array.isArray(requirements.capabilities) ? requirements.capabilities : [];
  const requiredCommands = requirements.commands && typeof requirements.commands === 'object'
    ? Object.keys(requirements.commands)
    : [];

  const missingCapabilities = requiredCapabilities.filter(capability => !(kernel.capabilities || []).includes(capability));
  const missingCommands = requiredCommands.filter(command => !kernel.commands?.[command]);
  const versionMismatches = requiredCommands
    .filter(command => kernel.commands?.[command] && requirements.commands?.[command])
    .map(command => {
      const required = requirements.commands[command];
      const found = kernel.commands[command];
      if (commandVersionSatisfies(found, required)) return null;
      return { command, required, found };
    })
    .filter(Boolean);
  const platformOk = !requirements.platform || requirements.platform === kernel.platform;

  return {
    ok: platformOk
      && missingCapabilities.length === 0
      && missingCommands.length === 0
      && versionMismatches.length === 0,
    missingCapabilities,
    missingCommands,
    versionMismatches,
  };
}

function commandVersionSatisfies(found, required) {
  if (required === true || required === '' || required == null) return true;
  if (found === true) return true;
  if (typeof found !== 'string') return false;
  const constraint = String(required).trim();
  if (!constraint || constraint === '*') return true;
  const match = constraint.match(/^(>=|<=|>|<|=)?\s*([0-9]+(?:\.[0-9]+){0,3})$/);
  if (!match) return true;
  const op = match[1] || '=';
  const cmp = compareVersions(found, match[2]);
  if (op === '>=') return cmp >= 0;
  if (op === '<=') return cmp <= 0;
  if (op === '>') return cmp > 0;
  if (op === '<') return cmp < 0;
  return cmp === 0;
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function versionParts(version) {
  const match = String(version).match(/[0-9]+(?:\.[0-9]+){0,3}/);
  if (!match) return [0];
  return match[0].split('.').map(part => Number(part));
}

